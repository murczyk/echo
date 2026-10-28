use crate::config::{
    AI_WORKER_FALLBACK_TIMEOUT_SECS, AI_WORKER_PRIMARY_TIMEOUT_SECS,
};
use crate::entities::ai_engine;
use crate::{h, types::ShortContext};
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QuerySelect,
};
use std::{future::Future, time::Duration};
use uuid::Uuid;

pub(crate) mod monitoring;
#[cfg(test)]
pub(crate) mod test_support;

pub(crate) fn deserialize_fallback_update<'de, D>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    <Option<String> as serde::Deserialize>::deserialize(deserializer).map(Some)
}

pub(crate) fn parse_fallback_update(
    value: Option<Option<String>>,
) -> anyhow::Result<Option<Option<Uuid>>> {
    value
        .map(|id| id.as_deref().map(Uuid::parse_str).transpose().c(h!()))
        .transpose()
        .c(h!())
}

pub(crate) async fn load_fallback<C: ConnectionTrait>(
    db: &C,
    primary_id: Uuid,
    fallback_id: Option<Uuid>,
) -> anyhow::Result<Option<ai_engine::Model>> {
    let Some(id) = fallback_id else {
        return Ok(None);
    };
    anyhow::ensure!(
        id != primary_id,
        "Primary and fallback AI engines must differ"
    );
    let engine = ai_engine::Entity::find_by_id(id)
        .filter(ai_engine::Column::Enabled.eq(true))
        .filter(ai_engine::Column::CallsignEnabled.eq(true))
        .one(db)
        .await
        .c(h!())?
        .ok_or_else(|| anyhow::anyhow!("Fallback AI engine is unavailable"))
        .c(h!())?;
    Ok(Some(engine))
}

pub(crate) async fn validate_selection<C: ConnectionTrait>(
    db: &C,
    enabled: bool,
    primary: Option<Uuid>,
    fallback: Option<Uuid>,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        !enabled || primary.is_some(),
        crate::error::AppError::BL {
            msg: "Оберіть основний ШІ движок".to_string()
        }
    );
    anyhow::ensure!(
        fallback.is_none() || primary.is_some(),
        crate::error::AppError::BL {
            msg: "Оберіть основний ШІ движок перед резервним".to_string()
        }
    );
    anyhow::ensure!(
        fallback.is_none() || primary != fallback,
        crate::error::AppError::BL {
            msg: "Основний та резервний ШІ движки мають відрізнятися"
                .to_string()
        }
    );
    let mut ids = [primary, fallback]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    ids.sort();
    for id in ids {
        let engine = ai_engine::Entity::find_by_id(id)
            .filter(ai_engine::Column::Enabled.eq(true))
            .filter(ai_engine::Column::CallsignEnabled.eq(true))
            .lock_shared()
            .one(db)
            .await
            .c(h!())?;
        anyhow::ensure!(
            engine.is_some(),
            crate::error::AppError::BL {
                msg: "Вибраний ШІ движок вимкнено або видалено".to_string()
            }
        );
    }
    Ok(())
}

pub(crate) async fn with_fallback<T, F, Fut>(
    worker: &str,
    primary: &ai_engine::Model,
    fallback: Option<&ai_engine::Model>,
    operation: F,
) -> anyhow::Result<(T, ai_engine::Model)>
where
    F: Fn(ai_engine::Model) -> Fut,
    Fut: Future<Output = anyhow::Result<T>>,
{
    let Some(fallback) = fallback else {
        return Ok((
            operation(primary.clone()).await.c(h!())?,
            primary.clone(),
        ));
    };
    let first =
        attempt(&operation, primary, AI_WORKER_PRIMARY_TIMEOUT_SECS).await;
    match first {
        Ok(value) => Ok((value, primary.clone())),
        Err(primary_error) => {
            log::warn!("AI worker primary failed; using fallback: worker={worker} primary_id={} fallback_id={} error={}", primary.id, fallback.id, bounded_error(&format!("{primary_error:#}")));
            let value = attempt(&operation, fallback, AI_WORKER_FALLBACK_TIMEOUT_SECS)
                .await.map_err(|fallback_error| anyhow::anyhow!("Primary AI failed: {primary_error:#}; fallback AI failed: {fallback_error:#}")).c(h!())?;
            Ok((value, fallback.clone()))
        }
    }
}

async fn attempt<T, F, Fut>(
    operation: &F,
    engine: &ai_engine::Model,
    seconds: u64,
) -> anyhow::Result<T>
where
    F: Fn(ai_engine::Model) -> Fut,
    Fut: Future<Output = anyhow::Result<T>>,
{
    tokio::time::timeout(
        Duration::from_secs(seconds),
        operation(engine.clone()),
    )
    .await
    .map_err(|_| anyhow::anyhow!("AI engine {} exceeded {seconds}s", engine.id))
    .c(h!())?
}

pub(crate) async fn record_success<C: ConnectionTrait>(
    db: &C,
    worker: &str,
    message_id: i64,
) -> anyhow::Result<()> {
    db.execute_raw(crate::ai_callsign::feedback::sql(
        "insert into ai_worker_progress(worker,last_completed_at,latest_processed_entry_created_at) select $1,now() at time zone 'utc',created_at from signal_message where id=$2 on conflict(worker) do update set last_completed_at=greatest(ai_worker_progress.last_completed_at,excluded.last_completed_at),latest_processed_entry_created_at=greatest(ai_worker_progress.latest_processed_entry_created_at,excluded.latest_processed_entry_created_at)",
        vec![worker.into(), message_id.into()],
    )).await.c(h!())?;
    Ok(())
}

pub(crate) async fn record_failure<C: ConnectionTrait>(
    db: &C,
    worker: &str,
    job_id: &str,
    error: &str,
) -> anyhow::Result<()> {
    let error = bounded_error(error);
    log::warn!(
        "AI worker job failed: worker={worker} job_id={job_id} error={error}"
    );
    db.execute_raw(crate::ai_callsign::feedback::sql(
        "insert into ai_worker_progress(worker,last_error_at,last_error) values($1,now() at time zone 'utc',$2) on conflict(worker) do update set last_error_at=excluded.last_error_at,last_error=excluded.last_error",
        vec![worker.into(), error.into()],
    )).await.c(h!())?;
    Ok(())
}

fn bounded_error(error: &str) -> String {
    error
        .chars()
        .take(crate::config::AI_WORKER_MAX_ERROR_CHARS)
        .collect()
}
