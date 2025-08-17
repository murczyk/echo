use self::types::*;
use crate::config::*;
use crate::types::*;
use actix_web::post;
use actix_web::web::Json;
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
    let m_session_id: Option<String> = session.get("id").context(h!())?;
    match m_session_id {
        Some(session_id) => {
            let session_id = Uuid::parse_str(&session_id).context(h!())?;
            Ok(Some(session_id))
        }
        None => Ok(None),
    }
}

#[post("/api/event-stream/long-poll")]
async fn long_poll(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    session: actix_session::Session,
    req: Json<LongPollReq>,
) -> Result<Json<LongPollRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Basic").await?;
    let user_id = user.id().context(h!())?;
    let account_id = user_id;
    let Some(session_id) = get_session_id(&session).context(h!())? else {
        tokio::time::sleep(tokio::time::Duration::from_millis(
            LONG_POLL_SLEEP_MS,
        ))
        .await;

        return Ok(Json(LongPollRsp {
            events: vec![],
            last_event_id: None,
        }));
    };

    let session =
        crate::session::get_session_by_id(&mut env.redis.clone(), session_id)
            .await
            .context(h!())?;
    match session {
        None => {
            crate::session::add_session(
                &mut env.redis.clone(),
                session_id,
                &account_id,
            )
            .await
            .context(h!())?;

            create_redis_stream(&mut env.redis.clone(), session_id)
                .await
                .context(h!())?;
        }
        Some(session) => {
            crate::session::update_heartbeat(
                &mut env.redis.clone(),
                session,
                &account_id,
            )
            .await
            .context(h!())?;

            update_redis_stream(&mut env.redis.clone(), session_id)
                .await
                .context(h!())?;
        }
    };

    let req: LongPollReq = req.into_inner();
    let m_last_event_id = req.last_event_id;
    let srr_key = session_stream_id(session_id);
    let mut last_stream_id = "$".to_string();
    if let Some(last_event_id) = m_last_event_id {
        last_stream_id = last_event_id.to_string();
    };
    let mut redis_con = env
        .redisb
        .get_multiplexed_tokio_connection()
        .await
        .context(h!())?;
    let srr: StreamReadReply = redis_con
        .xread_options(
            std::slice::from_ref(&srr_key),
            &[last_stream_id.clone()],
            &StreamReadOptions::default()
                .count(REDIS_READ_STREAM_ELEMENTS_MAX)
                .block(REDIS_READ_STREAM_BLOCK_MS),
        )
        .await
        .context(h!())?;
    let mut res = vec![];
    for StreamKey { key, ids } in srr.keys {
        if key == srr_key {
            for StreamId { id, map } in ids {
                last_stream_id = id.to_string();
                if let Some(v) = map.get("v") {
                    if let redis::Value::BulkString(bytes) = v {
                        // parse bytes as a json value of type Event
                        let mut event =
                            serde_json::from_slice::<EventMsg>(&bytes[..])
                                .context(h!())?;
                        event.id = id.clone();
                        res.push(event);
                    } else {
                        warn!("Error: Impossible! Error: Weird non-byte data");
                    }
                }
            }
        }
    }
    Ok(Json(LongPollRsp {
        events: res,
        last_event_id: if last_stream_id == "$" {
            None
        } else {
            Some(last_stream_id)
        },
    }))
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
    let mut pipe = redis::pipe();
    for session in crate::session::get_all_sessions(redis)
        .await
        .context(h!())?
    {
        let event = event.clone();
        let _res: () = pipe_xadd(
            &mut pipe,
            session.session_id,
            serde_json::to_string(&event)
                .context(h!())?
                .as_bytes()
                .to_vec(),
        );
    }
    let _res: () = pipe.query_async(redis).await.context(h!())?;
    Ok(())
}

pub async fn fanout_mult(
    redis: &mut redis::aio::ConnectionManager,
    events: Vec<EventMsg>,
) -> Result<(), AppError> {
    for event in events {
        fanout(redis, event).await.context(h!())?;
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
    };
    let val = serde_json::to_string(&val)
        .context(h!())?
        .as_bytes()
        .to_vec();
    redis
        .del::<String, redis::Value>(crate::event_stream::session_stream_id(
            session_id,
        ))
        .await
        .context(h!())?;
    let xadd_reply = redis
        .xadd::<String, &str, &str, Vec<u8>, String>(
            crate::event_stream::session_stream_id(session_id),
            "*",
            &[("v", val.clone())],
        )
        .await
        .context(h!())?;
    redis
        .expire::<String, redis::Value>(
            crate::event_stream::session_stream_id(session_id),
            crate::config::SESSION_STREAM_LIFETIME_SEC,
        )
        .await
        .context(h!())?;
    redis
        .xdel::<String, &str, redis::Value>(
            crate::event_stream::session_stream_id(session_id),
            &[&xadd_reply],
        )
        .await
        .context(h!())?;
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
        .context(h!())?;
    Ok(())
}
