use self::types::*;
use crate::config::*;
use crate::types::*;
use chrono::prelude::*;
use redis::aio::ConnectionManager;
use redis::AsyncCommands;
use std::fmt::Write as _;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::sync::mpsc::error::{TryRecvError, TrySendError};
use tokio::sync::mpsc::Receiver;
use tokio_postgres::types::ToSql;
use tokio_util::sync::CancellationToken;

pub mod types;

const ACTIVITY_PAGE_VISIT_INSERT_COLUMNS: &str =
    "INSERT INTO activity_page_visit (ts, id, public_host, username, page, payload)
     VALUES ";
const ACTIVITY_PAGE_VISIT_INSERT_SQL: &str =
    "INSERT INTO activity_page_visit (ts, id, public_host, username, page, payload)
     VALUES ($1, $2, $3, $4, $5, $6)";

fn session_activity_ms_to_duration(ms: u64) -> Duration {
    Duration::from_millis(ms.max(1))
}

fn cap_payload_bytes(
    payload: Option<serde_json::Value>,
    max_bytes: usize,
) -> anyhow::Result<Option<Vec<u8>>> {
    let Some(payload) = payload else {
        return Ok(None);
    };
    let payload = serde_json::to_vec(&payload).c(h!())?;
    if payload.len() > max_bytes {
        debug!(
            "session activity payload dropped: size={} > cap={max_bytes}",
            payload.len()
        );
        return Ok(None);
    }
    Ok(Some(payload))
}

fn enqueue_session_activity(
    env: &actix_web::web::Data<Env>,
    event: SessionActivityEvent,
) {
    let Some(session_activity_tx) = env.session_activity_tx.as_ref() else {
        return;
    };
    match session_activity_tx.try_send(event) {
        Ok(()) => {
            env.session_activity_enqueued
                .fetch_add(1, Ordering::Relaxed);
        }
        Err(TrySendError::Full(_)) => {
            let dropped =
                env.session_activity_dropped.fetch_add(1, Ordering::Relaxed)
                    + 1;
            if dropped % 100 == 1 {
                warn!(
                    "session activity queue is full; dropped_total={dropped}"
                );
            }
        }
        Err(TrySendError::Closed(_)) => {
            warn!("session activity queue is closed");
        }
    }
}

pub async fn record_new_session(
    user_id: &uuid::Uuid,
    session_id: Uuid,
    env: &actix_web::web::Data<Env>,
) -> anyhow::Result<()> {
    enqueue_session_activity(
        env,
        SessionActivityEvent {
            ts: Utc::now().naive_utc(),
            id: session_id.to_string(),
            public_host: Some(env.config.public_host.clone()),
            username: Some(user_id.to_string()),
            page: None,
            payload: None,
        },
    );
    Ok(())
}

pub async fn record_page_visit(
    user_id: &uuid::Uuid,
    page: &Option<String>,
    env: &actix_web::web::Data<Env>,
    payload: Option<serde_json::Value>,
) -> anyhow::Result<()> {
    let payload =
        cap_payload_bytes(payload, env.session_activity_payload_max_bytes())
            .c(h!())?;
    enqueue_session_activity(
        env,
        SessionActivityEvent {
            ts: Utc::now().naive_utc(),
            id: Uuid::now_v7().to_string(),
            public_host: Some(env.config.public_host.clone()),
            username: Some(user_id.to_string()),
            page: page.clone(),
            payload,
        },
    );
    Ok(())
}

pub async fn run_activity_worker_nofail(
    env: Arc<Env>,
    cancel_token: CancellationToken,
) {
    if let Err(err) = run_activity_worker(env, cancel_token).await {
        error!("session activity worker failed: {:?}", err);
    }
}

async fn run_activity_worker(
    env: Arc<Env>,
    cancel_token: CancellationToken,
) -> anyhow::Result<()> {
    let Some(greptime) = env.greptime() else {
        info!("session activity worker disabled: greptime is not configured");
        return Ok(());
    };
    let Some(mut rx) = env.take_session_activity_rx().await else {
        info!("session activity worker disabled: queue is not initialized");
        return Ok(());
    };
    let get_timeout = session_activity_ms_to_duration(
        env.session_activity_greptime_get_timeout_ms(),
    );
    let query_timeout = session_activity_ms_to_duration(
        env.session_activity_greptime_query_timeout_ms(),
    );
    info!(
        "starting session activity worker; get_timeout_ms={} query_timeout_ms={}",
        get_timeout.as_millis(),
        query_timeout.as_millis()
    );
    loop {
        tokio::select! {
            _ = cancel_token.cancelled() => {
                info!("session activity worker received cancellation");
                break;
            }
            maybe_event = rx.recv() => {
                let Some(event) = maybe_event else {
                    info!("session activity worker queue closed");
                    break;
                };
                let mut events = Vec::with_capacity(SESSION_ACTIVITY_GREPTIME_BATCH_SIZE);
                events.push(event);
                drain_session_activity_batch(&mut rx, &mut events);
                if let Err(err) = write_activity_page_visits(
                    &greptime,
                    &events,
                    get_timeout,
                    query_timeout,
                )
                .await {
                    warn!("Failed to insert activity_page_visit: {:?}", err);
                }
            }
        }
    }
    Ok(())
}

