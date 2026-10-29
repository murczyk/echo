use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use sqlx::Row;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{pin::LockedSource, DeviceAudioRuntime};
use crate::devices::upload_finalization::{
    cleanup, query,
    types::{FinalizationKind, FinalizationStatus},
};
use crate::h;
use crate::types::Env;

type Cursor = Option<(DateTime<Utc>, Uuid)>;

pub(super) async fn reconcile_orphan(
    runtime: &DeviceAudioRuntime,
    device: Uuid,
    upload: Uuid,
) -> Result<()> {
    let db = runtime.file_database().context(h!())?;
    let Some(source) = LockedSource::orphan(runtime, device, upload)
        .await
        .context(h!())?
    else {
        return Ok(());
    };
    let mut transaction = db
        .get_postgres_connection_pool()
        .begin()
        .await
        .context(h!())?;
    sqlx::query("select pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("device-finalization:audio:{device}/{upload}"))
        .execute(&mut *transaction)
        .await
        .context(h!())?;
    let marker = source.marker();
    let retained = sqlx::query_scalar::<_, sqlx::types::Json<query::JobRecord>>("select to_jsonb(j) from device_upload_finalization_job j where (kind='audio' and source_identity=$1) or id=$2")
        .bind(&marker.source_identity).bind(marker.job_id)
        .fetch_all(&mut *transaction).await.context(h!())?;
    match retained.as_slice() {
        [] => {
            anyhow::ensure!(
                source.open_source().context(h!())?.is_some(),
                "audio orphan source is unavailable"
            );
            source.release_unaccepted().context(h!())?;
        }
        [sqlx::types::Json(job)]
            if marker.matches(job)
                && job.kind == FinalizationKind::FinalizationAudioKind
                && matches!(
                    job.status,
                    FinalizationStatus::FinalizationCompleted
                        | FinalizationStatus::FinalizationFailed
                )
                && job.source_release_state == "released"
                && job.quota_released_at.is_some() =>
        {
            source.clear_released_proof().context(h!())?;
        }
        _ => {}
    }
    transaction.commit().await.context(h!())?;
    Ok(())
}

pub(in crate::devices) async fn run_nofail(
    env: Arc<Env>,
    runtime: Arc<DeviceAudioRuntime>,
    cancellation: CancellationToken,
) {
    tokio::join!(
        source_loop(&env, &runtime, &cancellation),
        attempt_loop(&env, &runtime, &cancellation),
        orphan_loop(&env, &runtime, &cancellation, "pins"),
        orphan_loop(&env, &runtime, &cancellation, "locks"),
    );
}

async fn orphan_loop(
    env: &Env,
    runtime: &DeviceAudioRuntime,
    cancellation: &CancellationToken,
    directory: &'static str,
) {
    let mut scan = orphan_scan(runtime, directory);
    loop {
        let mut pause = false;
        for _ in 0..crate::config::DEVICE_UPLOAD_FINALIZATION_ORPHAN_SCAN_BATCH
        {
            let entry = tokio::select! {
                biased;
                _ = cancellation.cancelled() => return,
                entry = async { scan.next() } => entry,
            };
            let Some(entry) = entry else {
                scan = orphan_scan(runtime, directory);
                pause = true;
                break;
            };
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    if error.io_error().is_some_and(|error| {
                        error.kind() != std::io::ErrorKind::NotFound
                    }) {
                        log::warn!(
                            "audio orphan {directory} scan deferred: {error}"
                        );
                    }
                    pause = true;
                    continue;
                }
            };
            if entry.depth() != 4 || !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            let Some(parent) = path.parent() else {
                continue;
            };
            if parent.file_name().is_some_and(|name| name == "locks")
                && entry.metadata().is_ok_and(|metadata| metadata.len() == 0)
            {
                continue;
            }
            let Some(root) = parent.parent() else {
                continue;
            };
            let Some(device) = super::pin::audio_device(root) else {
                continue;
            };
            let name = if parent.file_name().is_some_and(|name| name == "pins")
            {
                path.file_stem()
            } else {
                path.file_name()
            };
            let Some(upload) = name
                .and_then(|name| name.to_str())
                .and_then(|name| Uuid::parse_str(name).ok())
            else {
                continue;
            };
            pause = true;
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => return,
                result = reconcile_orphan(runtime, device, upload) => {
                    if let Err(error) = result { log::warn!("audio orphan pin recovery deferred: {error:#}"); }
                }
            }
        }
        if !pause {
            tokio::task::yield_now().await;
            continue;
        }
        tokio::select! {
            _ = cancellation.cancelled() => return,
            _ = tokio::time::sleep(Duration::from_secs(poll_seconds(env))) => {}
        }
    }
}

fn orphan_scan(
    runtime: &DeviceAudioRuntime,
    directory: &'static str,
) -> impl Iterator<Item = walkdir::Result<walkdir::DirEntry>> {
    walkdir::WalkDir::new(runtime.storage_dir.join("device-audio-tus"))
        .max_depth(4)
        .follow_links(false)
        .into_iter()
        .filter_entry(move |entry| {
            entry.depth() != 3 || entry.file_name() == directory
        })
}

async fn source_loop(
    env: &Env,
    runtime: &DeviceAudioRuntime,
    cancellation: &CancellationToken,
) {
    let mut cursor = None;
    loop {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return,
            result = source_batch(env, runtime, &mut cursor) => {
                if let Err(error) = result { log::warn!("audio finalization source cleanup deferred: {error:#}"); }
            }
        }
        tokio::select! {
            _ = cancellation.cancelled() => return,
            _ = tokio::time::sleep(Duration::from_secs(poll_seconds(env))) => {}
        }
    }
}

