use std::io::Read;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use openssl::sha::Sha256;
use tokio::io::AsyncReadExt;

use super::{repository, DeviceFileContentRuntime, LockedSpool};
use crate::devices::config::DEVICE_FILE_CONTENT_ENCRYPTION_MAX_BYTES;
use crate::devices::upload_finalization::{
    self, cleanup, query, recovery,
    resources::{self, OperationGuard, ResourceGuard, ResourceKind},
    types::*,
};
use crate::error::AppError;
use crate::h;
use crate::storage::finalization::{
    ManagedObject, ManagedPayload, ManagedWriteOutcome,
};
use crate::types::{DeviceUploadFinalizationSettings, Env};

pub(super) async fn execute(
    env: &Env,
    runtime: &DeviceFileContentRuntime,
    claim: ClaimedFinalizationJob,
) -> Result<()> {
    let env = env.clone();
    let runtime = runtime.clone();
    // Cancellation of a waiter must not release source or heavy-work guards.
    resources::spawn_task(async move {
        let settings = env.config.device_upload_finalization.clone()
            .filter(DeviceUploadFinalizationSettings::is_valid).unwrap_or_default();
        if let Err(error) = execute_owned(&env, &runtime, &claim, &settings).await {
            let failure = error.downcast_ref::<FinalizationFailure>().copied()
                .unwrap_or(FinalizationFailure::DependencyUnavailable);
            let permanent = matches!(failure, FinalizationFailure::SourceDigestMismatch
                | FinalizationFailure::SourceLost | FinalizationFailure::TargetRevisionChanged
                | FinalizationFailure::TargetUnavailable | FinalizationFailure::PublicationForbidden);
            let db = runtime.file_registry_db.connection();
            if permanent && cleanup::fail_file(db, &claim, failure).await.context(h!())? {
                return Ok(());
            }
            if failure != FinalizationFailure::StaleClaim {
                let attempts: i64 = sqlx::query_scalar("select attempt_count from device_upload_finalization_job where id=$1")
                    .bind(claim.job_id).fetch_one(db.get_postgres_connection_pool()).await.context(h!())?;
                recovery::schedule_retry(db, &claim, &failure,
                    claim.requires_reconciliation || failure == FinalizationFailure::StorageOutcomeUnknown,
                    recovery::retry_delay(&settings, attempts, None)).await.context(h!())?;
            }
            log::warn!("file finalization deferred: {error:#}");
        }
        Ok(())
    }).await.context(h!())?
}

async fn execute_owned(
    env: &Env,
    runtime: &DeviceFileContentRuntime,
    claim: &ClaimedFinalizationJob,
    settings: &DeviceUploadFinalizationSettings,
) -> Result<()> {
    let file_guard =
        slot(env, ResourceKind::File, settings.file_slots, settings)
            .await
            .context(h!())?;
    let db = runtime.file_registry_db.connection();
    let (job, _) = query::read_job(db, claim.job_id)
        .await
        .context(h!())?
        .context(h!())?;
    anyhow::ensure!(
        job.kind == FinalizationKind::FinalizationFileKind,
        FinalizationFailure::CommandConflict
    );
    let upload_id = job.file_upload_id.context(h!())?;
    let spool = runtime
        .spool
        .try_acquire_cleanup(upload_id)
        .context(h!())?
        .ok_or(FinalizationFailure::CapacityUnavailable)
        .context(h!())?;
    anyhow::ensure!(
        query::is_current(db, claim).await.context(h!())?,
        FinalizationFailure::StaleClaim
    );
    if query::exact_publication(db, claim).await.context(h!())? {
        // This adapter publishes the receipt and the job in the same transaction.
        anyhow::ensure!(
            job.status == FinalizationStatus::FinalizationCompleted,
            FinalizationFailure::StorageOutcomeUnknown
        );
        return Ok(());
    }
    let upload = repository::load_upload(db, upload_id)
        .await
        .context(h!())?
        .ok_or(FinalizationFailure::TargetUnavailable)
        .context(h!())?;
    let owner: OperationGuard = Arc::new((file_guard.clone(), spool.clone()));
    let verified = if query::active_object(db, claim)
        .await
        .context(h!())?
        .is_some()
    {
        let guard = slot(
            env,
            ResourceKind::Readback,
            settings.readback_slots,
            settings,
        )
        .await
        .context(h!())?
        .with_owner(owner.clone());
        match runtime
            .managed_storage
            .clone()
            .reconcile(
                db,
                claim,
                guard,
                Duration::from_secs(settings.file_phase_seconds),
            )
            .await
            .context(h!())?
        {
            recovery::Reconciliation::Verified(object) => object,
            _ => return Err(FinalizationFailure::StorageOutcomeUnknown.into()),
        }
    } else {
        if claim.requires_reconciliation {
            if recovery::retry_not_dispatched(db, claim)
                .await
                .context(h!())?
            {
                return Ok(());
            }
            return Err(FinalizationFailure::StorageOutcomeUnknown.into());
        }
        cleanup::retire_unwritten(db, claim).await.context(h!())?;
        let encrypted = prepare_source(
            runtime,
            &spool,
            &upload,
            file_guard.clone(),
            settings,
        )
        .await
        .context(h!())?;
        store_and_verify(
            env,
            runtime,
            claim,
            &spool,
            PreparedSource {
                upload: &upload,
                encrypted,
            },
            settings,
            owner,
        )
        .await
        .context(h!())?
    };
    upload_finalization::fault::point("storage_verified", claim.job_id).await;
    publish(
        env,
        runtime,
        claim,
        job.created_by_login_id,
        upload.device_id,
        &verified,
    )
    .await
    .context(h!())?;
    upload_finalization::fault::point(
        "file_publication_committed",
        claim.job_id,
    )
    .await;
    Ok(())
}

