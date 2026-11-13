use crate::h;
use anyhow::{Context, Result};
use sea_orm::SqlxPostgresConnector;
use sqlx::{postgres::PgPoolOptions, Connection, PgConnection};
use std::{
    ops::Deref,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

pub(crate) const ECHO_AUDIO_TRANSCRIPTION_EXECUTOR_LOCK: i64 = 36450001;
pub(crate) const ECHO_AUDIO_TRANSCRIPTION_EXECUTOR_DRAIN_LOCK: i64 = 36450002;
const ECHO_AUDIO_TRANSCRIPTION_EXECUTOR_CONNECTIONS: u32 = 2;
const ECHO_AUDIO_TRANSCRIPTION_EXECUTOR_ACQUIRE_TIMEOUT_SECS: u64 = 5;

pub struct Executor {
    client: echo_gpu_client::EchoGpuClient,
    stopped: CancellationToken,
}

impl Deref for Executor {
    type Target = echo_gpu_client::EchoGpuClient;
    fn deref(&self) -> &Self::Target {
        &self.client
    }
}

impl Drop for Executor {
    fn drop(&mut self) {
        self.stopped.cancel();
    }
}

impl Executor {
    pub async fn lost(&self) {
        self.stopped.cancelled().await;
    }
}

pub async fn client(config: &crate::config::Config) -> Result<Executor> {
    let mut leader = PgConnection::connect(&crate::mk_conn_string(config))
        .await
        .context(h!())?;
    for key in [
        ECHO_AUDIO_TRANSCRIPTION_EXECUTOR_LOCK,
        ECHO_AUDIO_TRANSCRIPTION_EXECUTOR_DRAIN_LOCK,
    ] {
        sqlx::query("select pg_advisory_lock($1)")
            .bind(key)
            .execute(&mut leader)
            .await
            .context(h!())?;
    }
    super::executor_session::recover(&mut leader)
        .await
        .context(h!())?;
    let owner = uuid::Uuid::now_v7().to_string();
    let pid: i32 = sqlx::query_scalar("select pg_backend_pid() from (select set_config('application_name',$1,false)) configured")
        .bind(&owner).fetch_one(&mut leader).await.context(h!())?;
    sqlx::query("select pg_advisory_unlock($1)")
        .bind(ECHO_AUDIO_TRANSCRIPTION_EXECUTOR_DRAIN_LOCK)
        .execute(&mut leader)
        .await
        .context(h!())?;
    let stopped = CancellationToken::new();
    let sessions = Arc::new(Mutex::new(Vec::new()));
    let pool = worker_pool(pid, owner, sessions.clone(), stopped.clone())
        .connect(&crate::mk_conn_string(config))
        .await
        .context(h!())?;
    let first = pool.acquire().await.context(h!())?;
    let second = pool.acquire().await.context(h!())?;
    drop((first, second));
    let db = SqlxPostgresConnector::from_sqlx_postgres_pool(pool.clone());
    let client = echo_gpu_client::EchoGpuClient::new(db, Default::default())
        .await
        .context(h!())?;
    let monitor_stop = stopped.clone();
    let pids = sessions.lock().unwrap().clone();
    tokio::spawn(async move {
        tokio::select! {
            _ = monitor_stop.cancelled() => (),
            _ = pool.close_event() => (),
            result = super::executor_session::monitor(&mut leader, &pids) => {
                log::error!("transcription executor session lost: {result:#?}");
            }
        }
        monitor_stop.cancel();
        // Shared drain locks keep successors behind all remaining work SQL.
        drop(leader);
        pool.close().await;
    });
    Ok(Executor { client, stopped })
}

fn worker_pool(
    leader_pid: i32,
    owner: String,
    sessions: Arc<Mutex<Vec<i32>>>,
    stopped: CancellationToken,
) -> PgPoolOptions {
    let connected = sessions.clone();
    let connect_stop = stopped.clone();
    PgPoolOptions::new()
        .max_connections(ECHO_AUDIO_TRANSCRIPTION_EXECUTOR_CONNECTIONS)
        .min_connections(0)
        .max_lifetime(None).idle_timeout(None)
        .acquire_timeout(Duration::from_secs(ECHO_AUDIO_TRANSCRIPTION_EXECUTOR_ACQUIRE_TIMEOUT_SECS))
        .after_connect(move |connection, _| {
            let sessions = connected.clone();
            let stopped = connect_stop.clone();
            Box::pin(async move {
                if sessions.lock().unwrap().len() >= ECHO_AUDIO_TRANSCRIPTION_EXECUTOR_CONNECTIONS as usize {
                    stopped.cancel();
                    return Err(session_lost());
                }
                sqlx::query("select pg_advisory_lock_shared($1)")
                    .bind(ECHO_AUDIO_TRANSCRIPTION_EXECUTOR_DRAIN_LOCK)
                    .execute(&mut *connection).await.map_err(|error| sqlx::Error::Protocol(format!("{}: {error}", h!())))?;
                let pid = sqlx::query_scalar("select pg_backend_pid()")
                    .fetch_one(&mut *connection).await.map_err(|error| sqlx::Error::Protocol(format!("{}: {error}", h!())))?;
                sessions.lock().unwrap().push(pid);
                Ok(())
            })
        })
        .before_acquire(move |connection, _| {
            let pids = sessions.lock().unwrap().clone();
            let owner = owner.clone();
            let stopped = stopped.clone();
            Box::pin(async move {
                let valid: bool = sqlx::query_scalar("select exists(select 1 from pg_stat_activity activity join pg_locks leadership on leadership.pid=activity.pid where activity.pid=$1 and activity.application_name=$2 and leadership.locktype='advisory' and leadership.classid=0 and leadership.objid::bigint=$6 and leadership.objsubid=1 and leadership.mode='ExclusiveLock' and leadership.granted) and (select count(distinct pid) from pg_locks where locktype='advisory' and database=(select oid from pg_database where datname=current_database()) and classid=0 and objid::bigint=$3 and objsubid=1 and mode='ShareLock' and granted and pid=any($4))=$5")
                    .bind(leader_pid).bind(owner).bind(ECHO_AUDIO_TRANSCRIPTION_EXECUTOR_DRAIN_LOCK)
                    .bind(&pids).bind(pids.len() as i64).bind(ECHO_AUDIO_TRANSCRIPTION_EXECUTOR_LOCK)
                    .fetch_one(&mut *connection).await.map_err(|error| sqlx::Error::Protocol(format!("{}: {error}", h!())))?;
                if stopped.is_cancelled() || !valid {
                    stopped.cancel();
                    return Err(session_lost());
                }
                Ok(true)
            })
        })
}

fn session_lost() -> sqlx::Error {
    sqlx::Error::Protocol(format!(
        "{}: transcription executor session lost; rebuild executor",
        h!()
    ))
}
