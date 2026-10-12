use crate::config::{
    API_RATE_LIMIT_BURST_SIZE_DEFAULT, API_RATE_LIMIT_CLEANUP_INTERVAL_SECS,
    API_RATE_LIMIT_REPLENISH_INTERVAL_MS_DEFAULT, IDENTITY_SESSION_USER_ID_KEY,
    ROLE_API,
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
use governor::{
    clock::{Clock, DefaultClock},
    middleware::NoOpMiddleware,
};
use sea_orm::{EntityTrait, QuerySelect};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tower_governor::{
    governor::{GovernorConfig, GovernorConfigBuilder},
    key_extractor::KeyExtractor,
    GovernorError,
};
use uuid::Uuid;

#[derive(Clone)]
struct ApiUserKeyExtractor;

impl KeyExtractor for ApiUserKeyExtractor {
    type Key = Uuid;

    fn extract<T>(
        &self,
        req: &http::Request<T>,
    ) -> Result<Uuid, GovernorError> {
        req.extensions()
            .get::<Uuid>()
            .copied()
            .ok_or(GovernorError::UnableToExtractKey)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct ApiRateLimitSettings {
    replenish_interval_ms: u64,
    burst_size: u32,
}

impl ApiRateLimitSettings {
    fn from_settings(settings: Option<&system_settings::Model>) -> Self {
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
        }
    }
}

struct ApiRateLimitState {
    settings: ApiRateLimitSettings,
    config: GovernorConfig<ApiUserKeyExtractor, NoOpMiddleware>,
    last_cleanup: Instant,
}

#[derive(Default)]
pub struct ApiRateLimiter(Mutex<Option<ApiRateLimitState>>);

impl ApiRateLimiter {
    fn check(
        &self,
        login_id: Uuid,
        settings: ApiRateLimitSettings,
    ) -> anyhow::Result<Option<Duration>> {
        let mut state = self
            .0
            .lock()
            .map_err(|error| anyhow::anyhow!(error.to_string()))
            .c(h!())?;
        if state
            .as_ref()
            .is_none_or(|state| state.settings != settings)
        {
            anyhow::ensure!(
                settings.replenish_interval_ms * u64::from(settings.burst_size)
                    <= crate::config::API_RATE_LIMIT_CAPACITY_MS_MAX,
                "{}: API rate limit capacity is too large",
                h!()
            );
            let config = GovernorConfigBuilder::default()
                .per_millisecond(settings.replenish_interval_ms)
                .burst_size(settings.burst_size)
                .key_extractor(ApiUserKeyExtractor)
                .finish()
                .context(h!())?;
            *state = Some(ApiRateLimitState {
                settings,
                config,
                last_cleanup: Instant::now(),
            });
        }
        let state = state.as_mut().context(h!())?;
        let limiter = state.config.limiter();
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
    let roles = login::Entity::find_by_id(login_id)
        .select_only()
        .column(login::Column::Roles)
        .into_tuple::<serde_json::Value>()
        .one(&env.dbx)
        .await
        .c(h!())?;
    if !roles
        .as_ref()
        .and_then(serde_json::Value::as_array)
        .is_some_and(|roles| {
            roles.iter().any(|role| role.as_str() == Some(ROLE_API))
        })
    {
        return Ok(None);
    }
    let settings = crate::system_settings::get_active_system_settings(&env.dbx)
        .await
        .c(h!())?;
    req.app_data::<Data<ApiRateLimiter>>()
        .context(h!())?
        .check(
            login_id,
            ApiRateLimitSettings::from_settings(settings.as_ref()),
        )
        .c(h!())
}

pub async fn throttle_api_users<B: MessageBody>(
    req: ServiceRequest,
    next: Next<B>,
) -> Result<ServiceResponse<EitherBody<B>>, Error> {
    if let Some(wait) = api_user_retry_after(&req)
        .await
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
        cookie::Key, http::StatusCode, test as actix_test, web, App,
        HttpMessage, HttpRequest,
    };
    use sea_orm::ActiveValue::Set;
    use serial_test::serial;

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
            .service(crate::system_settings::create_system_settings);
    }

    fn settings_request() -> serde_json::Value {
        serde_json::json!({
            "rer_analysis_units_exact_match_only_default": true,
            "rer_duty_test_enabled": false,
            "rer_duty_insert_historical_interceptions": false,
            "rer_duty_test_since_ms": 0,
            "rer_duty_test_limit": 1,
            "rer_duty_poll_interval_sec": 5,
            "short_url_enabled": false,
            "api_rate_limit_replenish_interval_ms": 60000,
            "api_rate_limit_burst_size": 2
        })
    }

    #[actix_web::test]
    #[serial]
    async fn issue_3788_api_quotas_are_shared_across_workers_and_exempt_web_users(
    ) {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
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
                .wrap(actix_web::middleware::from_fn(throttle_api_users))
                .wrap(IdentityMiddleware::default())
                .wrap(SessionMiddleware::new(store.clone(), key.clone()))
                .configure(configure_test_routes)
        };
        let first_worker = actix_test::init_service(build_app()).await;
        let second_worker = actix_test::init_service(build_app()).await;
        let mut cookies = Vec::new();
        for login_id in [api_user, other_api_user, admin] {
            let response = actix_test::call_service(
                &first_worker,
                actix_test::TestRequest::post()
                    .uri(&format!("/test-login/{login_id}"))
                    .to_request(),
            )
            .await;
            cookies.push(
                response.response().cookies().next().unwrap().into_owned(),
            );
        }
        let mut settings = settings_request();
        let response = actix_test::call_service(
            &first_worker,
            actix_test::TestRequest::post()
                .uri("/api/admin/system-settings/create")
                .cookie(cookies[2].clone())
                .set_json(&settings)
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let saved: serde_json::Value =
            actix_test::read_body_json(response).await;
        assert_eq!(saved["api_rate_limit_replenish_interval_ms"], 60000);
        assert_eq!(saved["api_rate_limit_burst_size"], 2);
        for worker in [&first_worker, &second_worker] {
            let response = actix_test::call_service(
                worker,
                actix_test::TestRequest::get()
                    .uri("/api/probe")
                    .cookie(cookies[0].clone())
                    .to_request(),
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
        }
        let response = actix_test::call_service(
            &second_worker,
            actix_test::TestRequest::get()
                .uri("/api/other")
                .cookie(cookies[0].clone())
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.headers().get("Retry-After").unwrap(), "60");
        let response = actix_test::call_service(
            &first_worker,
            actix_test::TestRequest::get()
                .uri("/api/probe")
                .cookie(cookies[1].clone())
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        for _ in 0..20 {
            let response = actix_test::call_service(
                &first_worker,
                actix_test::TestRequest::get()
                    .uri("/api/probe")
                    .cookie(cookies[2].clone())
                    .to_request(),
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
        }
        settings["api_rate_limit_burst_size"] = serde_json::json!(3);
        let response = actix_test::call_service(
            &first_worker,
            actix_test::TestRequest::post()
                .uri("/api/admin/system-settings/create")
                .cookie(cookies[2].clone())
                .set_json(&settings)
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let response = actix_test::call_service(
            &second_worker,
            actix_test::TestRequest::get()
                .uri("/api/probe")
                .cookie(cookies[0].clone())
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[test]
    fn issue_3788_concurrent_requests_share_the_burst_and_replenish_one_token()
    {
        let limiter = std::sync::Arc::new(ApiRateLimiter::default());
        let login_id = Uuid::new_v4();
        let settings = ApiRateLimitSettings::from_settings(None);
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
        assert_eq!(admitted, 10);
        std::thread::sleep(Duration::from_millis(550));
        assert!(limiter.check(login_id, settings).unwrap().is_none());
        assert!(limiter.check(login_id, settings).unwrap().is_some());
    }
}
