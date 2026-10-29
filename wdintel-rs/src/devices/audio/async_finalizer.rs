use std::{
    io::{Read, Write},
    path::Path,
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result};

use super::{
    pin::LockedSource, probe, DeviceAudioMediaError, DeviceAudioRuntime,
};
use crate::devices::upload_finalization::{
    cleanup, query, recovery,
    resources::{self, OperationGuard, ResourceGuard, ResourceKind},
    types::*,
};
use crate::{
    h,
    storage::finalization::{
        ManagedObject, ManagedPayload, ManagedWriteOutcome,
    },
    types::{DeviceUploadFinalizationSettings, Env},
};

pub(super) async fn execute(
    env: &Env,
    runtime: &DeviceAudioRuntime,
    claim: ClaimedFinalizationJob,
) -> Result<()> {
    let (env, runtime) = (env.clone(), runtime.clone());
    // The supervisor retains source and capacity guards if its waiter is cancelled.
    resources::spawn_task(async move {
        let settings = env.config.device_upload_finalization.clone()
            .filter(DeviceUploadFinalizationSettings::is_valid).unwrap_or_default();
        if let Err(error) = execute_owned(&env, &runtime, &claim, &settings).await {
            let failure = classify(&error);
            let db = runtime.file_database().context(h!())?;
            let permanent = matches!(failure, FinalizationFailure::InvalidAudio | FinalizationFailure::UnsupportedAudio
                | FinalizationFailure::AudioNameConflict | FinalizationFailure::SourceDigestMismatch
                | FinalizationFailure::PublicationForbidden | FinalizationFailure::TargetUnavailable);
            if permanent && cleanup::fail_audio(db, &claim, failure).await.context(h!())? { return Ok(()); }
            if failure != FinalizationFailure::StaleClaim {
                let attempts: i64 = sqlx::query_scalar("select attempt_count from device_upload_finalization_job where id=$1")
                    .bind(claim.job_id).fetch_one(db.get_postgres_connection_pool()).await.context(h!())?;
                recovery::schedule_retry(db, &claim, &failure,
                    claim.requires_reconciliation || failure == FinalizationFailure::StorageOutcomeUnknown,
                    recovery::retry_delay(&settings, attempts, None)).await.context(h!())?;
            }
            log::warn!("audio finalization deferred: {error:#}");
        }
        Ok(())
    }).await.context(h!())?
}

fn classify(error: &anyhow::Error) -> FinalizationFailure {
    if let Some(failure) = error.downcast_ref::<FinalizationFailure>() {
        return *failure;
    }
    if let Some(media) = error.downcast_ref::<DeviceAudioMediaError>() {
        return match media {
            DeviceAudioMediaError::UnsupportedMedia => {
                FinalizationFailure::UnsupportedAudio
            }
            DeviceAudioMediaError::InvalidAudio { .. } => {
                FinalizationFailure::InvalidAudio
            }
        };
    }
    FinalizationFailure::DependencyUnavailable
}

