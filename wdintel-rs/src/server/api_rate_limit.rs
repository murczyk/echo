use crate::config::{
    API_RATE_LIMIT_BURST_SIZE_DEFAULT, API_RATE_LIMIT_CACHE_TTL,
    API_RATE_LIMIT_CLEANUP_INTERVAL_SECS,
    API_RATE_LIMIT_REPLENISH_INTERVAL_MS_DEFAULT,
    API_RATE_LIMIT_ROLE_CACHE_SIZE, IDENTITY_SESSION_USER_ID_KEY, ROLE_API,
};
use crate::entities::{login, system_settings};
use crate::h;
use crate::types::{Env, ShortContext};
use actix_session::SessionExt;
use actix_web::{
    body::{EitherBody, MessageBody},
    dev::{ServiceRequest, ServiceResponse},
    middleware::Next,
    web::Data,
    Error, HttpResponse,
};
use anyhow::Context;
use cached::{Cached, TimedCache, TimedSizedCache};
use governor::{
    clock::{Clock, DefaultClock},
    DefaultKeyedRateLimiter, Quota, RateLimiter,
};
use sea_orm::{
    ColumnTrait, DatabaseConnection, EntityTrait, FromQueryResult, QueryFilter,
    QueryOrder, QuerySelect,
};
use std::{
    num::NonZeroU32,
    sync::Mutex,
    time::{Duration, Instant},
};
use uuid::Uuid;

#[derive(Clone, Copy, PartialEq, Eq)]
struct ApiRateLimitSettings {
    replenish_interval_ms: u64,
    burst_size: u32,
    revision: Option<(chrono::NaiveDateTime, i64)>,
}

#[derive(FromQueryResult)]
struct ApiRateLimitSettingsRow {
    id: i64,
    updated_at: chrono::NaiveDateTime,
    api_rate_limit_replenish_interval_ms: Option<i32>,
    api_rate_limit_burst_size: Option<i32>,
}

impl ApiRateLimitSettings {
    fn from_settings(settings: Option<&ApiRateLimitSettingsRow>) -> Self {
        Self {
            replenish_interval_ms: settings
                .and_then(|settings| {
                    settings.api_rate_limit_replenish_interval_ms
                })
                .map(i64::from)
                .unwrap_or(API_RATE_LIMIT_REPLENISH_INTERVAL_MS_DEFAULT)
                as u64,
            burst_size: settings
                .and_then(|settings| settings.api_rate_limit_burst_size)
                .map(i64::from)
                .unwrap_or(API_RATE_LIMIT_BURST_SIZE_DEFAULT)
                as u32,
            revision: settings
                .map(|settings| (settings.updated_at, settings.id)),
        }
    }
}

async fn load_api_rate_limit_settings(
    dbx: &DatabaseConnection,
) -> anyhow::Result<ApiRateLimitSettings> {
    let settings = system_settings::Entity::find()
        .select_only()
        .columns([
            system_settings::Column::Id,
            system_settings::Column::UpdatedAt,
            system_settings::Column::ApiRateLimitReplenishIntervalMs,
            system_settings::Column::ApiRateLimitBurstSize,
        ])
        .filter(system_settings::Column::Deleted.eq(false))
        .order_by_desc(system_settings::Column::UpdatedAt)
        .into_model::<ApiRateLimitSettingsRow>()
        .one(dbx)
        .await
        .c(h!())?;
    Ok(ApiRateLimitSettings::from_settings(settings.as_ref()))
}

struct ApiRateLimitState {
    settings: ApiRateLimitSettings,
    limiter: DefaultKeyedRateLimiter<Uuid>,
    last_cleanup: Instant,
}

impl ApiRateLimitState {
    fn new(settings: ApiRateLimitSettings) -> anyhow::Result<Self> {
        let capacity_ms = settings
            .replenish_interval_ms
            .checked_mul(u64::from(settings.burst_size))
            .context(h!())?;
        anyhow::ensure!(
            capacity_ms <= crate::config::API_RATE_LIMIT_CAPACITY_MS_MAX,
            "{}: API rate limit capacity is too large",
            h!()
        );
        let quota = Quota::with_period(Duration::from_millis(
            settings.replenish_interval_ms,
        ))
        .context(h!())?
        .allow_burst(NonZeroU32::new(settings.burst_size).context(h!())?);
        Ok(Self {
            settings,
            limiter: RateLimiter::keyed(quota),
            last_cleanup: Instant::now(),
        })
    }
}

