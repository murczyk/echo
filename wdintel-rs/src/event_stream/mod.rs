use self::types::*;
use crate::config::*;
use crate::types::*;
use crate::users::{ensure_basic_role, login_id_from_identity};
use actix_web::post;
use actix_web::web::Json;
use actix_web::HttpRequest;
use actix_web::{
    body::{EitherBody, MessageBody},
    dev::{ServiceRequest, ServiceResponse},
    middleware::Next,
    web, Error, HttpMessage, HttpResponse,
};
use chrono::prelude::*;
use redis::aio::{ConnectionManager, MultiplexedConnection};
use redis::streams::{
    StreamId, StreamKey, StreamMaxlen, StreamReadOptions, StreamReadReply,
};
use redis::AsyncCommands;

pub mod types;

#[derive(Default)]
pub struct DeploymentMaintenanceState {
    snapshot: std::sync::RwLock<Option<DeploymentMaintenanceSnapshot>>,
}

struct DeploymentMaintenanceSnapshot {
    id: String,
    expires_at: std::time::Instant,
}

impl DeploymentMaintenanceState {
    fn current(&self) -> Option<DeploymentMaintenance> {
        let snapshot = self.snapshot.read().expect("deployment state lock");
        let snapshot = snapshot.as_ref()?;
        let remaining = snapshot
            .expires_at
            .checked_duration_since(std::time::Instant::now())?;
        Some(DeploymentMaintenance {
            id: snapshot.id.clone(),
            remaining_ms: remaining.as_millis() as i64,
        })
    }

    pub async fn refresh(
        &self,
        redis: &mut ConnectionManager,
    ) -> anyhow::Result<()> {
        let requested_at = std::time::Instant::now();
        let maintenance = get_deployment_maintenance(redis).await.c(h!())?;
        *self.snapshot.write().expect("deployment state lock") = maintenance
            .map(|maintenance| DeploymentMaintenanceSnapshot {
                id: maintenance.id,
                expires_at: requested_at
                    + std::time::Duration::from_millis(
                        maintenance.remaining_ms as u64,
                    ),
            });
        Ok(())
    }
}

pub async fn deployment_maintenance_worker(
    mut redis: ConnectionManager,
    state: web::Data<DeploymentMaintenanceState>,
    cancel_token: tokio_util::sync::CancellationToken,
) {
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(
        DEPLOYMENT_MAINTENANCE_POLL_INTERVAL_MS,
    ));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = cancel_token.cancelled() => break,
            _ = interval.tick() => {
                if let Err(error) = state.refresh(&mut redis).await {
                    warn!("failed to refresh deployment state: {error:#?}");
                }
            }
        }
    }
}

pub async fn deployment_only_poll<B: MessageBody>(
    mut req: ServiceRequest,
    next: Next<B>,
) -> Result<ServiceResponse<EitherBody<B>>, Error> {
    if req.method() != actix_web::http::Method::POST
        || req.path() != "/api/event-stream/long-poll"
    {
        return next
            .call(req)
            .await
            .map(|response| response.map_into_left_body())
            .map_err(|error| middleware_error_context(error, h!()));
    }
    let poll = req
        .extract::<Json<LongPollReq>>()
        .await
        .map_err(|error| middleware_error_context(error, h!()))?
        .into_inner();
    if poll.flavor != LongPollFlavor::LpfGeneric {
        req.extensions_mut().insert(poll);
        return next
            .call(req)
            .await
            .map(|response| response.map_into_left_body())
            .map_err(|error| middleware_error_context(error, h!()));
    }
    let state = req
        .app_data::<web::Data<DeploymentMaintenanceState>>()
        .c(h!())
        .map_err(actix_web::error::ErrorInternalServerError)?;
    let response = LongPollRsp {
        events: vec![],
        last_event_id: poll.last_event_id,
        deployment_maintenance: state.current(),
        unit_catalog_revision: None,
    };
    Ok(req
        .into_response(HttpResponse::Ok().json(response))
        .map_into_right_body())
}

