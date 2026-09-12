use std::time::Duration as StdDuration;

use anyhow::{Context, Result};
use chrono::Utc;
use sqlx::pool::PoolConnection;
use sqlx::{Postgres, Row};
use tokio_util::sync::CancellationToken;

use super::repository::{self, UploadStatus};
use super::DeviceFileContentRuntime;
use crate::h;
use crate::types::{error, warn};

const CLEANUP_LOCK_SQL: &str = "select pg_try_advisory_lock(hashtextextended('echo:device-file-content-cleanup', 0)) as acquired";

pub(crate) async fn run_nofail(
    runtime: std::sync::Arc<DeviceFileContentRuntime>,
    cancellation: CancellationToken,
) {
    loop {
        if cancellation.is_cancelled() {
            return;
        }
        match acquire_lease(&runtime, &cancellation).await {
            Ok(Some(mut lease)) => {
                if let Err(error) =
                    run_with_lease(&runtime, &cancellation, &mut lease).await
                {
                    error!("device content cleanup worker failed: {error:#?}");
                }
            }
            Ok(None) => {}
            Err(error) => {
                error!("device content cleanup lease failed: {error:#?}");
                record_failure(&runtime);
            }
        }
        tokio::select! {
            _ = cancellation.cancelled() => return,
            _ = tokio::time::sleep(StdDuration::from_secs(
                runtime.config.cleanup_poll_interval_secs,
            )) => {}
        }
    }
}

async fn acquire_lease(
    runtime: &DeviceFileContentRuntime,
    cancellation: &CancellationToken,
) -> Result<Option<PoolConnection<Postgres>>> {
    let acquire = runtime
        .file_registry_db
        .connection()
        .get_postgres_connection_pool()
        .acquire();
    let mut connection = tokio::select! {
        _ = cancellation.cancelled() => return Ok(None),
        connection = acquire => connection
            .context("acquire content cleanup lease connection")
            .context(h!())?,
    };
    connection.close_on_drop();
    let row = sqlx::query(CLEANUP_LOCK_SQL)
        .fetch_one(&mut *connection)
        .await
        .context("acquire content cleanup advisory lock")
        .context(h!())?;
    if row.try_get::<bool, _>("acquired").context(h!())? {
        Ok(Some(connection))
    } else {
        Ok(None)
    }
}

async fn run_with_lease(
    runtime: &DeviceFileContentRuntime,
    cancellation: &CancellationToken,
    lease: &mut PoolConnection<Postgres>,
) -> Result<()> {
    let mut cursor = None;
    loop {
        if cancellation.is_cancelled() {
            return Ok(());
        }
        sqlx::query("select 1")
            .execute(&mut **lease)
            .await
            .context("heartbeat content cleanup lease")
            .context(h!())?;
        let now = Utc::now().fixed_offset();
        let candidates = repository::list_cleanup_candidates(
            runtime.file_registry_db.connection(),
            cursor,
            now,
            runtime.config.cleanup_batch_size,
        )
        .await
        .context(h!())?;
        if candidates.is_empty() {
            cursor = None;
            tokio::select! {
                _ = cancellation.cancelled() => return Ok(()),
                _ = tokio::time::sleep(StdDuration::from_secs(
                    runtime.config.cleanup_poll_interval_secs,
                )) => {}
            }
            continue;
        }
        for candidate in candidates {
            cursor = Some((candidate.next_cleanup_at, candidate.id));
            if let Err(error) = cleanup_one(runtime, candidate.id).await {
                warn!(
                    "device content cleanup failed for {}: {error:#?}",
                    candidate.id
                );
                record_failure(runtime);
                let now = Utc::now().fixed_offset();
                let retry_at = repository::deadline_after(
                    now,
                    runtime.config.cleanup_retry_delay_secs,
                )
                .context(h!())?;
                match repository::schedule_cleanup_retry(
                    runtime.file_registry_db.connection(),
                    candidate.id,
                    now,
                    retry_at,
                )
                .await
                {
                    Ok(true) => {
                        super::record_terminal(runtime, UploadStatus::Expired)
                    }
                    Ok(false) => {}
                    Err(schedule_error) => {
                        warn!(
                            "failed to schedule device content cleanup retry for {}: {schedule_error:#?}",
                            candidate.id
                        );
                    }
                }
            }
        }
    }
}

fn record_failure(runtime: &DeviceFileContentRuntime) {
    if let Some(metrics) = &runtime.metrics {
        metrics.record_device_file_content_failure("cleanup");
    }
}

async fn cleanup_one(
    runtime: &DeviceFileContentRuntime,
    upload_id: uuid::Uuid,
) -> Result<()> {
    let Some(locked) =
        runtime.spool.try_acquire_cleanup(upload_id).context(h!())?
    else {
        return Ok(());
    };
    let now = Utc::now().fixed_offset();
    let expired = repository::expire_if_due(
        runtime.file_registry_db.connection(),
        upload_id,
        now,
    )
    .await
    .context(h!())?;
    if expired {
        super::record_terminal(runtime, UploadStatus::Expired);
    }
    let Some(upload) = repository::load_upload(
        runtime.file_registry_db.connection(),
        upload_id,
    )
    .await
    .context(h!())?
    else {
        locked.remove_local().await.context(h!())?;
        return Ok(());
    };
    if upload.status == UploadStatus::Open {
        return Ok(());
    }

    locked.remove_local().await.context(h!())?;
    repository::mark_spool_removed(
        runtime.file_registry_db.connection(),
        upload.id,
        now,
    )
    .await
    .context(h!())?;
    if upload.status == UploadStatus::Completed {
        return Ok(());
    }
    if repository::object_is_referenced(
        runtime.file_registry_db.connection(),
        &upload.object_key,
    )
    .await
    .context(h!())?
    {
        return Err(anyhow::anyhow!("uncommitted upload object is referenced"));
    }
    crate::storage::delete_device_content_object(
        &runtime.storage,
        &upload.object_key,
    )
    .await
    .map_err(anyhow::Error::new)
    .context(h!())?;
    repository::delete_uncommitted_upload(
        runtime.file_registry_db.connection(),
        upload.id,
    )
    .await
    .context(h!())?;
    Ok(())
}

#[cfg(test)]
pub(crate) async fn cleanup_one_for_test(
    runtime: &DeviceFileContentRuntime,
    upload_id: uuid::Uuid,
) -> Result<()> {
    cleanup_one(runtime, upload_id).await
}