async fn attempt_loop(
    env: &Env,
    runtime: &DeviceAudioRuntime,
    cancellation: &CancellationToken,
) {
    let mut cursor = None;
    let timeout = Duration::from_secs(
        env.config
            .device_upload_finalization
            .as_ref()
            .filter(|settings| settings.is_valid())
            .map_or(
                crate::config::DEVICE_UPLOAD_FINALIZATION_AUDIO_PHASE_SECONDS,
                |settings| settings.audio_phase_seconds,
            ),
    );
    loop {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return,
            result = attempt_batch(runtime, &mut cursor, timeout) => {
                if let Err(error) = result { log::warn!("audio finalization object cleanup deferred: {error:#}"); }
            }
        }
        tokio::select! {
            _ = cancellation.cancelled() => return,
            _ = tokio::time::sleep(Duration::from_secs(poll_seconds(env))) => {}
        }
    }
}

async fn source_batch(
    _env: &Env,
    runtime: &DeviceAudioRuntime,
    cursor: &mut Cursor,
) -> Result<()> {
    let db = runtime.file_database().context(h!())?;
    let limit =
        i64::try_from(super::DEVICE_AUDIO_CLEANUP_BATCH).context(h!())?;
    let rows = if let Some((updated_at, id)) = cursor {
        sqlx::query("select id,updated_at from device_upload_finalization_job where kind='audio' and status in ('completed','failed') and quota_released_at is null and (updated_at,id)>($1,$2) order by updated_at,id limit $3")
            .bind(*updated_at).bind(*id).bind(limit)
            .fetch_all(db.get_postgres_connection_pool()).await.context(h!())?
    } else {
        sqlx::query("select id,updated_at from device_upload_finalization_job where kind='audio' and status in ('completed','failed') and quota_released_at is null order by updated_at,id limit $1")
            .bind(limit).fetch_all(db.get_postgres_connection_pool()).await.context(h!())?
    };
    if rows.is_empty() {
        *cursor = None;
    }
    for row in rows {
        let id = row.try_get("id").context(h!())?;
        *cursor = Some((row.try_get("updated_at").context(h!())?, id));
        if let Err(error) = cleanup_source(runtime, id).await {
            log::warn!("audio finalization source cleanup failed: {error:#}");
        }
    }
    Ok(())
}

pub(in crate::devices) async fn cleanup_source(
    runtime: &DeviceAudioRuntime,
    job: Uuid,
) -> Result<()> {
    let db = runtime.file_database().context(h!())?;
    let row = sqlx::query("select source_release_state,winning_attempt_id from device_upload_finalization_job where id=$1 and kind='audio' and status in ('completed','failed')")
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
    let (record, _) = query::read_job(db, job)
        .await
        .context(h!())?
        .context(h!())?;
    let source = LockedSource::recover(runtime, &record)
        .await
        .context(h!())?;
    let unsettled: bool = sqlx::query_scalar("select exists(select 1 from device_upload_finalization_attempt where job_id=$1 and (phase not in ('retired','selected') or write_credit_held))")
        .bind(job).fetch_one(db.get_postgres_connection_pool()).await.context(h!())?;
    anyhow::ensure!(
        !unsettled,
        "terminal source still has unsettled storage attempts"
    );
    source.remove_source().context(h!())?;
    crate::devices::upload_finalization::fault::point(
        "audio_source_removed",
        job,
    )
    .await;
    if let Some(attempt) = row
        .try_get::<Option<Uuid>, _>("winning_attempt_id")
        .context(h!())?
    {
        super::query::record_consumed(runtime, attempt)
            .await
            .context(h!())?;
    }
    cleanup::source_removed(db, job).await.context(h!())?;
    source.clear_released_proof().context(h!())
}

fn poll_seconds(env: &Env) -> u64 {
    env.config
        .device_upload_finalization
        .as_ref()
        .filter(|settings| settings.is_valid())
        .map_or(
            crate::config::DEVICE_UPLOAD_FINALIZATION_POLL_SECONDS,
            |settings| settings.poll_seconds,
        )
}

async fn attempt_batch(
    runtime: &DeviceAudioRuntime,
    cursor: &mut Cursor,
    timeout: Duration,
) -> Result<()> {
    let db = runtime.file_database().context(h!())?;
    let limit =
        i64::try_from(super::DEVICE_AUDIO_CLEANUP_BATCH).context(h!())?;
    let rows = if let Some((cleanup_next_at, id)) = cursor {
        sqlx::query("select id,cleanup_next_at from device_upload_finalization_attempt where kind='audio' and phase='retired' and cleanup_next_at<=statement_timestamp() and (cleanup_next_at,id)>($1,$2) order by cleanup_next_at,id limit $3")
            .bind(*cleanup_next_at).bind(*id).bind(limit)
            .fetch_all(db.get_postgres_connection_pool()).await.context(h!())?
    } else {
        sqlx::query("select id,cleanup_next_at from device_upload_finalization_attempt where kind='audio' and phase='retired' and cleanup_next_at<=statement_timestamp() order by cleanup_next_at,id limit $1")
            .bind(limit).fetch_all(db.get_postgres_connection_pool()).await.context(h!())?
    };
    if rows.is_empty() {
        *cursor = None;
    }
    for row in rows {
        let id = row.try_get("id").context(h!())?;
        *cursor = Some((row.try_get("cleanup_next_at").context(h!())?, id));
        if let Err(error) = runtime
            .managed_storage
            .as_ref()
            .context(h!())?
            .cleanup_retired(db, id, timeout)
            .await
        {
            log::warn!(
                "audio finalization retired object cleanup failed: {error:#}"
            );
        }
    }
    Ok(())
}