fn middleware_error_context(error: Error, location: &'static str) -> Error {
    let response = error.error_response();
    let error = anyhow::anyhow!(error.to_string()).context(location);
    actix_web::error::InternalError::from_response(
        format!("{error:#}"),
        response,
    )
    .into()
}

pub fn session_stream_id(session_id: Uuid) -> String {
    format!("echo-stream:{session_id}")
}

pub fn get_sess_key(session_id: Uuid) -> String {
    format!("echo-sess-{session_id}")
}

pub fn get_session_id(
    session: &actix_session::Session,
) -> anyhow::Result<Option<Uuid>> {
    let m_session_id: Option<String> = session.get("id").c(h!())?;
    match m_session_id {
        Some(session_id) => {
            let session_id = Uuid::parse_str(&session_id).c(h!())?;
            Ok(Some(session_id))
        }
        None => Ok(None),
    }
}

pub fn origin_from_request(req: &HttpRequest) -> Option<String> {
    let origin = req
        .headers()
        .get(EVENT_STREAM_ORIGIN_HEADER)?
        .to_str()
        .ok()?;
    if origin.trim().is_empty() || origin.len() > EVENT_STREAM_ORIGIN_MAX_BYTES
    {
        return None;
    }
    Some(origin.to_string())
}

#[post("/api/event-stream/long-poll")]
async fn long_poll(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    session: actix_session::Session,
    req: web::ReqData<LongPollReq>,
) -> Result<Json<LongPollRsp>, AppError> {
    ensure_basic_role(&env.dbx, &user).await.c(h!())?;
    let user_id = login_id_from_identity(&user).c(h!())?;
    let account_id = user_id;
    let Some(session_id) = get_session_id(&session).c(h!())? else {
        tokio::time::sleep(tokio::time::Duration::from_millis(
            LONG_POLL_SLEEP_MS,
        ))
        .await;

        return Ok(Json(LongPollRsp {
            events: vec![],
            last_event_id: None,
            deployment_maintenance: None,
            unit_catalog_revision: None,
        }));
    };

    let session =
        crate::session::get_session_by_id(&mut env.redis.clone(), session_id)
            .await
            .c(h!())?;
    match session {
        None => {
            crate::session::add_session(
                &mut env.redis.clone(),
                session_id,
                &account_id,
            )
            .await
            .c(h!())?;

            create_redis_stream(&mut env.redis.clone(), session_id)
                .await
                .c(h!())?;
        }
        Some(session) => {
            crate::session::update_heartbeat(
                &mut env.redis.clone(),
                session,
                &account_id,
            )
            .await
            .c(h!())?;

            update_redis_stream(&mut env.redis.clone(), session_id)
                .await
                .c(h!())?;
        }
    };

    let req: LongPollReq = req.into_inner();
    let deployment_maintenance =
        get_deployment_maintenance(&mut env.redis.clone())
            .await
            .c(h!())?;
    if req.flavor == LongPollFlavor::LpfGenericFull
        || deployment_maintenance_changed(&req, deployment_maintenance.as_ref())
    {
        return Ok(Json(LongPollRsp {
            events: vec![],
            last_event_id: req.last_event_id,
            deployment_maintenance,
            unit_catalog_revision: Some(
                crate::sigint::unit::hierarchy::catalog_revision(
                    &mut env.redis.clone(),
                )
                .await
                .c(h!())?,
            ),
        }));
    }
    let redis_con_config =
        redis::AsyncConnectionConfig::new().set_response_timeout(None);
    let mut redis_con = env
        .redisb
        .get_multiplexed_async_connection_with_config(&redis_con_config)
        .await
        .c(h!())?;
    let (events, last_event_id) = read_stream_events(
        &mut redis_con,
        &session_stream_id(session_id),
        &req,
    )
    .await
    .c(h!())?;
    let deployment_maintenance =
        get_deployment_maintenance(&mut env.redis.clone())
            .await
            .c(h!())?;
    Ok(Json(LongPollRsp {
        events,
        last_event_id,
        deployment_maintenance,
        unit_catalog_revision: Some(
            crate::sigint::unit::hierarchy::catalog_revision(
                &mut env.redis.clone(),
            )
            .await
            .c(h!())?,
        ),
    }))
}