fn drain_session_activity_batch(
    rx: &mut Receiver<SessionActivityEvent>,
    events: &mut Vec<SessionActivityEvent>,
) {
    let Some(first_event) = events.first() else {
        return;
    };
    let mut min_ts = first_event.ts;
    let mut max_ts = first_event.ts;
    while events.len() < SESSION_ACTIVITY_GREPTIME_BATCH_SIZE {
        match rx.try_recv() {
            Ok(event) => {
                min_ts = min_ts.min(event.ts);
                max_ts = max_ts.max(event.ts);
                events.push(event);
                if max_ts.signed_duration_since(min_ts).num_milliseconds()
                    > SESSION_ACTIVITY_GREPTIME_BATCH_MAX_SPAN_MS
                {
                    break;
                }
            }
            Err(TryRecvError::Empty) => break,
            Err(TryRecvError::Disconnected) => break,
        }
    }
}

async fn write_activity_page_visits(
    greptime: &deadpool_postgres::Pool,
    events: &[SessionActivityEvent],
    get_timeout: Duration,
    query_timeout: Duration,
) -> anyhow::Result<()> {
    if events.is_empty() {
        return Ok(());
    }
    if events.len() == 1 {
        return write_activity_page_visit(
            greptime,
            &events[0],
            get_timeout,
            query_timeout,
        )
        .await;
    }

    if let Err(err) = write_activity_page_visit_batch(
        greptime,
        events,
        get_timeout,
        query_timeout,
    )
    .await
    {
        warn!(
            "session activity batch insert failed; retrying one-by-one: {:?}",
            err
        );
        for event in events {
            write_activity_page_visit(
                greptime,
                event,
                get_timeout,
                query_timeout,
            )
            .await?;
        }
    }

    Ok(())
}

async fn write_activity_page_visit(
    greptime: &deadpool_postgres::Pool,
    event: &SessionActivityEvent,
    get_timeout: Duration,
    query_timeout: Duration,
) -> anyhow::Result<()> {
    let client = tokio::time::timeout(get_timeout, greptime.get())
        .await
        .context("greptime get connection timeout")
        .c(h!())?
        .context("greptime get connection failed")
        .c(h!())?;

    tokio::time::timeout(
        query_timeout,
        client.execute(
            ACTIVITY_PAGE_VISIT_INSERT_SQL,
            &[
                &event.ts,
                &event.id,
                &event.public_host,
                &event.username,
                &event.page,
                &event.payload,
            ],
        ),
    )
    .await
    .context("greptime insert timeout")
    .c(h!())?
    .context("greptime insert failed")
    .c(h!())?;

    Ok(())
}

async fn write_activity_page_visit_batch(
    greptime: &deadpool_postgres::Pool,
    events: &[SessionActivityEvent],
    get_timeout: Duration,
    query_timeout: Duration,
) -> anyhow::Result<()> {
    let client = tokio::time::timeout(get_timeout, greptime.get())
        .await
        .context("greptime get connection timeout")
        .c(h!())?
        .context("greptime get connection failed")
        .c(h!())?;
    let sql = activity_page_visit_batch_sql(events.len());
    let mut params: Vec<&(dyn ToSql + Sync)> =
        Vec::with_capacity(events.len() * 6);
    for event in events {
        push_activity_page_visit_params(&mut params, event);
    }

    tokio::time::timeout(
        query_timeout,
        client.execute(sql.as_str(), params.as_slice()),
    )
    .await
    .context("greptime batch insert timeout")
    .c(h!())?
    .context("greptime batch insert failed")
    .c(h!())?;

    Ok(())
}

fn activity_page_visit_batch_sql(events_len: usize) -> String {
    let mut sql = String::from(ACTIVITY_PAGE_VISIT_INSERT_COLUMNS);
    for i in 0..events_len {
        if i > 0 {
            sql.push_str(", ");
        }
        let base = i * 6;
        write!(
            sql,
            "(${}, ${}, ${}, ${}, ${}, ${})",
            base + 1,
            base + 2,
            base + 3,
            base + 4,
            base + 5,
            base + 6
        )
        .expect("write to String cannot fail");
    }
    sql
}

