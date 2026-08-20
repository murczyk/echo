use self::types::*;
use crate::config::*;
use crate::types::*;
use crate::users::{ensure_basic_role, login_id_from_identity};
use actix_web::post;
use actix_web::web::Json;
use actix_web::HttpRequest;
use chrono::prelude::*;
use redis::aio::ConnectionManager;
use redis::streams::{
    StreamId, StreamKey, StreamMaxlen, StreamReadOptions, StreamReadReply,
};
use redis::AsyncCommands;

pub mod types;

/// Sets the maximum number of elements to return per stream
const REDIS_READ_STREAM_ELEMENTS_MAX: usize = 1000;
/// Sets the block time in milliseconds
const REDIS_READ_STREAM_BLOCK_MS: usize = 50000;

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
    req: Json<LongPollReq>,
) -> Result<Json<LongPollRsp>, AppError> {
    ensure_basic_role(&env.dbx, &user).await.c(h!())?;
    let user_id = login_id_from_identity(&user)?;
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
    if deployment_maintenance_changed(&req, deployment_maintenance.as_ref()) {
        return Ok(Json(LongPollRsp {
            events: vec![],
            last_event_id: req.last_event_id,
            deployment_maintenance,
        }));
    }
    let m_last_event_id = req.last_event_id;
    let srr_key = session_stream_id(session_id);
    let mut last_stream_id = "$".to_string();
    if let Some(last_event_id) = m_last_event_id {
        last_stream_id = last_event_id.to_string();
    };
    let redis_con_config =
        redis::AsyncConnectionConfig::new().set_response_timeout(None);
    let mut redis_con = env
        .redisb
        .get_multiplexed_async_connection_with_config(&redis_con_config)
        .await
        .c(h!())?;
    // Start a window to accumulate events for a minimum time
    let start_time = std::time::Instant::now();
    let mut res = vec![];

    // First read: keep existing long block to capture new events if none exist
    {
        let srr: Option<StreamReadReply> = redis_con
            .xread_options(
                std::slice::from_ref(&srr_key),
                &[last_stream_id.clone()],
                &StreamReadOptions::default()
                    .count(REDIS_READ_STREAM_ELEMENTS_MAX)
                    .block(REDIS_READ_STREAM_BLOCK_MS),
            )
            .await
            .c(h!())?;

        if let Some(srr) = srr {
            for StreamKey { key, ids } in srr.keys {
                if key == srr_key {
                    for StreamId { id, map, .. } in ids {
                        last_stream_id = id.to_string();
                        if let Some(v) = map.get("v") {
                            if let redis::Value::BulkString(bytes) = v {
                                let mut event =
                                    serde_json::from_slice::<EventMsg>(
                                        &bytes[..],
                                    )
                                    .c(h!())?;
                                event.id = id.clone();
                                res.push(event);
                            } else {
                                warn!(
                                    "Error: Impossible! Error: Weird non-byte data"
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    // If the read returned quickly (due to existing backlog or fast events),
    // keep accumulating until the minimum response time has elapsed.
    loop {
        let elapsed_ms = start_time.elapsed().as_millis() as u64;
        if elapsed_ms >= LONG_POLL_MIN_RESPONSE_TIME_MS {
            break;
        }
        let remaining = (LONG_POLL_MIN_RESPONSE_TIME_MS - elapsed_ms) as usize;
        // Block only up to the remaining window (but never exceed our max block)
        let block_ms = remaining.clamp(1, REDIS_READ_STREAM_BLOCK_MS);

        let srr: Option<StreamReadReply> = redis_con
            .xread_options(
                std::slice::from_ref(&srr_key),
                &[last_stream_id.clone()],
                &StreamReadOptions::default()
                    .count(REDIS_READ_STREAM_ELEMENTS_MAX)
                    .block(block_ms),
            )
            .await
            .c(h!())?;

        if let Some(srr) = srr {
            for StreamKey { key, ids } in srr.keys {
                if key == srr_key {
                    for StreamId { id, map, .. } in ids {
                        last_stream_id = id.to_string();
                        if let Some(v) = map.get("v") {
                            if let redis::Value::BulkString(bytes) = v {
                                let mut event =
                                    serde_json::from_slice::<EventMsg>(
                                        &bytes[..],
                                    )
                                    .c(h!())?;
                                event.id = id.clone();
                                res.push(event);
                            } else {
                                warn!(
                                    "Error: Impossible! Error: Weird non-byte data"
                                );
                            }
                        }
                    }
                }
            }
        }
    }
    let deployment_maintenance =
        get_deployment_maintenance(&mut env.redis.clone())
            .await
            .c(h!())?;
    Ok(Json(LongPollRsp {
        events: res,
        last_event_id: if last_stream_id == "$" {
            None
        } else {
            Some(last_stream_id)
        },
        deployment_maintenance,
    }))
}

async fn get_deployment_maintenance(
    redis: &mut ConnectionManager,
) -> Result<Option<DeploymentMaintenance>, AppError> {
    let id: Option<String> =
        redis.get(DEPLOYMENT_MAINTENANCE_REDIS_KEY).await.c(h!())?;
    let Some(id) = id else {
        return Ok(None);
    };
    let remaining_ms: i64 = redis::cmd("PTTL")
        .arg(DEPLOYMENT_MAINTENANCE_REDIS_KEY)
        .query_async(redis)
        .await
        .c(h!())?;
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
    fn deserializes_long_poll_requests_without_maintenance_protocol() {
        let req: LongPollReq = serde_json::from_value(serde_json::json!({
            "session_id": "current",
            "last_event_id": null
        }))
        .expect("legacy long-poll request should deserialize");

        assert_eq!(req.deployment_maintenance_protocol, None);
        assert_eq!(req.known_deployment_maintenance_id, None);
    }

    #[test]
    fn returns_maintenance_changes_immediately_only_for_supported_clients() {
        let maintenance = DeploymentMaintenance {
            id: "deploy-1".to_string(),
            remaining_ms: 120_000,
        };
        let mut req = LongPollReq {
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