async fn read_stream_events(
    redis: &mut MultiplexedConnection,
    stream_key: &str,
    req: &LongPollReq,
) -> anyhow::Result<(Vec<EventMsg>, Option<String>)> {
    let started = std::time::Instant::now();
    let mut last_stream_id =
        req.last_event_id.clone().unwrap_or_else(|| "$".to_string());
    let mut events = vec![];
    loop {
        let response_time_ms = if events.is_empty() {
            LONG_POLL_READ_STREAM_BLOCK_MS as u64
        } else {
            LONG_POLL_MIN_RESPONSE_TIME_MS
        };
        let elapsed_ms = started.elapsed().as_millis() as u64;
        if elapsed_ms >= response_time_ms {
            break;
        }
        let reply: Option<StreamReadReply> = redis
            .xread_options(
                &[stream_key],
                &[&last_stream_id],
                &StreamReadOptions::default()
                    .count(LONG_POLL_READ_STREAM_ELEMENTS_MAX)
                    .block((response_time_ms - elapsed_ms) as usize),
            )
            .await
            .c(h!())?;
        append_stream_events(
            reply,
            stream_key,
            &req.flavor,
            &mut last_stream_id,
            &mut events,
        )
        .c(h!())?;
    }
    let last_event_id = (last_stream_id != "$").then_some(last_stream_id);
    Ok((events, last_event_id))
}

fn append_stream_events(
    reply: Option<StreamReadReply>,
    stream_key: &str,
    flavor: &LongPollFlavor,
    last_stream_id: &mut String,
    events: &mut Vec<EventMsg>,
) -> anyhow::Result<()> {
    let Some(reply) = reply else {
        return Ok(());
    };
    for StreamKey { key, ids } in reply.keys {
        if key != stream_key {
            continue;
        }
        for StreamId { id, map, .. } in ids {
            *last_stream_id = id.clone();
            if let Some(redis::Value::BulkString(bytes)) = map.get("v") {
                let mut event: EventMsg =
                    serde_json::from_slice(bytes).c(h!())?;
                let relevant = match event.event_type {
                    EventType::ETGeneric | EventType::ETUnitChanged => true,
                    EventType::ETInboxChanged(_) => matches!(
                        flavor,
                        LongPollFlavor::LpfRer | LongPollFlavor::LpfAnalysisNeo
                    ),
                    _ => false,
                };
                if relevant {
                    event.id = id;
                    events.push(event);
                }
            }
        }
    }
    Ok(())
}

async fn get_deployment_maintenance(
    redis: &mut ConnectionManager,
) -> anyhow::Result<Option<DeploymentMaintenance>> {
    let (id, remaining_ms): (Option<String>, i64) = redis::pipe()
        .atomic()
        .get(DEPLOYMENT_MAINTENANCE_REDIS_KEY)
        .pttl(DEPLOYMENT_MAINTENANCE_REDIS_KEY)
        .query_async(redis)
        .await
        .c(h!())?;
    let Some(id) = id else {
        return Ok(None);
    };
    if remaining_ms <= 0 {
        return Ok(None);
    }
    Ok(Some(DeploymentMaintenance { id, remaining_ms }))
}

fn deployment_maintenance_changed(
    req: &LongPollReq,
    deployment_maintenance: Option<&DeploymentMaintenance>,
) -> bool {
    req.deployment_maintenance_protocol
        == Some(DEPLOYMENT_MAINTENANCE_PROTOCOL_VERSION)
        && req.known_deployment_maintenance_id.as_deref()
            != deployment_maintenance.map(|maintenance| maintenance.id.as_str())
}

pub fn pipe_xadd(pipe: &mut redis::Pipeline, session_id: Uuid, val: Vec<u8>) {
    pipe.xadd_maxlen(
        crate::event_stream::session_stream_id(session_id),
        StreamMaxlen::Approx(REDIS_MAXLEN),
        "*",
        &[("v", val.clone())],
    );
}