fn push_activity_page_visit_params<'a>(
    params: &mut Vec<&'a (dyn ToSql + Sync)>,
    event: &'a SessionActivityEvent,
) {
    params.push(&event.ts);
    params.push(&event.id);
    params.push(&event.public_host);
    params.push(&event.username);
    params.push(&event.page);
    params.push(&event.payload);
}

pub async fn get_all_sessions(
    redis: &mut redis::aio::ConnectionManager,
) -> Result<Vec<RedisSession>, AppError> {
    let session_ids_s: HashSet<String> =
        redis.smembers(REDIS_SESSIONS_KEY).await.c(h!())?;
    let mut session_ids: HashSet<Uuid> = HashSet::new();
    for id in session_ids_s {
        if let Ok(session_id) = Uuid::parse_str(&id) {
            session_ids.insert(session_id);
        } else {
            warn!("Error: Impossible! Error: Weird non-UUID data {}", h!());
        }
    }

    let session_keys = session_ids
        .iter()
        .map(|s| crate::event_stream::get_sess_key(*s))
        .collect::<Vec<String>>();

    if !session_keys.is_empty() {
        let sessions: Vec<Option<RedisSession>> =
            redis.mget(session_keys).await.c(h!())?;

        trace!("sessions: {:?}", sessions);
        let existing_sessions = sessions
            .into_iter()
            .flatten()
            .collect::<Vec<RedisSession>>();
        trace!("Existing sessions: {:?}", existing_sessions);
        // remove ids that exist in SET but have no appropriate key due to expiration by TTL
        let existing_ids_s = existing_sessions
            .iter()
            .map(|s| s.session_id.to_string())
            .collect::<HashSet<String>>();
        let mut existing_ids: HashSet<Uuid> = HashSet::new();
        for id in existing_ids_s {
            if let Ok(session_id) = Uuid::parse_str(&id) {
                existing_ids.insert(session_id);
            } else {
                warn!("Error: Impossible! Error: Weird non-UUID data {}", h!());
            }
        }
        let orphant_ids: HashSet<_> =
            session_ids.difference(&existing_ids).collect();
        trace!("sessions, orphant_ids: {:?}", orphant_ids);
        if !orphant_ids.is_empty() {
            let orphan_ids_str: Vec<String> =
                orphant_ids.iter().map(|s| s.to_string()).collect();
            redis
                .srem::<&str, Vec<String>, redis::Value>(
                    REDIS_SESSIONS_KEY,
                    orphan_ids_str,
                )
                .await
                .c(h!())?;
        }

        return Ok(existing_sessions);
    }

    Ok(vec![])
}

pub async fn add_session(
    redis: &mut ConnectionManager,
    session_id: Uuid,
    account_id: &Uuid,
) -> Result<RedisSession, AppError> {
    let _res: redis::Value = redis
        .sadd::<&str, String, redis::Value>(
            REDIS_SESSIONS_KEY,
            session_id.to_string(),
        )
        .await
        .c(h!())?;

    let current_datetime = Utc::now().naive_utc();
    let session = RedisSession {
        account_id: account_id.to_string(),
        session_id,
        created_at: current_datetime,
        heartbeat_at: current_datetime,
    };
    let key = crate::event_stream::get_sess_key(session_id);
    let _res: () = redis.set(key.clone(), &session).await.c(h!())?;

    let _res: () = redis
        .expire(key, SESSION_STREAM_LIFETIME_SEC)
        .await
        .c(h!())?;

    Ok(session)
}

pub async fn remove_session(
    redis: &mut ConnectionManager,
    session_id: Uuid,
) -> Result<(), AppError> {
    redis
        .srem::<&str, String, redis::Value>(
            REDIS_SESSIONS_KEY,
            session_id.to_string(),
        )
        .await
        .c(h!())?;
    redis
        .del::<Vec<String>, redis::Value>(vec![
            crate::event_stream::get_sess_key(session_id),
            crate::event_stream::session_stream_id(session_id),
        ])
        .await
        .c(h!())?;
    Ok(())
}

pub async fn update_heartbeat(
    redis: &mut ConnectionManager,
    mut session: RedisSession,
    account_id: &Uuid,
) -> Result<RedisSession, AppError> {
    session.heartbeat_at = Utc::now().naive_utc();
    session.account_id = account_id.to_string();

    let key = crate::event_stream::get_sess_key(session.session_id);
    let _res: () = redis.set(key.clone(), &session).await.c(h!())?;

    let _res: () = redis
        .expire(key, crate::config::SESSION_STREAM_LIFETIME_SEC)
        .await
        .c(h!())?;

    Ok(session)
}

pub async fn get_session_by_id(
    redis: &mut ConnectionManager,
    session_id: Uuid,
) -> Result<Option<RedisSession>, AppError> {
    let session: Option<RedisSession> = redis
        .get(crate::event_stream::get_sess_key(session_id))
        .await
        .c(h!())?;
    Ok(session)
}
