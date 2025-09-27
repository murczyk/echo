use self::types::*;
use crate::config::*;
use crate::types::*;
use chrono::prelude::*;
use redis::aio::ConnectionManager;
use redis::AsyncCommands;

pub mod types;

#[derive(Debug, Serialize, Deserialize, Clone)]
struct SessionActivity {
    pub start: NaiveDateTime,
    pub last_activity: NaiveDateTime,
    pub pages_time_spent_secs: BTreeMap<String, i32>,
    pub pages_filters: BTreeMap<String, BTreeSet<String>>,
}

impl Default for SessionActivity {
    fn default() -> Self {
        SessionActivity {
            start: Utc::now().naive_utc(),
            last_activity: Utc::now().naive_utc(),
            pages_time_spent_secs: BTreeMap::new(),
            pages_filters: BTreeMap::new(),
        }
    }
}

pub async fn record_new_session(
    user_id: &str,
    session_id: Uuid,
    env: &actix_web::web::Data<Env>,
) -> anyhow::Result<()> {
    if let Some(greptime) = env.greptime() {
        let user_id = user_id.to_string();
        let public_host = env.config.public_host.clone();

        tokio::spawn(async move {
            let now = Utc::now().naive_utc();
            let username = Some(user_id);
            let public_host = Some(public_host);

            let client = match greptime.get().await {
                Ok(client) => client,
                Err(e) => {
                    warn!("Failed to get connection from pool: {e:?}");
                    return;
                }
            };

            let stmt = match client.prepare(
                "INSERT INTO activity_page_visit (ts, id, public_host, username, page, payload)
                 VALUES ($1, $2, $3, $4, $5, $6)"
            ).await {
                Ok(stmt) => stmt,
                Err(e) => {
                    warn!("Failed to prepare statement: {e:?}");
                    return;
                }
            };

            let res = client
                .execute(
                    &stmt,
                    &[
                        &now,
                        &session_id.to_string(),
                        &public_host,
                        &username,
                        &Option::<String>::None,
                        &Option::<Vec<u8>>::None,
                    ],
                )
                .await;

            if let Err(e) = res {
                warn!("Failed to insert activity_page_visit: {:?} {}", e, h!());
            }
        });
    }

    Ok(())
}

pub async fn record_page_visit(
    user_id: &str,
    page: &Option<String>,
    env: &actix_web::web::Data<Env>,
    payload: Option<serde_json::Value>,
) -> anyhow::Result<()> {
    if let Some(greptime) = env.greptime() {
        let user_id = user_id.to_string();
        let page = page.clone();
        let payload = payload.clone();
        // deadpool_postgres fails to write JSON, so we manually convert to Vec<u8> here
        let payload: Option<Vec<u8>> = match payload {
            Some(ref p) => {
                let str = serde_json::to_string(&p).c(h!())?;
                let bytes = str.as_bytes().to_vec();
                Some(bytes)
            }
            None => None,
        };
        let public_host = env.config.public_host.clone();

        tokio::spawn(async move {
            let now = Utc::now().naive_utc();
            let id = Uuid::now_v7().to_string();
            let username = Some(user_id);
            let public_host = Some(public_host);

            let client = match greptime.get().await {
                Ok(client) => client,
                Err(e) => {
                    warn!("Failed to get connection from pool: {e:?}");
                    return;
                }
            };

            let stmt = match client.prepare(
                "INSERT INTO activity_page_visit (ts, id, public_host, username, page, payload)
                 VALUES ($1, $2, $3, $4, $5, $6)"
            ).await {
                Ok(stmt) => stmt,
                Err(e) => {
                    warn!("Failed to prepare statement: {e:?}");
                    return;
                }
            };

            let res = client
                .execute(
                    &stmt,
                    &[&now, &id, &public_host, &username, &page, &payload],
                )
                .await;

            if let Err(e) = res {
                warn!(
                    "Failed to insert activity_page_visit: {:?}, {}",
                    e,
                    h!()
                );
            }
        });
    }

    Ok(())
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

        trace!("sessions: {sessions:?}");
        let existing_sessions = sessions
            .into_iter()
            .flatten()
            .collect::<Vec<RedisSession>>();
        trace!("Existing sessions: {existing_sessions:?}");
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
        trace!("sessions, orphant_ids: {orphant_ids:?}");
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
    account_id: &str,
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

pub async fn update_heartbeat(
    redis: &mut ConnectionManager,
    mut session: RedisSession,
    account_id: &str,
) -> Result<RedisSession, AppError> {
    session.heartbeat_at = Utc::now().naive_utc();
    session.account_id = account_id.to_owned();

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