pub async fn fanout(
    redis: &mut redis::aio::ConnectionManager,
    event: EventMsg,
) -> Result<(), AppError> {
    // println!("> piped_fanout: event = {event:?}");
    if event.event_type == EventType::ETUnitChanged {
        crate::sigint::unit::hierarchy::mark_dirty(redis)
            .await
            .c(h!())?;
    }
    let sessions = crate::session::get_all_sessions(redis).await.c(h!())?;
    if sessions.is_empty() {
        return Ok(());
    }
    let mut pipe = redis::pipe();
    for session in sessions {
        let event = event.clone();
        let _res: () = pipe_xadd(
            &mut pipe,
            session.session_id,
            serde_json::to_string(&event).c(h!())?.as_bytes().to_vec(),
        );
    }
    let _res: () = pipe.query_async(redis).await.c(h!())?;
    Ok(())
}

pub async fn fanout_mult(
    redis: &mut redis::aio::ConnectionManager,
    events: Vec<EventMsg>,
) -> Result<(), AppError> {
    for event in events {
        fanout(redis, event).await.c(h!())?;
    }
    Ok(())
}

pub async fn create_redis_stream(
    redis: &mut ConnectionManager,
    session_id: sqlx::types::Uuid,
) -> Result<(), AppError> {
    // create empty redis stream with ttl
    let val = EventMsg {
        id: "".to_string(),
        event_type: EventType::ETGeneric,
        created_at: Utc::now().timestamp(),
        origin: None,
        intelligence_report: false,
    };
    let val = serde_json::to_string(&val).c(h!())?.as_bytes().to_vec();
    redis
        .del::<String, redis::Value>(crate::event_stream::session_stream_id(
            session_id,
        ))
        .await
        .c(h!())?;
    let xadd_reply = redis
        .xadd::<String, &str, &str, Vec<u8>, String>(
            crate::event_stream::session_stream_id(session_id),
            "*",
            &[("v", val.clone())],
        )
        .await
        .c(h!())?;
    redis
        .expire::<String, redis::Value>(
            crate::event_stream::session_stream_id(session_id),
            crate::config::SESSION_STREAM_LIFETIME_SEC,
        )
        .await
        .c(h!())?;
    redis
        .xdel::<String, &str, redis::Value>(
            crate::event_stream::session_stream_id(session_id),
            &[&xadd_reply],
        )
        .await
        .c(h!())?;
    Ok(())
}

