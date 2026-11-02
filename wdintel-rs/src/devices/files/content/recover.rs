use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result};
use chrono::Utc;
use sea_orm::DatabaseConnection;
use uuid::Uuid;

use super::repository::{self, RevalidateOutcome, Upload, UploadStatus};
use super::spool::LockedSpool;
use super::DeviceFileContentRuntime;
use crate::devices::config::{
    DEVICE_FILE_CONTENT_RECOVERY_BUSY_MAX_WAITS,
    DEVICE_FILE_CONTENT_RECOVERY_BUSY_WAIT_SECS, DEVICE_FILE_CONTENT_SPOOL_DIR,
};
use crate::devices::upload_finalization::{query, types::FinalizationStatus};
use crate::h;
use crate::types::DeviceUploadFinalizationSettings;

enum Outcome {
    Busy,
    Orphan,
    Owned {
        job: Uuid,
        status: FinalizationStatus,
    },
    Terminal(UploadStatus),
    Incomplete {
        offset: u64,
        length: u64,
    },
    TargetChanged,
    WouldAdmit {
        revive: bool,
    },
    NotRevived,
    AlreadyCommitted,
    Failed(String),
    Unavailable(String),
    Admitted {
        job: Uuid,
        revived: bool,
    },
}

impl std::fmt::Display for Outcome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Busy => write!(f, "skipped: source locked by a request"),
            Self::Orphan => write!(f, "skipped: no upload row"),
            Self::Owned { job, status } => {
                write!(f, "skipped: owned by job {job} ({status:?})")
            }
            Self::Terminal(status) => {
                write!(f, "skipped: status {}", status.database_value())
            }
            Self::Incomplete { offset, length } => {
                write!(f, "skipped: incomplete {offset}/{length} bytes")
            }
            Self::TargetChanged => {
                write!(f, "skipped: target revision changed or has content")
            }
            Self::WouldAdmit { revive } => {
                write!(f, "would admit (revive: {revive})")
            }
            Self::NotRevived => write!(f, "skipped: reopen lost a race"),
            Self::AlreadyCommitted => write!(f, "skipped: content committed"),
            Self::Failed(error) => write!(f, "admission failed: {error}"),
            Self::Unavailable(error) => {
                write!(f, "admission still unavailable: {error}")
            }
            Self::Admitted { job, revived } => {
                write!(f, "admitted as job {job} (revived: {revived})")
            }
        }
    }
}

struct Recovery<'a> {
    runtime: &'a DeviceFileContentRuntime,
    settings: DeviceUploadFinalizationSettings,
    apply: bool,
}

/// Admits fully spooled device file uploads as async finalization jobs on
/// behalf of their creators; the bgworker verifies the SHA-256, writes the
/// object and publishes it. Due or expired uploads are reopened first. Uploads
/// that are busy, incomplete, stale or owned by an async job are reported and
/// left untouched.
pub(crate) async fn complete_spooled_oneoff(
    mode: crate::types::Mode,
    ps: crate::OneoffCompleteSpooledDeviceFilesPs,
) -> Result<(), crate::error::AppError> {
    Ok(complete_spooled(mode, ps).await.context(h!())?)
}

async fn complete_spooled(
    mode: crate::types::Mode,
    ps: crate::OneoffCompleteSpooledDeviceFilesPs,
) -> Result<()> {
    let env = crate::server::new_readonly_env(mode).await.context(h!())?;
    let runtime = env
        .device_file_content
        .as_deref()
        .context("device content runtime is unavailable")
        .context(h!())?;
    runtime.spool.preflight().context(h!())?;
    let settings = env
        .config
        .device_upload_finalization
        .clone()
        .unwrap_or_default();
    anyhow::ensure!(
        settings.enabled && settings.is_valid(),
        "[device_upload_finalization] must be enabled and valid"
    );
    let root =
        Path::new(&env.config.storage_dir).join(DEVICE_FILE_CONTENT_SPOOL_DIR);
    let mut upload_ids = if ps.upload_ids.is_empty() {
        list_spooled(&root).context(h!())?
    } else {
        ps.upload_ids
    };
    sort_by_size(&root, &mut upload_ids);
    if let Some(limit) = ps.limit {
        upload_ids.truncate(limit);
    }
    let recovery = Recovery {
        runtime,
        settings,
        apply: ps.apply,
    };
    run(&recovery, upload_ids).await
}

async fn run(recovery: &Recovery<'_>, upload_ids: Vec<Uuid>) -> Result<()> {
    let total = upload_ids.len();
    let mut failed = Vec::new();
    for (index, upload_id) in upload_ids.into_iter().enumerate() {
        let index = index + 1;
        match recover_when_free(recovery, upload_id).await {
            Ok(outcome) => {
                log::info!("[{index}/{total}] upload {upload_id}: {outcome}");
                if matches!(
                    outcome,
                    Outcome::Failed(_) | Outcome::Unavailable(_)
                ) {
                    failed.push(upload_id);
                }
            }
            Err(error) => {
                log::error!(
                    "[{index}/{total}] upload {upload_id} failed: {error:#}"
                );
                failed.push(upload_id);
            }
        }
    }
    if !failed.is_empty() {
        return Err(anyhow::anyhow!(
            "spooled upload recovery failed for {} of {total}: {failed:?}",
            failed.len()
        ));
    }
    log::info!(
        "inspected {total} spooled uploads{}",
        if recovery.apply { "" } else { " (dry run)" }
    );
    Ok(())
}

