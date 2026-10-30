use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use sqlx::Row;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{repository, DeviceFileContentRuntime};
use crate::devices::upload_finalization::{cleanup, query};
use crate::h;
use crate::types::Env;

type Cursor = Option<(DateTime<Utc>, Uuid)>;

#[derive(Default)]
struct AttemptSweep {
    cursor: Cursor,
    horizon: Option<DateTime<Utc>>,
}

pub(super) async fn run_nofail(
    env: Arc<Env>,
    runtime: Arc<DeviceFileContentRuntime>,
    cancellation: CancellationToken,
) {
    tokio::join!(
        source_loop(&env, &runtime, &cancellation),
        attempt_loop(&env, &runtime, &cancellation),
    );
}

async fn source_loop(
    env: &Env,
    runtime: &DeviceFileContentRuntime,
    cancellation: &CancellationToken,
) {
    let mut cursor = None;
    let poll_seconds = env
        .config
        .device_upload_finalization
        .as_ref()
        .filter(|settings| settings.is_valid())
        .map_or(
            crate::config::DEVICE_UPLOAD_FINALIZATION_POLL_SECONDS,
            |settings| settings.poll_seconds,
        );
    loop {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return,
            result = source_batch(env, runtime, &mut cursor) => {
                if let Err(error) = result { log::warn!("file finalization source cleanup deferred: {error:#}"); }
            }
        }
        tokio::select! {
            _ = cancellation.cancelled() => return,
            _ = tokio::time::sleep(Duration::from_secs(poll_seconds)) => {}
        }
    }
}

async fn attempt_loop(
    env: &Env,
    runtime: &DeviceFileContentRuntime,
    cancellation: &CancellationToken,
) {
    let mut sweep = AttemptSweep::default();
    let timeout = Duration::from_secs(
        env.config
            .device_upload_finalization
            .as_ref()
            .filter(|settings| settings.is_valid())
            .map_or(
                crate::config::DEVICE_UPLOAD_FINALIZATION_FILE_PHASE_SECONDS,
                |settings| settings.file_phase_seconds,
            ),
    );
    loop {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return,
            result = attempt_batch(runtime, &mut sweep, timeout) => {
                if let Err(error) = result { log::warn!("file finalization object cleanup deferred: {error:#}"); }
            }
        }
        tokio::select! {
            _ = cancellation.cancelled() => return,
            _ = tokio::time::sleep(Duration::from_secs(runtime.config.cleanup_poll_interval_secs)) => {}
        }
    }
}

async fn source_batch(
    env: &Env,
    runtime: &DeviceFileContentRuntime,
    cursor: &mut Cursor,
) -> Result<()> {
    let db = runtime.file_registry_db.connection();
    let limit =
        i64::try_from(runtime.config.cleanup_batch_size).context(h!())?;
    let rows = if let Some((updated_at, id)) = cursor {
        sqlx::query("select id,updated_at from device_upload_finalization_job where kind='file' and status in ('completed','failed') and quota_released_at is null and (updated_at,id)>($1,$2) order by updated_at,id limit $3")
            .bind(*updated_at).bind(*id).bind(limit)
            .fetch_all(db.get_postgres_connection_pool()).await.context(h!())?
    } else {
        sqlx::query("select id,updated_at from device_upload_finalization_job where kind='file' and status in ('completed','failed') and quota_released_at is null order by updated_at,id limit $1")
            .bind(limit).fetch_all(db.get_postgres_connection_pool()).await.context(h!())?
    };
    if rows.is_empty() {
        *cursor = None;
    }
    for row in rows {
        let id = row.try_get("id").context(h!())?;
        *cursor = Some((row.try_get("updated_at").context(h!())?, id));
        if let Err(error) = cleanup_source(env, runtime, id).await {
            log::warn!("file finalization source cleanup failed: {error:#}");
        }
    }
    Ok(())
}

