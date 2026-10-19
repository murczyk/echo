use super::{
    executor::ECHO_AUDIO_TRANSCRIPTION_EXECUTOR_DRAIN_LOCK,
    ECHO_AUDIO_TRANSCRIPTION_PENDING_BATCH,
};
use crate::h;
use sea_orm::{
    ConnectionTrait, DbBackend, DbErr, ExecResult, QueryResult, Statement,
    Value,
};
use sqlx::{PgConnection, Postgres};
use tokio::sync::Mutex;

const ECHO_AUDIO_TRANSCRIPTION_EXECUTOR_MONITOR_INTERVAL_SECS: u64 = 1;

// The public stale-recovery API must run on the locked physical session before
// SQLx releases it to the pool, including reconnects between prepare and claim.
pub(super) struct RecoverySession<'a>(pub Mutex<&'a mut PgConnection>);

fn query(
    statement: &Statement,
) -> Result<sqlx::query::Query<'_, Postgres, sqlx::postgres::PgArguments>, DbErr>
{
    let mut query = sqlx::query(sqlx::AssertSqlSafe(statement.sql.as_str()));
    if let Some(values) = &statement.values {
        for value in &values.0 {
            query = match value {
                Value::Int(value) => query.bind(*value),
                Value::BigInt(value) => query.bind(*value),
                Value::ChronoDateTime(value) => query.bind(*value),
                _ => {
                    return Err(DbErr::Custom(format!(
                        "{}: unsupported native recovery parameter",
                        h!()
                    )))
                }
            };
        }
    }
    Ok(query)
}

#[async_trait::async_trait]
impl ConnectionTrait for RecoverySession<'_> {
    fn get_database_backend(&self) -> DbBackend {
        DbBackend::Postgres
    }
    async fn execute_raw(
        &self,
        _statement: Statement,
    ) -> Result<ExecResult, DbErr> {
        Err(DbErr::Custom(format!(
            "{}: recovery session only accepts public stale recovery reads",
            h!()
        )))
    }
    async fn execute_unprepared(
        &self,
        _sql: &str,
    ) -> Result<ExecResult, DbErr> {
        Err(DbErr::Custom(format!(
            "{}: recovery session only accepts public stale recovery reads",
            h!()
        )))
    }
    async fn query_one_raw(
        &self,
        _statement: Statement,
    ) -> Result<Option<QueryResult>, DbErr> {
        Err(DbErr::Custom(format!(
            "{}: recovery session only accepts public stale recovery reads",
            h!()
        )))
    }
    async fn query_all_raw(
        &self,
        statement: Statement,
    ) -> Result<Vec<QueryResult>, DbErr> {
        let mut connection = self.0.lock().await;
        let rows = query(&statement)
            .map_err(|error| DbErr::Custom(format!("{}: {error}", h!())))?
            .fetch_all(&mut **connection)
            .await
            .map_err(|error| DbErr::Custom(format!("{}: {error}", h!())))?;
        Ok(rows.into_iter().map(Into::into).collect())
    }
}

pub(super) async fn recover(
    connection: &mut PgConnection,
) -> anyhow::Result<()> {
    use anyhow::Context;
    loop {
        let stale_before = chrono::Utc::now().naive_utc()
            - chrono::Duration::seconds(
                crate::config::ECHO_AUDIO_TRANSCRIPTION_STALE_SECS,
            );
        let recovered = echo_gpu_client::recover_stale(
            &RecoverySession(Mutex::new(&mut *connection)),
            stale_before,
            crate::config::ECHO_AUDIO_TRANSCRIPTION_MAX_ATTEMPTS,
            ECHO_AUDIO_TRANSCRIPTION_PENDING_BATCH,
        )
        .await
        .context(h!())?;
        if recovered.len() == ECHO_AUDIO_TRANSCRIPTION_PENDING_BATCH as usize {
            continue;
        }
        let processing: bool = sqlx::query_scalar("select exists(select 1 from echo_gpu_transcription_queue where state='processing')")
            .fetch_one(&mut *connection).await.context(h!())?;
        if !processing {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
}

pub(super) async fn monitor(
    connection: &mut PgConnection,
    pids: &[i32],
) -> anyhow::Result<()> {
    use anyhow::Context;
    loop {
        let healthy: bool = tokio::time::timeout(
            std::time::Duration::from_secs(
                crate::config::ECHO_AUDIO_TRANSCRIPTION_HEARTBEAT_SECS,
            ),
            sqlx::query_scalar("select count(distinct pid)=$2 from pg_locks where locktype='advisory' and database=(select oid from pg_database where datname=current_database()) and classid=0 and objid::bigint=$1 and objsubid=1 and mode='ShareLock' and granted and pid=any($3)")
                .bind(ECHO_AUDIO_TRANSCRIPTION_EXECUTOR_DRAIN_LOCK)
                .bind(pids.len() as i64).bind(pids).fetch_one(&mut *connection),
        )
        .await
        .context(h!())?
        .context(h!())?;
        anyhow::ensure!(healthy, "transcription executor data session lost");
        tokio::time::sleep(std::time::Duration::from_secs(
            ECHO_AUDIO_TRANSCRIPTION_EXECUTOR_MONITOR_INTERVAL_SECS,
        ))
        .await;
    }
}