async fn update_redis_stream(
    redis: &mut ConnectionManager,
    session_id: sqlx::types::Uuid,
) -> Result<(), AppError> {
    // update redis stream ttl
    redis
        .expire::<String, redis::Value>(
            crate::event_stream::session_stream_id(session_id),
            crate::config::SESSION_STREAM_LIFETIME_SEC,
        )
        .await
        .c(h!())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_valid_event_origin_header() {
        let req = actix_web::test::TestRequest::default()
            .insert_header((EVENT_STREAM_ORIGIN_HEADER, " local-mutation "))
            .to_http_request();

        assert_eq!(
            origin_from_request(&req),
            Some(" local-mutation ".to_string())
        );
    }

    #[test]
    fn ignores_invalid_event_origin_headers() {
        let too_long = "x".repeat(EVENT_STREAM_ORIGIN_MAX_BYTES + 1);
        let req = actix_web::test::TestRequest::default()
            .insert_header((EVENT_STREAM_ORIGIN_HEADER, too_long))
            .to_http_request();

        assert_eq!(origin_from_request(&req), None);
    }

    #[test]
    fn deserializes_events_created_before_origin_was_added() {
        let event: EventMsg = serde_json::from_value(serde_json::json!({
            "id": "event-id",
            "event_type": { "ETInboxChanged": 7 },
            "created_at": 1
        }))
        .expect("legacy event should deserialize");

        assert_eq!(event.origin, None);
        assert!(!event.intelligence_report);
        assert_eq!(event.event_type, EventType::ETInboxChanged(7));
    }

    #[test]
    fn regression_3571_unit_changes_reach_catalog_consumers() {
        let event = EventMsg::new(EventType::ETUnitChanged);
        let reply = StreamReadReply {
            keys: vec![StreamKey {
                key: "session".to_string(),
                ids: vec![StreamId {
                    id: "1-0".to_string(),
                    map: std::collections::HashMap::from([(
                        "v".to_string(),
                        redis::Value::BulkString(
                            serde_json::to_vec(&event).unwrap(),
                        ),
                    )]),
                    ..Default::default()
                }],
            }],
        };
        let mut cursor = "0-0".to_string();
        let mut events = Vec::new();
        append_stream_events(
            Some(reply),
            "session",
            &LongPollFlavor::LpfAnalysisNeo,
            &mut cursor,
            &mut events,
        )
        .unwrap();
        assert_eq!(cursor, "1-0");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, EventType::ETUnitChanged);
    }

    #[test]
    fn deserializes_long_poll_requests_without_maintenance_protocol() {
        let req: LongPollReq = serde_json::from_value(serde_json::json!({
            "flavor": "generic",
            "session_id": "current",
            "last_event_id": null
        }))
        .expect("legacy long-poll request should deserialize");

        assert_eq!(req.deployment_maintenance_protocol, None);
        assert_eq!(req.known_deployment_maintenance_id, None);
    }

    #[actix_web::test]
    async fn issue_3866_only_generic_bypasses_auth_and_activity() {
        use actix_web::dev::Service;
        use actix_web::{test, App};
        use std::sync::atomic::{AtomicUsize, Ordering};

        let state = web::Data::new(DeploymentMaintenanceState::default());
        *state.snapshot.write().unwrap() =
            Some(DeploymentMaintenanceSnapshot {
                id: "deploy-3866".to_string(),
                expires_at: std::time::Instant::now()
                    + std::time::Duration::from_secs(120),
            });
        let calls = Arc::new(AtomicUsize::new(0));
        let inner_calls = calls.clone();
        let app = test::init_service(
            App::new()
                .app_data(state.clone())
                .wrap_fn(move |req, next| {
                    inner_calls.fetch_add(1, Ordering::SeqCst);
                    next.call(req)
                })
                .wrap(actix_web::middleware::from_fn(deployment_only_poll))
                .route(
                    "/api/event-stream/long-poll",
                    web::post().to(
                        |req: web::ReqData<LongPollReq>| async move {
                            HttpResponse::Unauthorized().json(&req.flavor)
                        },
                    ),
                ),
        )
        .await;
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/event-stream/long-poll")
                .set_json(serde_json::json!({
                    "flavor": "generic",
                    "session_id": "current",
                    "last_event_id": "123-0"
                }))
                .to_request(),
        )
        .await;
        assert_eq!(response.status(), actix_web::http::StatusCode::OK);
        assert!(!response.headers().contains_key("set-cookie"));
        let response: LongPollRsp = test::read_body_json(response).await;
        assert!(response.events.is_empty());
        assert_eq!(response.last_event_id.as_deref(), Some("123-0"));
        assert_eq!(response.deployment_maintenance.unwrap().id, "deploy-3866");
        assert_eq!(calls.load(Ordering::SeqCst), 0);

        for flavor in ["rer", "analysis-neo", "generic-full"] {
            let response = test::call_service(
                &app,
                test::TestRequest::post()
                    .uri("/api/event-stream/long-poll")
                    .set_json(serde_json::json!({
                        "flavor": flavor,
                        "session_id": "current",
                        "last_event_id": null
                    }))
                    .to_request(),
            )
            .await;
            assert_eq!(
                response.status(),
                actix_web::http::StatusCode::UNAUTHORIZED
            );
            let received: String = test::read_body_json(response).await;
            assert_eq!(received, flavor);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 3);

        state.snapshot.write().unwrap().as_mut().unwrap().expires_at =
            std::time::Instant::now() - std::time::Duration::from_millis(1);
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/event-stream/long-poll")
                .set_json(serde_json::json!({
                    "flavor": "generic",
                    "session_id": "current",
                    "last_event_id": null
                }))
                .to_request(),
        )
        .await;
        let response: LongPollRsp = test::read_body_json(response).await;
        assert!(response.deployment_maintenance.is_none());
    }

    #[actix_web::test]
    async fn issue_3866_forwarding_preserves_context_and_compressed_requests() {
        use actix_web::dev::Service;
        use actix_web::{test, App};

        let app = test::init_service(
            App::new()
                .wrap_fn(|req, next| {
                    let error = if req.path() == "/forwarding-error" {
                        Some(actix_web::error::ErrorForbidden("forbidden"))
                    } else if req
                        .extensions()
                        .get::<LongPollReq>()
                        .is_some_and(|poll| poll.session_id == "expired")
                    {
                        Some(actix_web::error::ErrorUnauthorized(
                            "expired session",
                        ))
                    } else {
                        None
                    };
                    match error {
                        Some(error) => futures::future::Either::Left(
                            std::future::ready(Err(error)),
                        ),
                        None => futures::future::Either::Right(next.call(req)),
                    }
                })
                .wrap(actix_web::middleware::from_fn(deployment_only_poll))
                .route(
                    "/api/event-stream/long-poll",
                    web::post().to(
                        |req: web::ReqData<LongPollReq>| async move {
                            HttpResponse::Unauthorized().json(&req.flavor)
                        },
                    ),
                ),
        )
        .await;

        use std::io::Write;
        let mut compressed = flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::default(),
        );
        compressed
            .write_all(
                br#"{"flavor":"generic-full","session_id":"current","last_event_id":null}"#,
            )
            .unwrap();
        let response = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/api/event-stream/long-poll")
                .insert_header(("content-type", "application/json"))
                .insert_header(("content-encoding", "gzip"))
                .set_payload(compressed.finish().unwrap())
                .to_request(),
        )
        .await;
        assert_eq!(
            response.status(),
            actix_web::http::StatusCode::UNAUTHORIZED
        );
        let received: String = test::read_body_json(response).await;
        assert_eq!(received, "generic-full");

        let malformed = test::TestRequest::post()
            .uri("/api/event-stream/long-poll")
            .insert_header(("content-type", "application/json"))
            .set_payload("{")
            .to_request();
        let unauthenticated = test::TestRequest::post()
            .uri("/api/event-stream/long-poll")
            .set_json(serde_json::json!({
                "flavor": "generic-full",
                "session_id": "expired",
                "last_event_id": null
            }))
            .to_request();
        let forbidden = test::TestRequest::get()
            .uri("/forwarding-error")
            .to_request();
        let unsupported = test::TestRequest::post()
            .uri("/api/event-stream/long-poll")
            .set_json(serde_json::json!({
                "flavor": "unknown",
                "session_id": "current",
                "last_event_id": null
            }))
            .to_request();
        let missing_flavor = test::TestRequest::post()
            .uri("/api/event-stream/long-poll")
            .set_json(serde_json::json!({
                "session_id": "current",
                "last_event_id": null
            }))
            .to_request();
        let missing_state = test::TestRequest::post()
            .uri("/api/event-stream/long-poll")
            .set_json(serde_json::json!({
                "flavor": "generic",
                "session_id": "current",
                "last_event_id": null
            }))
            .to_request();
        for (request, status) in [
            (malformed, actix_web::http::StatusCode::BAD_REQUEST),
            (unsupported, actix_web::http::StatusCode::BAD_REQUEST),
            (missing_flavor, actix_web::http::StatusCode::BAD_REQUEST),
            (unauthenticated, actix_web::http::StatusCode::UNAUTHORIZED),
            (forbidden, actix_web::http::StatusCode::FORBIDDEN),
            (
                missing_state,
                actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
            ),
        ] {
            let error =
                test::try_call_service(&app, request).await.unwrap_err();
            assert_eq!(error.as_response_error().status_code(), status);
            assert!(format!("{error:?}").contains("event_stream/mod.rs"));
            if status == actix_web::http::StatusCode::UNAUTHORIZED {
                assert!(error.to_string().contains("expired session"));
            }
        }
    }

    #[actix_web::test]
    async fn issue_3866_only_relevant_events_complete_a_poll() {
        let config = crate::config::read_config(Mode::Test).unwrap();
        let client = crate::new_redisb(&config).await.unwrap();
        let options =
            redis::AsyncConnectionConfig::new().set_response_timeout(None);
        let mut producer = client
            .get_multiplexed_async_connection_with_config(&options)
            .await
            .unwrap();
        let stream = format!("echo-test-stream:{}", Uuid::now_v7());
        let event = EventMsg::new(EventType::ETNetworkChanged);
        let _: String = producer
            .xadd(
                &stream,
                "*",
                &[("v", serde_json::to_string(&event).unwrap())],
            )
            .await
            .unwrap();
        let _: bool = producer.expire(&stream, 15).await.unwrap();

        let mut connections = vec![];
        let mut requests = vec![];
        for flavor in [LongPollFlavor::LpfRer, LongPollFlavor::LpfAnalysisNeo] {
            connections.push(
                client
                    .get_multiplexed_async_connection_with_config(&options)
                    .await
                    .unwrap(),
            );
            requests.push(LongPollReq {
                flavor,
                session_id: "current".to_string(),
                last_event_id: Some("0-0".to_string()),
                deployment_maintenance_protocol: None,
                known_deployment_maintenance_id: None,
            });
        }
        let mut polls: Vec<_> = connections
            .iter_mut()
            .zip(&requests)
            .map(|(redis, req)| {
                Box::pin(read_stream_events(redis, &stream, req))
            })
            .collect();
        let wait = std::time::Duration::from_millis(2100);
        for result in futures::future::join_all(
            polls
                .iter_mut()
                .map(|poll| tokio::time::timeout(wait, poll)),
        )
        .await
        {
            assert!(result.is_err(), "catalog events must not complete a poll");
        }

        let event = EventMsg::new(EventType::ETInboxChanged(7))
            .with_origin(Some("other-tab".to_string()))
            .with_intelligence_report();
        let inbox_id: String = producer
            .xadd(
                &stream,
                "*",
                &[("v", serde_json::to_string(&event).unwrap())],
            )
            .await
            .unwrap();
        for poll in &mut polls {
            let (events, cursor) =
                tokio::time::timeout(std::time::Duration::from_secs(1), poll)
                    .await
                    .unwrap()
                    .unwrap();
            assert_eq!(cursor.as_ref(), Some(&inbox_id));
            assert_eq!(events.len(), 1);
            assert_eq!(events[0].event_type, EventType::ETInboxChanged(7));
            assert_eq!(events[0].origin, event.origin);
            assert!(events[0].intelligence_report);
        }
        let _: usize = producer.del(&stream).await.unwrap();
    }

    #[test]
    fn returns_maintenance_changes_immediately_only_for_supported_clients() {
        let maintenance = DeploymentMaintenance {
            id: "deploy-1".to_string(),
            remaining_ms: 120_000,
        };
        let mut req = LongPollReq {
            flavor: LongPollFlavor::LpfGeneric,
            session_id: "current".to_string(),
            last_event_id: None,
            deployment_maintenance_protocol: None,
            known_deployment_maintenance_id: None,
        };

        assert!(!deployment_maintenance_changed(&req, Some(&maintenance)));
        req.deployment_maintenance_protocol =
            Some(DEPLOYMENT_MAINTENANCE_PROTOCOL_VERSION);
        assert!(deployment_maintenance_changed(&req, Some(&maintenance)));
        req.known_deployment_maintenance_id = Some(maintenance.id.clone());
        assert!(!deployment_maintenance_changed(&req, Some(&maintenance)));
        assert!(deployment_maintenance_changed(&req, None));
    }
}