pub struct ApiRateLimiter {
    state: Mutex<Option<ApiRateLimitState>>,
    roles: tokio::sync::Mutex<TimedSizedCache<Uuid, bool>>,
    settings: tokio::sync::Mutex<TimedCache<(), ApiRateLimitSettings>>,
}

impl Default for ApiRateLimiter {
    fn default() -> Self {
        Self {
            state: Mutex::new(None),
            roles: tokio::sync::Mutex::new(
                TimedSizedCache::with_size_and_lifespan(
                    API_RATE_LIMIT_ROLE_CACHE_SIZE,
                    API_RATE_LIMIT_CACHE_TTL,
                ),
            ),
            settings: tokio::sync::Mutex::new(TimedCache::with_lifespan(
                API_RATE_LIMIT_CACHE_TTL,
            )),
        }
    }
}

impl ApiRateLimiter {
    async fn is_api_user(
        &self,
        dbx: &DatabaseConnection,
        login_id: Uuid,
    ) -> anyhow::Result<bool> {
        let mut roles_cache = self.roles.lock().await;
        if let Some(is_api_user) = roles_cache.cache_get(&login_id) {
            return Ok(*is_api_user);
        }
        let roles = login::Entity::find_by_id(login_id)
            .select_only()
            .column(login::Column::Roles)
            .into_tuple::<serde_json::Value>()
            .one(dbx)
            .await
            .c(h!())?;
        let is_api_user = roles
            .as_ref()
            .and_then(serde_json::Value::as_array)
            .is_some_and(|roles| {
                roles.iter().any(|role| role.as_str() == Some(ROLE_API))
            });
        roles_cache.cache_set(login_id, is_api_user);
        Ok(is_api_user)
    }

    async fn settings(
        &self,
        dbx: &DatabaseConnection,
    ) -> anyhow::Result<ApiRateLimitSettings> {
        let mut settings_cache = self.settings.lock().await;
        if let Some(settings) = settings_cache.cache_get(&()) {
            return Ok(*settings);
        }
        let settings = load_api_rate_limit_settings(dbx).await.context(h!())?;
        settings_cache.cache_set((), settings);
        Ok(settings)
    }

    async fn retry_after(
        &self,
        dbx: &DatabaseConnection,
        login_id: Uuid,
    ) -> anyhow::Result<Option<Duration>> {
        if !self.is_api_user(dbx, login_id).await.context(h!())? {
            return Ok(None);
        }
        let settings = self.settings(dbx).await.context(h!())?;
        self.check(login_id, settings).context(h!())
    }

    fn check(
        &self,
        login_id: Uuid,
        settings: ApiRateLimitSettings,
    ) -> anyhow::Result<Option<Duration>> {
        let mut state = self
            .state
            .lock()
            .map_err(|error| anyhow::anyhow!(error.to_string()))
            .c(h!())?;
        let settings = match state.as_ref() {
            Some(state) if state.settings.revision > settings.revision => {
                state.settings
            }
            _ => settings,
        };
        if state.as_ref().is_none_or(|state| {
            state.settings.replenish_interval_ms
                != settings.replenish_interval_ms
                || state.settings.burst_size != settings.burst_size
        }) {
            *state = Some(ApiRateLimitState::new(settings).context(h!())?);
        }
        let state = state.as_mut().context(h!())?;
        state.settings = settings;
        let limiter = &state.limiter;
        if state.last_cleanup.elapsed()
            >= Duration::from_secs(API_RATE_LIMIT_CLEANUP_INTERVAL_SECS)
        {
            limiter.retain_recent();
            state.last_cleanup = Instant::now();
        }
        Ok(limiter
            .check_key(&login_id)
            .err()
            .map(|denied| denied.wait_time_from(DefaultClock::default().now())))
    }
}

async fn api_user_retry_after(
    req: &ServiceRequest,
) -> anyhow::Result<Option<Duration>> {
    if !req.path().starts_with("/api/") {
        return Ok(None);
    }
    let Some(identity) = req
        .get_session()
        .get::<String>(IDENTITY_SESSION_USER_ID_KEY)
        .c(h!())?
    else {
        return Ok(None);
    };
    let login_id = Uuid::parse_str(&identity).c(h!())?;
    let env = req.app_data::<Data<Env>>().context(h!())?;
    req.app_data::<Data<ApiRateLimiter>>()
        .context(h!())?
        .retry_after(&env.dbx, login_id)
        .await
        .context(h!())
}