async fn slot(
    env: &Env,
    kind: ResourceKind,
    count: usize,
    settings: &DeviceUploadFinalizationSettings,
) -> Result<ResourceGuard> {
    resources::acquire_file(
        Path::new(&env.config.storage_dir),
        kind,
        count,
        Duration::from_secs(settings.file_phase_seconds),
    )
    .await
    .context(h!())
}

async fn prepare_source(
    runtime: &DeviceFileContentRuntime,
    spool: &LockedSpool,
    upload: &repository::Upload,
    guard: ResourceGuard,
    settings: &DeviceUploadFinalizationSettings,
) -> Result<bool> {
    let file = match spool.open_durable_source().context(h!())? {
        Some(file) => Some(file.into_std().await),
        None if upload.upload_length == 0 => None,
        None => return Err(FinalizationFailure::DependencyUnavailable.into()),
    };
    let spool = spool.clone();
    let length = upload.upload_length;
    let expected = upload.expected_sha256;
    let probe_limit = runtime.config.probe_size_bytes;
    let cancellation = resources::shutdown_cancellation();
    let operation = resources::spawn_blocking_owned(
        guard,
        move || -> Result<bool> {
            let _spool = spool;
            let mut source: Box<dyn Read> = match file {
                Some(file) => Box::new(file),
                None => Box::new(std::io::empty()),
            };
            let mut digest = Sha256::new();
            let mut buffer = vec![0; crate::devices::config::DEVICE_FILE_CONTENT_STREAM_CHUNK_BYTES];
            let mut size = 0_u64;
            let mut probe = Vec::with_capacity(probe_limit);
            loop {
                anyhow::ensure!(
                    !cancellation.is_cancelled(),
                    "finalization shutdown"
                );
                let count = source.read(&mut buffer).context(h!())?;
                if count == 0 {
                    break;
                }
                size = size.checked_add(count as u64).context(h!())?;
                anyhow::ensure!(
                    size <= length,
                    FinalizationFailure::SourceDigestMismatch
                );
                let take = count.min(probe_limit.saturating_sub(probe.len()));
                probe.extend_from_slice(&buffer[..take]);
                digest.update(&buffer[..count]);
            }
            anyhow::ensure!(
                size == length && digest.finish() == expected,
                FinalizationFailure::SourceDigestMismatch
            );
            Ok(length <= DEVICE_FILE_CONTENT_ENCRYPTION_MAX_BYTES
            && !crate::messenger::media::device_content_probe_is_excluded_video(&probe))
        },
    );
    tokio::time::timeout(
        Duration::from_secs(settings.file_phase_seconds),
        operation,
    )
    .await
    .context(h!())?
    .context(h!())?
    .context(h!())
}

struct PreparedSource<'a> {
    upload: &'a repository::Upload,
    encrypted: bool,
}