async fn execute_owned(
    env: &Env,
    runtime: &DeviceAudioRuntime,
    claim: &ClaimedFinalizationJob,
    settings: &DeviceUploadFinalizationSettings,
) -> Result<()> {
    let guard = slot(env, ResourceKind::Audio, settings.audio_slots, settings)
        .await
        .context(h!())?;
    let db = runtime.file_database().context(h!())?;
    let (job, _) = query::read_job(db, claim.job_id)
        .await
        .context(h!())?
        .context(h!())?;
    anyhow::ensure!(
        job.kind == FinalizationKind::FinalizationAudioKind,
        FinalizationFailure::CommandConflict
    );
    let source =
        Arc::new(LockedSource::recover(runtime, &job).await.context(h!())?);
    anyhow::ensure!(
        query::is_current(db, claim).await.context(h!())?,
        FinalizationFailure::StaleClaim
    );
    let owner: OperationGuard = Arc::new((guard, source.clone()));
    let storage = runtime.managed_storage.as_ref().context(h!())?;
    let timeout = Duration::from_secs(settings.audio_phase_seconds);
    let verified = if query::active_object(db, claim)
        .await
        .context(h!())?
        .is_some()
    {
        let readback = slot(
            env,
            ResourceKind::Readback,
            settings.readback_slots,
            settings,
        )
        .await
        .context(h!())?
        .with_owner(owner.clone());
        match storage
            .clone()
            .reconcile(db, claim, readback, timeout)
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
        let (bytes, media) =
            prepare(env, runtime, &job, source, owner.clone(), settings)
                .await
                .context(h!())?;
        store(
            env,
            runtime,
            claim,
            &job,
            bytes,
            media,
            settings,
            owner.clone(),
        )
        .await
        .context(h!())?
    };
    crate::devices::upload_finalization::fault::point(
        "storage_verified",
        claim.job_id,
    )
    .await;
    super::async_publication::publish(runtime, claim, &job, &verified)
        .await
        .context(h!())?;
    crate::devices::upload_finalization::fault::point(
        "audio_publication_committed",
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
    resources::acquire(
        Path::new(&env.config.storage_dir),
        kind,
        count,
        Duration::from_secs(settings.audio_phase_seconds),
    )
    .await
    .context(h!())
}

async fn prepare(
    env: &Env,
    runtime: &DeviceAudioRuntime,
    job: &query::JobRecord,
    source: Arc<LockedSource>,
    owner: OperationGuard,
    settings: &DeviceUploadFinalizationSettings,
) -> Result<(Vec<u8>, probe::ProbedAudio)> {
    let timeout = Duration::from_secs(settings.audio_phase_seconds);
    let size = u64::try_from(job.source_size_bytes).context(h!())?;
    let held = owner.clone();
    let cancellation = resources::shutdown_cancellation();
    let read = resources::spawn_blocking_task(move || -> Result<_> {
        let _held = held;
        let file = source
            .open_source()
            .context(h!())?
            .ok_or(FinalizationFailure::DependencyUnavailable)
            .context(h!())?;
        let bytes = read_source(file, size, &cancellation).context(h!())?;
        anyhow::ensure!(
            bytes.len() as u64 == size,
            FinalizationFailure::SourceDigestMismatch
        );
        let mut temporary = tempfile::NamedTempFile::new().context(h!())?;
        temporary.write_all(&bytes).context(h!())?;
        Ok((bytes, temporary))
    });
    let (bytes, temporary) = tokio::time::timeout(timeout, read)
        .await
        .context(h!())?
        .context(h!())?
        .context(h!())?;
    let path = temporary.path().to_path_buf();
    let admission: OperationGuard = Arc::new((owner, temporary));
    let decode =
        slot(env, ResourceKind::Decode, settings.decode_slots, settings)
            .await
            .context(h!())?;
    let media = tokio::time::timeout(
        timeout,
        probe::probe_with_resources(
            runtime,
            &path,
            job.recording_started_at.context(h!())?,
            Some(admission),
            Some(decode),
        ),
    )
    .await
    .context(h!())?
    .context(h!())?;
    Ok((bytes, media))
}

fn read_source(
    source: impl Read,
    size: u64,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<Vec<u8>> {
    let mut source = source.take(size.checked_add(1).context(h!())?);
    let mut bytes = Vec::with_capacity(usize::try_from(size).context(h!())?);
    let mut buffer = vec![0; super::DEVICE_AUDIO_PROCESS_READ_BYTES];
    loop {
        anyhow::ensure!(!cancellation.is_cancelled(), "finalization shutdown");
        let count = source.read(&mut buffer).context(h!())?;
        if count == 0 {
            return Ok(bytes);
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
}

#[allow(clippy::too_many_arguments)]
async fn store(
    env: &Env,
    runtime: &DeviceAudioRuntime,
    claim: &ClaimedFinalizationJob,
    job: &query::JobRecord,
    bytes: Vec<u8>,
    media: probe::ProbedAudio,
    settings: &DeviceUploadFinalizationSettings,
    owner: OperationGuard,
) -> Result<VerifiedFinalizationObject> {
    let db = runtime.file_database().context(h!())?;
    let storage = runtime.managed_storage.as_ref().context(h!())?;
    let attempt = query::create_attempt(db, claim, true).await.context(h!())?;
    let sha256 = openssl::sha::sha256(&bytes);
    let prepared = PreparedAudio {
        media_type: media.mime_type.into(),
        duration_seconds: media.duration_us as f64
            / super::DEVICE_AUDIO_MICROSECONDS_PER_SECOND as f64,
        recording_ended_at: media.recording_ended_at,
    };
    anyhow::ensure!(
        query::prepare_attempt(
            db,
            claim,
            attempt,
            job.source_size_bytes,
            &sha256,
            Some(&prepared)
        )
        .await
        .context(h!())?,
        FinalizationFailure::StaleClaim
    );
    let object = ManagedObject {
        attempt_id: attempt,
        object_key: format!(
            "device-audio/{}/{}/{attempt}",
            job.device_id,
            job.audio_id.context(h!())?
        ),
        size: u64::try_from(job.source_size_bytes).context(h!())?,
        sha256,
        is_encrypted: true,
    };
    let encryption = slot(
        env,
        ResourceKind::Encryption,
        settings.encryption_slots,
        settings,
    )
    .await
    .context(h!())?
    .with_owner(owner.clone());
    let timeout = Duration::from_secs(settings.audio_phase_seconds);
    let payload = tokio::time::timeout(
        timeout,
        storage.encrypt(object.clone(), bytes.into(), encryption),
    )
    .await
    .context(h!())?
    .context(h!())?
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
    match storage
        .clone()
        .dispatch(
            db.clone(),
            claim.clone(),
            object.clone(),
            ManagedPayload::Encrypted(payload),
            readback.clone(),
            settings.audio_unresolved_writes,
            timeout,
        )
        .await
        .context(h!())?
    {
        ManagedWriteOutcome::Acknowledged => {}
        ManagedWriteOutcome::DefinitelyNotDispatched(error) => {
            return Err(error).context(h!())
        }
        ManagedWriteOutcome::PossiblyDispatched(_) => {
            return Err(FinalizationFailure::StorageOutcomeUnknown.into())
        }
    }
    if storage
        .clone()
        .verify(object, readback, timeout)
        .await
        .context(h!())?
        .is_err()
    {
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