fn list_spooled(root: &Path) -> Result<Vec<Uuid>> {
    let mut upload_ids = Vec::new();
    for entry in std::fs::read_dir(root).context(h!())? {
        let path = entry.context(h!())?.path();
        if path.extension().and_then(|extension| extension.to_str())
            != Some("data")
        {
            continue;
        }
        match path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .and_then(|stem| Uuid::parse_str(stem).ok())
        {
            Some(upload_id) => upload_ids.push(upload_id),
            None => {
                log::warn!("skipping foreign spool file {}", path.display())
            }
        }
    }
    Ok(upload_ids)
}

/// Smallest spool files first, so more uploads fit into the budgets and finish
/// sooner. Missing files sort last and are reported by `recover_one`.
fn sort_by_size(root: &Path, upload_ids: &mut [Uuid]) {
    upload_ids.sort_by_cached_key(|upload_id| {
        let size = std::fs::metadata(root.join(format!("{upload_id}.data")))
            .map_or(u64::MAX, |metadata| metadata.len());
        (size, *upload_id)
    });
}

/// Finalization budgets free up as the bgworker releases sources, so a full
/// budget is waited out. The source lock is released between attempts so the
/// device and cleanup are not blocked while waiting.
async fn recover_when_free(
    recovery: &Recovery<'_>,
    upload_id: Uuid,
) -> Result<Outcome> {
    let mut waits = 0;
    loop {
        match recover_one(recovery, upload_id).await? {
            Outcome::Unavailable(_)
                if waits < DEVICE_FILE_CONTENT_RECOVERY_BUSY_MAX_WAITS =>
            {
                waits += 1;
                tokio::time::sleep(Duration::from_secs(
                    DEVICE_FILE_CONTENT_RECOVERY_BUSY_WAIT_SECS,
                ))
                .await;
            }
            outcome => return Ok(outcome),
        }
    }
}

async fn recover_one(
    recovery: &Recovery<'_>,
    upload_id: Uuid,
) -> Result<Outcome> {
    let db = recovery.runtime.file_registry_db.connection();
    // Holding the source lock excludes client PATCH/complete and cleanup.
    let Some(locked) = recovery
        .runtime
        .spool
        .try_acquire_cleanup(upload_id)
        .context(h!())?
    else {
        return Ok(Outcome::Busy);
    };
    let Some(upload) =
        repository::load_upload(db, upload_id).await.context(h!())?
    else {
        return Ok(Outcome::Orphan);
    };
    if let Some((job, _)) =
        query::read_file_job(db, upload_id).await.context(h!())?
    {
        return Ok(Outcome::Owned {
            job: job.id,
            status: job.status,
        });
    }
    if !matches!(upload.status, UploadStatus::Open | UploadStatus::Expired) {
        return Ok(Outcome::Terminal(upload.status));
    }
    let offset = locked.offset().context(h!())?;
    if offset != upload.upload_length {
        return Ok(Outcome::Incomplete {
            offset,
            length: upload.upload_length,
        });
    }
    if !target_is_current(db, &upload).await.context(h!())? {
        return Ok(Outcome::TargetChanged);
    }
    let now = Utc::now().fixed_offset();
    let revive = upload.status == UploadStatus::Expired
        || now >= upload.expires_at
        || now >= upload.hard_expires_at;
    if !recovery.apply {
        return Ok(Outcome::WouldAdmit { revive });
    }
    admit(recovery, &locked, upload, revive).await
}

async fn admit(
    recovery: &Recovery<'_>,
    locked: &LockedSpool,
    upload: Upload,
    revive: bool,
) -> Result<Outcome> {
    let runtime = recovery.runtime;
    let db = runtime.file_registry_db.connection();
    if revive
        && !repository::reopen_for_recovery(
            db,
            upload.id,
            runtime.config.upload_idle_ttl_secs,
        )
        .await
        .context(h!())?
    {
        return Ok(Outcome::NotRevived);
    }
    let upload = match repository::revalidate_open(
        db,
        &upload,
        Utc::now().fixed_offset(),
        runtime.metrics.as_ref(),
    )
    .await
    .context(h!())?
    {
        RevalidateOutcome::Open(upload) => upload,
        RevalidateOutcome::Terminal(status) => {
            return Ok(Outcome::Terminal(status))
        }
        RevalidateOutcome::Completed(_)
        | RevalidateOutcome::ContentAlreadyCommitted => {
            return Ok(Outcome::AlreadyCommitted)
        }
        RevalidateOutcome::Missing => return Ok(Outcome::Orphan),
    };
    // Admission pins the source, so it must survive a crash first.
    locked
        .make_durable(upload.upload_length)
        .await
        .context(h!())?;
    let actor: Uuid = sqlx::query_scalar(
        "select created_by_login_id from file_content_upload where id=$1",
    )
    .bind(upload.id)
    .fetch_one(db.get_postgres_connection_pool())
    .await
    .context(h!())?;
    Ok(
        match repository::admit_file(db, &upload, actor, &recovery.settings)
            .await
        {
            Ok(snapshot) => Outcome::Admitted {
                job: snapshot.job_id,
                revived: revive,
            },
            Err(error) if error.is_unavailable() => {
                Outcome::Unavailable(format!("{error:?}"))
            }
            Err(error) => Outcome::Failed(format!("{error:?}")),
        },
    )
}

async fn target_is_current(
    db: &DatabaseConnection,
    upload: &Upload,
) -> Result<bool> {
    sqlx::query_scalar("select exists(select 1 from file_entry where id=$1 and device_id=$2 and kind='file' and revision=$3 and content_path is null and archive_file_id is null) and not exists(select 1 from file_content where file_id=$1 and revision=$3)")
        .bind(upload.file_id).bind(upload.device_id).bind(upload.revision)
        .fetch_one(db.get_postgres_connection_pool()).await.context(h!())
}
