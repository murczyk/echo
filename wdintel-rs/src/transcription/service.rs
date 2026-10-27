use crate::h;
use anyhow::{Context, Result};
use sea_orm::{
    ConnectionTrait, DbBackend, Statement, TransactionSession, TransactionTrait,
};
use uuid::Uuid;

pub(crate) async fn ensure_sources_registered<C: ConnectionTrait>(
    db: &C,
) -> Result<()> {
    anyhow::ensure!(
        db.query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            "select 1 from echo_gpu_transcription_queue queue left join transcription_source source on source.id=queue.source_id where source.id is null limit 1",
        ))
        .await
        .context(h!())?
        .is_none(),
        "Run database migrations before starting transcription"
    );
    Ok(())
}

pub async fn enqueue<C>(
    db: &C,
    source_key: &str,
) -> Result<(Uuid, echo_gpu_client::EnqueueOutcome)>
where
    C: ConnectionTrait + TransactionTrait,
{
    anyhow::ensure!(!source_key.is_empty(), "empty transcription source key");
    let transaction = db.begin().await.context(h!())?;
    let source = register(&transaction, source_key).await.context(h!())?;
    let outcome = echo_gpu_client::enqueue(&transaction, source)
        .await
        .context(h!())?;
    transaction.commit().await.context(h!())?;
    Ok((source, outcome))
}

pub(crate) async fn register<C: ConnectionTrait>(
    db: &C,
    source_key: &str,
) -> Result<Uuid> {
    anyhow::ensure!(!source_key.is_empty(), "empty transcription source key");
    let source = db.query_one_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "insert into transcription_source(id,source_key) values($1,$2) on conflict(source_key) do update set source_key=excluded.source_key returning id",
        [Uuid::now_v7().into(), source_key.into()],
    )).await.context(h!())?.context("source registration returned no row").context(h!())?.try_get("", "id").context(h!())?;
    Ok(source)
}

pub async fn source_key<C: ConnectionTrait>(
    db: &C,
    source: Uuid,
) -> Result<Option<String>> {
    db.query_one_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "select source_key from transcription_source where id=$1",
        [source.into()],
    ))
    .await
    .context(h!())?
    .map(|row| row.try_get("", "source_key").context(h!()))
    .transpose()
}

pub async fn source_id<C: ConnectionTrait>(
    db: &C,
    key: &str,
) -> Result<Option<Uuid>> {
    db.query_one_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "select id from transcription_source where source_key=$1",
        [key.into()],
    ))
    .await
    .context(h!())?
    .map(|row| row.try_get("", "id").context(h!()))
    .transpose()
}

pub(crate) async fn may_delete(
    db: &sea_orm::DatabaseConnection,
    key: &str,
) -> bool {
    match source_id(db, key).await {
        Ok(None) => true,
        Ok(Some(_)) => false,
        Err(error) => {
            log::warn!("deferring object deletion: transcription registry unavailable: {error:#}");
            false
        }
    }
}

#[derive(sea_orm::FromQueryResult)]
pub(crate) struct NativeSourceState {
    pub source_key: String,
    pub id: Uuid,
    pub state: String,
    pub reprocess_count: i32,
}

pub(crate) async fn native_sources_by_keys<C: ConnectionTrait>(
    db: &C,
    keys: &[String],
) -> Result<std::collections::HashMap<String, NativeSourceState>> {
    if keys.is_empty() {
        return Ok(Default::default());
    }
    use sea_orm::FromQueryResult;
    Ok(NativeSourceState::find_by_statement(Statement::from_sql_and_values(DbBackend::Postgres,
        "select source.source_key,source.id,queue.state,queue.reprocess_count from transcription_source source join echo_gpu_transcription_queue queue on queue.source_id=source.id where source.source_key=any($1)", [keys.to_vec().into()]))
        .all(db).await.context(h!())?.into_iter().map(|source| (source.source_key.clone(),source)).collect())
}