pub async fn throttle_api_users<B: MessageBody>(
    req: ServiceRequest,
    next: Next<B>,
) -> Result<ServiceResponse<EitherBody<B>>, Error> {
    if let Some(wait) = api_user_retry_after(&req)
        .await
        .context(h!())
        .map_err(actix_web::error::ErrorInternalServerError)?
    {
        let retry_after = wait.as_secs() + u64::from(wait.subsec_nanos() > 0);
        let response = HttpResponse::TooManyRequests()
            .insert_header(("Retry-After", retry_after.max(1).to_string()))
            .json(
                serde_json::json!({"error": "API request rate limit exceeded"}),
            );
        return Ok(req.into_response(response).map_into_right_body());
    }
    next.call(req)
        .await
        .map(|response| response.map_into_left_body())
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_identity::{Identity, IdentityMiddleware};
    use actix_session::{storage::RedisSessionStore, SessionMiddleware};
    use actix_web::{
        cookie::{Cookie, Key},
        dev::Service,
        http::StatusCode,
        test as actix_test, web, App, HttpMessage, HttpRequest,
    };
    use sea_orm::{ActiveModelTrait, ActiveValue::Set};
    use serial_test::serial;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    async fn start_session(
        req: HttpRequest,
        login_id: web::Path<Uuid>,
    ) -> HttpResponse {
        Identity::login(&req.extensions(), login_id.to_string()).unwrap();
        HttpResponse::Ok().finish()
    }

    async fn fixture_login_ids(env: &Env) -> [Uuid; 3] {
        let mut login_ids = Vec::new();
        for role in [ROLE_API, ROLE_API, "Admin"] {
            let login = crate::functest::tests::mk_login(
                &env.dbx,
                login::ActiveModel {
                    roles: Set(serde_json::json!([role])),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            login_ids.push(login.id);
        }
        login_ids.try_into().unwrap()
    }

    fn configure_test_routes(routes: &mut web::ServiceConfig) {
        routes
            .route("/test-login/{id}", web::post().to(start_session))
            .route(
                "/api/probe",
                web::get().to(|| async { HttpResponse::Ok().finish() }),
            )
            .route(
                "/api/other",
                web::get().to(|| async { HttpResponse::Ok().finish() }),
            )
            .route(
                "/outside-api",
                web::get().to(|| async { HttpResponse::Ok().finish() }),
            )
            .service(crate::system_settings::create_system_settings);
    }

    fn settings_request() -> serde_json::Value {
        serde_json::json!({
            "rer_analysis_units_exact_match_only_default": true,
            "rer_duty_poll_interval_sec": 5,
            "short_url_enabled": false,
            "api_rate_limit_replenish_interval_ms": 60000,
            "api_rate_limit_burst_size": 2
        })
    }

    fn probe(cookie: &Cookie<'static>, path: &str) -> actix_test::TestRequest {
        actix_test::TestRequest::get()
            .uri(path)
            .cookie(cookie.clone())
    }

    fn save_request(
        cookie: &Cookie<'static>,
        settings: &serde_json::Value,
    ) -> actix_test::TestRequest {
        actix_test::TestRequest::post()
            .uri("/api/admin/system-settings/create")
            .cookie(cookie.clone())
            .set_json(settings)
    }

    async fn assert_status<S, R, B>(
        worker: &S,
        request: R,
        expected: StatusCode,
    ) -> ServiceResponse<B>
    where
        S: Service<R, Response = ServiceResponse<B>, Error = Error>,
    {
        let response = actix_test::call_service(worker, request).await;
        assert_eq!(response.status(), expected);
        response
    }

    async fn session_cookies<S, R, B>(
        worker: &S,
        requests: impl IntoIterator<Item = R>,
    ) -> Vec<Cookie<'static>>
    where
        S: Service<R, Response = ServiceResponse<B>, Error = Error>,
    {
        let mut cookies = Vec::new();
        for request in requests {
            let response = assert_status(worker, request, StatusCode::OK).await;
            cookies.push(
                response.response().cookies().next().unwrap().into_owned(),
            );
        }
        cookies
    }

    #[actix_web::test]
    #[serial]
    async fn issue_3788_api_quotas_are_shared_across_workers_and_exempt_web_users(
    ) {
        let (mut env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let queries = Arc::new(AtomicUsize::new(0));
        let query_count = queries.clone();
        Arc::get_mut(&mut env)
            .unwrap()
            .dbx
            .set_metric_callback(move |_| {
                query_count.fetch_add(1, Ordering::SeqCst);
            });
        let [api_user, other_api_user, admin] = fixture_login_ids(&env).await;
        let store = RedisSessionStore::new(
            crate::redis_conn_string(&env.config).unwrap(),
        )
        .await
        .unwrap();
        let key = Key::generate();
        let limiter = Data::new(ApiRateLimiter::default());
        let build_app = || {
            App::new()
                .app_data(Data::from(env.clone()))
                .app_data(limiter.clone())
                .wrap(actix_web::middleware::from_fn(
                    crate::ai_agent::middleware::enforce_agent_routes,
                ))
                .wrap(actix_web::middleware::from_fn(throttle_api_users))
                .wrap(IdentityMiddleware::default())
                .wrap(SessionMiddleware::new(store.clone(), key.clone()))
                .configure(configure_test_routes)
        };
        let first_worker = actix_test::init_service(build_app()).await;
        let second_worker = actix_test::init_service(build_app()).await;
        let requests =
            [api_user, other_api_user, admin, api_user].map(|login_id| {
                actix_test::TestRequest::post()
                    .uri(&format!("/test-login/{login_id}"))
                    .to_request()
            });
        let cookies = session_cookies(&first_worker, requests).await;
        let mut settings = settings_request();
        let response = assert_status(
            &first_worker,
            save_request(&cookies[2], &settings).to_request(),
            StatusCode::OK,
        )
        .await;
        let saved: serde_json::Value =
            actix_test::read_body_json(response).await;
        assert_eq!(saved["api_rate_limit_replenish_interval_ms"], 60000);
        assert_eq!(saved["api_rate_limit_burst_size"], 2);
        assert_concurrent_attempts_share_cached_database_lookups(
            &env, api_user, admin,
        )
        .await;
        for (worker, cookie) in
            [(&first_worker, &cookies[0]), (&second_worker, &cookies[3])]
        {
            assert_status(
                worker,
                probe(cookie, "/api/probe").to_request(),
                StatusCode::OK,
            )
            .await;
        }
        let queries_before_rejection = queries.load(Ordering::SeqCst);
        let response = assert_status(
            &second_worker,
            probe(&cookies[0], "/api/other").to_request(),
            StatusCode::TOO_MANY_REQUESTS,
        )
        .await;
        assert_eq!(queries.load(Ordering::SeqCst), queries_before_rejection);
        assert_eq!(response.headers().get("Retry-After").unwrap(), "60");
        let body: serde_json::Value =
            actix_test::read_body_json(response).await;
        assert_eq!(body["error"], "API request rate limit exceeded");
        for request in [
            actix_test::TestRequest::get().uri("/api/probe"),
            probe(&cookies[0], "/outside-api"),
        ] {
            assert_status(&first_worker, request.to_request(), StatusCode::OK)
                .await;
        }
        assert_status(
            &first_worker,
            probe(&cookies[1], "/api/probe").to_request(),
            StatusCode::OK,
        )
        .await;
        for _ in 0..20 {
            assert_status(
                &first_worker,
                probe(&cookies[2], "/api/probe").to_request(),
                StatusCode::OK,
            )
            .await;
        }
        settings["api_rate_limit_burst_size"] = serde_json::json!(3);
        assert_status(
            &first_worker,
            save_request(&cookies[2], &settings).to_request(),
            StatusCode::OK,
        )
        .await;
        tokio::time::sleep(API_RATE_LIMIT_CACHE_TTL + Duration::from_millis(1))
            .await;
        assert_status(
            &second_worker,
            probe(&cookies[0], "/api/probe").to_request(),
            StatusCode::OK,
        )
        .await;
        for roles in [serde_json::json!([]), serde_json::json!([ROLE_API])] {
            let exempt = roles.as_array().unwrap().is_empty();
            login::ActiveModel {
                id: Set(api_user),
                roles: Set(roles),
                ..Default::default()
            }
            .update(&env.dbx)
            .await
            .unwrap();
            tokio::time::sleep(
                API_RATE_LIMIT_CACHE_TTL + Duration::from_millis(1),
            )
            .await;
            for index in 0..5 {
                let expected = if exempt || index < 2 {
                    StatusCode::OK
                } else {
                    StatusCode::TOO_MANY_REQUESTS
                };
                assert_status(
                    &first_worker,
                    probe(&cookies[0], "/api/probe").to_request(),
                    expected,
                )
                .await;
            }
        }
    }

    async fn assert_concurrent_attempts_share_cached_database_lookups(
        env: &Env,
        api_user: Uuid,
        admin: Uuid,
    ) {
        let mut dbx = env.dbx.clone();
        let queries = Arc::new(AtomicUsize::new(0));
        let query_count = queries.clone();
        dbx.set_metric_callback(move |_| {
            query_count.fetch_add(1, Ordering::SeqCst);
        });
        let limiter = ApiRateLimiter::default();
        for expected_queries in [2, 4] {
            let attempts = futures::future::join_all(
                (0..100).map(|_| limiter.retry_after(&dbx, api_user)),
            )
            .await;
            let admitted = attempts
                .into_iter()
                .filter(|retry_after| retry_after.as_ref().unwrap().is_none())
                .count();
            assert_eq!(admitted, if expected_queries == 2 { 2 } else { 0 });
            assert_eq!(queries.load(Ordering::SeqCst), expected_queries);
            let disconnected = DatabaseConnection::default();
            let rejected = futures::future::join_all(
                (0..100).map(|_| limiter.retry_after(&disconnected, api_user)),
            )
            .await;
            assert!(rejected
                .into_iter()
                .all(|retry_after| retry_after.unwrap().is_some()));
            if expected_queries == 2 {
                tokio::time::sleep(
                    API_RATE_LIMIT_CACHE_TTL + Duration::from_millis(1),
                )
                .await;
            }
        }
        assert!(limiter.retry_after(&dbx, admin).await.unwrap().is_none());
        assert!(limiter
            .retry_after(&DatabaseConnection::default(), admin)
            .await
            .unwrap()
            .is_none());
    }

    #[test]
    fn issue_3788_concurrent_requests_share_the_burst() {
        let limiter = std::sync::Arc::new(ApiRateLimiter::default());
        let login_id = Uuid::new_v4();
        let settings = ApiRateLimitSettings {
            replenish_interval_ms: 60000,
            ..ApiRateLimitSettings::from_settings(None)
        };
        let admitted = std::thread::scope(|scope| {
            let requests: Vec<_> = (0..30)
                .map(|_| {
                    let limiter = limiter.clone();
                    scope.spawn(move || {
                        limiter.check(login_id, settings).unwrap().is_none()
                    })
                })
                .collect();
            requests
                .into_iter()
                .map(|request| request.join().unwrap())
                .filter(|admitted| *admitted)
                .count()
        });
        assert_eq!(admitted, 5);
        assert!(limiter.check(login_id, settings).unwrap().is_some());
    }

    #[test]
    fn issue_3788_stale_settings_do_not_reset_bursts_after_reconciliation() {
        let limiter = ApiRateLimiter::default();
        let login_id = Uuid::new_v4();
        let timestamp = chrono::Utc::now().naive_utc();
        let older = ApiRateLimitSettings {
            replenish_interval_ms: 60000,
            burst_size: 1,
            revision: Some((timestamp, 1)),
        };
        let newer = ApiRateLimitSettings {
            burst_size: 2,
            revision: Some((timestamp, 2)),
            ..older
        };
        let latest = ApiRateLimitSettings {
            revision: Some((timestamp, 3)),
            ..newer
        };
        assert!(limiter.check(login_id, older).unwrap().is_none());
        assert!(limiter.check(login_id, newer).unwrap().is_none());
        assert!(limiter.check(login_id, newer).unwrap().is_none());
        assert!(limiter.check(login_id, latest).unwrap().is_some());
        assert!(limiter.check(login_id, older).unwrap().is_some());
        assert!(limiter
            .check(
                login_id,
                ApiRateLimitSettings {
                    burst_size: 3,
                    ..newer
                }
            )
            .unwrap()
            .is_some());
        assert!(limiter.check(login_id, latest).unwrap().is_some());
    }
}