async fn store_and_verify(
    env: &Env,
    runtime: &DeviceFileContentRuntime,
    claim: &ClaimedFinalizationJob,
    spool: &LockedSpool,
    source: PreparedSource<'_>,
    settings: &DeviceUploadFinalizationSettings,
    owner: OperationGuard,
) -> Result<VerifiedFinalizationObject> {
    let PreparedSource { upload, encrypted } = source;
    let db = runtime.file_registry_db.connection();
    let attempt = query::create_attempt(db, claim, encrypted)
        .await
        .context(h!())?;
    anyhow::ensure!(
        query::prepare_attempt(
            db,
            claim,
            attempt,
            i64::try_from(upload.upload_length).context(h!())?,
            &upload.expected_sha256,
            None
        )
        .await
        .context(h!())?,
        FinalizationFailure::StaleClaim
    );
    let object = ManagedObject {
        attempt_id: attempt,
        object_key: format!("device-file-finalization/{}/{attempt}", upload.id),
        size: upload.upload_length,
        sha256: upload.expected_sha256,
        is_encrypted: encrypted,
    };
    let payload =
        payload(env, runtime, spool, object.clone(), settings, owner.clone())
            .await
            .context(h!())?;
    let readback = slot(
        env,
        ResourceKind::Readback,
        settings.readback_slots,
        settings,
    )
    .await
    .context(h!())?
    .with_owner(owner);
    let timeout = Duration::from_secs(settings.file_phase_seconds);
    match runtime
        .managed_storage
        .clone()
        .dispatch(
            db.clone(),
            claim.clone(),
            object.clone(),
            payload,
            readback.clone(),
            settings.file_unresolved_writes,
            timeout,
        )
        .await
        .context(h!())?
    {
        ManagedWriteOutcome::Acknowledged => {}
        ManagedWriteOutcome::DefinitelyNotDispatched(error) => {
            return Err(error).context(h!())
        }
        ManagedWriteOutcome::PossiblyDispatched(error) => {
            log::warn!("managed file write requires reconciliation: {error:#}");
            return Err(FinalizationFailure::StorageOutcomeUnknown.into());
        }
    }
    if let Err(error) = runtime
        .managed_storage
        .clone()
        .verify(object, readback, timeout)
        .await
        .context(h!())?
    {
        log::warn!("managed file readback requires reconciliation: {error:#}");
        return Err(FinalizationFailure::StorageOutcomeUnknown.into());
    }
    anyhow::ensure!(
        query::record_verified(db, claim, attempt)
            .await
            .context(h!())?,
        FinalizationFailure::StaleClaim
    );
    query::active_object(db, claim)
        .await
        .context(h!())?
        .context(h!())
}

async fn payload(
    env: &Env,
    runtime: &DeviceFileContentRuntime,
    spool: &LockedSpool,
    object: ManagedObject,
    settings: &DeviceUploadFinalizationSettings,
    owner: OperationGuard,
) -> Result<ManagedPayload> {
    if !object.is_encrypted {
        return Ok(ManagedPayload::Plaintext(
            spool.open_durable_source().context(h!())?.context(h!())?,
        ));
    }
    let guard = slot(
        env,
        ResourceKind::Encryption,
        settings.encryption_slots,
        settings,
    )
    .await
    .context(h!())?
    .with_owner(owner);
    let mut bytes =
        Vec::with_capacity(usize::try_from(object.size).context(h!())?);
    if let Some(file) = spool.open_durable_source().context(h!())? {
        tokio::time::timeout(
            Duration::from_secs(settings.file_phase_seconds),
            file.take(object.size.checked_add(1).context(h!())?)
                .read_to_end(&mut bytes),
        )
        .await
        .context(h!())?
        .context(h!())?;
    }
    let encrypted =
        runtime.managed_storage.encrypt(object, bytes.into(), guard);
    let bytes = tokio::time::timeout(
        Duration::from_secs(settings.file_phase_seconds),
        encrypted,
    )
    .await
    .context(h!())?
    .context(h!())?
    .context(h!())?;
    Ok(ManagedPayload::Encrypted(bytes))
}

async fn publish(
    env: &Env,
    runtime: &DeviceFileContentRuntime,
    claim: &ClaimedFinalizationJob,
    actor: uuid::Uuid,
    device: uuid::Uuid,
    verified: &VerifiedFinalizationObject,
) -> Result<()> {
    if let Err(error) = upload_finalization::authorize_write(
        env,
        actor,
        device,
        FinalizationKind::FinalizationFileKind,
    )
    .await
    {
        return Err(match error {
            AppError::Unauthenticated
            | AppError::Forbidden(_)
            | AppError::ForbiddenWithHeader { .. } => {
                FinalizationFailure::PublicationForbidden.into()
            }
            AppError::NotFound | AppError::Form(_) => {
                FinalizationFailure::TargetUnavailable.into()
            }
            error => anyhow::Error::new(error).context(h!()),
        });
    }
    let db = runtime.file_registry_db.connection();
    let mut transaction = db
        .get_postgres_connection_pool()
        .begin()
        .await
        .context(h!())?;
    repository::publish_file_in(&mut transaction, claim, verified)
        .await
        .context(h!())?;
    if let Err(error) = transaction.commit().await {
        log::warn!(
            "file publication commit requires reconciliation: {error:#}"
        );
        return Err(FinalizationFailure::StorageOutcomeUnknown.into());
    }
    Ok(())
}