pub(in crate::devices) async fn cleanup_source(
    env: &Env,
    runtime: &DeviceFileContentRuntime,
    job: Uuid,
) -> Result<()> {
    let db = runtime.file_registry_db.connection();
    let row = sqlx::query("select file_upload_id,source_release_state,status from device_upload_finalization_job where id=$1 and kind='file' and status in ('completed','failed')")
        .bind(job).fetch_optional(db.get_postgres_connection_pool()).await.context(h!())?;
    let Some(row) = row else {
        return Ok(());
    };
    if row
        .try_get::<String, _>("source_release_state")
        .context(h!())?
        == "released"
    {
        query::release_source_quota(db, job).await.context(h!())?;
        return Ok(());
    }
    let upload_id = row.try_get("file_upload_id").context(h!())?;
    let Some(spool) =
        runtime.spool.try_acquire_cleanup(upload_id).context(h!())?
    else {
        return Ok(());
    };
    let unsettled: bool = sqlx::query_scalar("select exists(select 1 from device_upload_finalization_attempt where job_id=$1 and (phase not in ('retired','selected') or write_credit_held))")
        .bind(job).fetch_one(db.get_postgres_connection_pool()).await.context(h!())?;
    anyhow::ensure!(
        !unsettled,
        "terminal source still has unsettled storage attempts"
    );
    let upload = repository::load_upload(db, upload_id)
        .await
        .context(h!())?
        .context(h!())?;
    if row.try_get::<String, _>("status").context(h!())? == "completed" {
        super::local_cache::retain_upload_best_effort(env, &upload, &spool)
            .await;
    }
    spool.remove_durable_source().await.context(h!())?;
    crate::devices::upload_finalization::fault::point(
        "file_source_removed",
        job,
    )
    .await;
    repository::mark_spool_removed(db, upload_id, Utc::now().fixed_offset())
        .await
        .context(h!())?;
    cleanup::source_removed(db, job).await.context(h!())
}

async fn attempt_batch(
    runtime: &DeviceFileContentRuntime,
    sweep: &mut AttemptSweep,
    timeout: Duration,
) -> Result<()> {
    let db = runtime.file_registry_db.connection();
    let limit =
        i64::try_from(runtime.config.cleanup_batch_size).context(h!())?;
    let horizon = match sweep.horizon {
        Some(horizon) => horizon,
        None => {
            let horizon = sqlx::query_scalar("select clock_timestamp()")
                .fetch_one(db.get_postgres_connection_pool())
                .await
                .context(h!())?;
            sweep.horizon = Some(horizon);
            horizon
        }
    };
    let rows = if let Some((cleanup_next_at, id)) = sweep.cursor {
        sqlx::query("select id,cleanup_next_at from device_upload_finalization_attempt where kind='file' and phase='retired' and cleanup_next_at<=$3 and (cleanup_next_at,id)>($1,$2) order by cleanup_next_at,id limit $4")
            .bind(cleanup_next_at).bind(id).bind(horizon).bind(limit)
            .fetch_all(db.get_postgres_connection_pool()).await.context(h!())?
    } else {
        sqlx::query("select id,cleanup_next_at from device_upload_finalization_attempt where kind='file' and phase='retired' and cleanup_next_at<=$1 order by cleanup_next_at,id limit $2")
            .bind(horizon).bind(limit).fetch_all(db.get_postgres_connection_pool()).await.context(h!())?
    };
    if rows.is_empty() {
        *sweep = AttemptSweep::default();
    }
    for row in rows {
        let id = row.try_get("id").context(h!())?;
        sweep.cursor =
            Some((row.try_get("cleanup_next_at").context(h!())?, id));
        if let Err(error) = runtime
            .managed_storage
            .cleanup_retired(db, id, timeout)
            .await
        {
            log::warn!(
                "file finalization retired object cleanup failed: {error:#}"
            );
        }
    }
    Ok(())
}

#[cfg(test)]
#[derive(Default)]
pub(super) struct TestAttemptSweep {
    sweep: AttemptSweep,
}

#[cfg(test)]
impl TestAttemptSweep {
    pub(super) async fn run(
        &mut self,
        runtime: &DeviceFileContentRuntime,
    ) -> Result<()> {
        attempt_batch(runtime, &mut self.sweep, Duration::from_secs(5)).await
    }
}
