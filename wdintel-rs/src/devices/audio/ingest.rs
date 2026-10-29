use super::types::{ReceiveDeviceAudioCommand, ReceiveDeviceAudioOutcome};
use super::*;
use crate::devices::upload_finalization::resources::{
    OperationGuard, ResourceKind,
};
use crate::file_registry::entities::device_audio_ingest;
use crate::sigint::file_upload::tus::TusUpload;
use chrono::SubsecRound;

#[derive(Clone, Default)]
pub(super) struct IngestHooks {
    #[cfg(test)]
    pub after_commit: Option<TestHook>,
    #[cfg(test)]
    pub before_put: Option<TestHook>,
    #[cfg(test)]
    pub before_publication: Option<TestHook>,
}

#[cfg(test)]
type TestHook = Arc<
    dyn Fn() -> futures_util::future::BoxFuture<'static, anyhow::Result<()>>
        + Send
        + Sync,
>;

pub(super) async fn receive(
    runtime: Arc<DeviceAudioRuntime>,
    actor: Uuid,
    command: ReceiveDeviceAudioCommand,
) -> anyhow::Result<ReceiveDeviceAudioOutcome> {
    receive_with_hooks(runtime, actor, command, IngestHooks::default())
        .await
        .c(h!())
}

pub(super) async fn receive_with_hooks(
    runtime: Arc<DeviceAudioRuntime>,
    actor: Uuid,
    mut command: ReceiveDeviceAudioCommand,
    hooks: IngestHooks,
) -> anyhow::Result<ReceiveDeviceAudioOutcome> {
    authorize_source(&runtime, actor, command.device_id)
        .await
        .c(h!())?;
    validate_command(&command).c(h!())?;
    command.recording_started_at =
        command.recording_started_at.trunc_subsecs(6);
    if let Some(outcome) =
        known_outcome(&runtime, actor, &command).await.c(h!())?
    {
        return Ok(outcome);
    }
    runtime.byte_store().c(h!())?;
    let admission = tokio::time::timeout(
        Duration::from_secs(DEVICE_AUDIO_RECEIVE_WAIT_SECS),
        runtime.receive_permits.clone().acquire_owned(),
    )
    .await
    .map_err(|_| unavailable("audio receive timed out"))
    .c(h!())?
    .map_err(|_| unavailable("audio receive is unavailable"))
    .c(h!())?;
    let slot = runtime
        .finalization_slot(ResourceKind::Audio)
        .await
        .c(h!())?;
    let admission: OperationGuard = Arc::new((admission, slot));
    let locked = upload::open_completed(
        &runtime,
        actor,
        command.device_id,
        &command.upload_url,
    )
    .await;
    authorize_source(&runtime, actor, command.device_id)
        .await
        .c(h!())?;
    if let Some(outcome) =
        known_outcome(&runtime, actor, &command).await.c(h!())?
    {
        return Ok(outcome);
    }
    let (source, guard) = locked.c(h!())?;
    finalize_owned(runtime, actor, command, source, guard, admission, hooks)
        .await
        .c(h!())?
}

async fn known_outcome(
    runtime: &DeviceAudioRuntime,
    actor: Uuid,
    command: &ReceiveDeviceAudioCommand,
) -> anyhow::Result<Option<ReceiveDeviceAudioOutcome>> {
    if let Some(outcome) =
        super::async_ingest::synchronous_outcome(runtime, actor, command)
            .await
            .c(h!())?
    {
        return Ok(Some(outcome));
    }
    let db = runtime.file_database().c(h!())?;
    if let Some(attempt) =
        query::find_attempt(db, &command.upload_url).await.c(h!())?
    {
        query::check_attempt(&attempt, actor, command).c(h!())?;
        if attempt.status == "ready" {
            query::own_ready(db, &attempt).await.c(h!())?;
            return Ok(Some(ReceiveDeviceAudioOutcome::Duplicate));
        }
        if attempt.status == "deleting" {
            return Err(query::rejected());
        }
    }
    Ok(None)
}

fn finalize_owned(
    runtime: Arc<DeviceAudioRuntime>,
    actor: Uuid,
    command: ReceiveDeviceAudioCommand,
    source: TusUpload,
    guard: impl Send + Sync + 'static,
    admission: OperationGuard,
    hooks: IngestHooks,
) -> tokio::task::JoinHandle<anyhow::Result<ReceiveDeviceAudioOutcome>> {
    tokio::spawn(async move {
        let _admission = admission.clone();
        let guard = Arc::new(guard);
        let admission: OperationGuard = Arc::new((admission, guard.clone()));
        let attempt =
            query::reserve_attempt(&runtime, actor, &command, &source)
                .await
                .c(h!())?;
        let heartbeat_stop = start_heartbeat(runtime.clone(), &attempt);
        let result = finalize(
            runtime.clone(),
            actor,
            &command,
            &source,
            &attempt,
            admission,
            hooks,
        )
        .await;
        drop(heartbeat_stop);
        let result =
            recover_result(&runtime, actor, &command, &attempt, result).await;
        let terminal = query::confirmed_terminal(&runtime, attempt.id).await;
        if matches!(&result, Ok(ReceiveDeviceAudioOutcome::Accepted(_))) {
            preparation::accepted(runtime.clone(), &attempt, &source.file_path)
                .await;
        }
        drop(guard);
        if matches!(terminal, Ok(true)) {
            if let Err(error) =
                consume_source(&runtime, attempt.id, &source.file_path).await
            {
                log::warn!("device audio source cleanup failed: ingest_id={}, error={error:#}", attempt.id);
            }
        }
        result
    })
}

pub(super) fn validate_command(
    command: &ReceiveDeviceAudioCommand,
) -> anyhow::Result<()> {
    if command.name.is_empty()
        || command.name.len() > DEVICE_AUDIO_MAX_NAME_BYTES
        || command.name.contains('\0')
    {
        return Err(AppError::BadRequestJson { body: serde_json::json!({"message":"Назва має містити від 1 до 1024 UTF-8 байтів без NUL"}) }.into());
    }
    probe::checked_recording_end(command.recording_started_at, 1).c(h!())?;
    Ok(())
}

fn start_heartbeat(
    runtime: Arc<DeviceAudioRuntime>,
    attempt: &device_audio_ingest::Model,
) -> tokio::sync::oneshot::Sender<()> {
    let (stop, mut stopped) = tokio::sync::oneshot::channel();
    let id = attempt.id;
    let lease = attempt.lease_token;
    tokio::spawn(async move {
        let mut interval =
            tokio::time::interval(DEVICE_AUDIO_HEARTBEAT_INTERVAL);
        loop {
            tokio::select! {
                _ = &mut stopped => return,
                _ = interval.tick() => {
                    if let Err(error) = query::heartbeat(&runtime, id, lease).await {
                        log::warn!("device audio heartbeat failed: ingest_id={id}, error={error:#}");
                    }
                }
            }
        }
    });
    stop
}

async fn finalize(
    runtime: Arc<DeviceAudioRuntime>,
    actor: Uuid,
    command: &ReceiveDeviceAudioCommand,
    source: &TusUpload,
    attempt: &device_audio_ingest::Model,
    admission: OperationGuard,
    hooks: IngestHooks,
) -> anyhow::Result<ReceiveDeviceAudioOutcome> {
    if attempt.status == "ready" {
        return Ok(ReceiveDeviceAudioOutcome::Duplicate);
    }
    if attempt.status != "finalizing" {
        return Err(query::rejected());
    }
    let media = probe::probe_with_admission(
        &runtime,
        &source.file_path,
        command.recording_started_at,
        Some(admission.clone()),
    )
    .await
    .c(h!())?;
    let prepared = storage::prepare_source(
        source.file_path.clone(),
        source.upload_length,
        admission,
    )
    .await
    .c(h!())?;
    let capacity = storage::reserve_storage(&runtime).await.c(h!())?;
    query::allow_store(&runtime, attempt, prepared.fingerprint, &media)
        .await
        .c(h!())?;
    #[cfg(test)]
    if let Some(hook) = &hooks.before_put {
        hook().await.c(h!())?;
    }
    storage::store_and_verify(
        runtime.clone(),
        attempt.storage_key.clone(),
        prepared,
        capacity,
    )
    .await
    .c(h!())?;
    hooks.before_publication().await.c(h!())?;
    authorize_source(&runtime, actor, command.device_id)
        .await
        .c(h!())?;
    let outcome = query::publish(&runtime, attempt, &media).await.c(h!())?;
    #[cfg(test)]
    if let Some(hook) = &hooks.after_commit {
        hook().await.c(h!())?;
    }
    authorize_source(&runtime, actor, command.device_id)
        .await
        .c(h!())?;
    Ok(outcome)
}

impl IngestHooks {
    async fn before_publication(&self) -> anyhow::Result<()> {
        #[cfg(test)]
        if let Some(hook) = &self.before_publication {
            hook().await.c(h!())?;
        }
        Ok(())
    }
}

async fn recover_result(
    runtime: &DeviceAudioRuntime,
    actor: Uuid,
    command: &ReceiveDeviceAudioCommand,
    attempt: &device_audio_ingest::Model,
    result: anyhow::Result<ReceiveDeviceAudioOutcome>,
) -> anyhow::Result<ReceiveDeviceAudioOutcome> {
    let Err(error) = result else {
        return result;
    };
    let terminal_media =
        error.downcast_ref::<DeviceAudioMediaError>().is_some();
    if let Some(audio) =
        query::reconcile_rejection(runtime, attempt.id, terminal_media)
            .await
            .c(h!())?
    {
        authorize_source(runtime, actor, command.device_id)
            .await
            .c(h!())?;
        return Ok(query::accepted(&audio));
    }
    Err(error)
}

pub(super) async fn consume_source(
    runtime: &DeviceAudioRuntime,
    id: Uuid,
    path: &std::path::Path,
) -> anyhow::Result<()> {
    if !crate::sigint::file_upload::remove_consumed_upload(path)
        .await
        .c(h!())?
    {
        anyhow::bail!("invalid audio source cleanup path");
    }
    query::record_consumed(runtime, id).await.c(h!())
}

pub(in crate::devices) async fn finalize_claim(
    env: &crate::types::Env,
    runtime: &DeviceAudioRuntime,
    claim: crate::devices::upload_finalization::types::ClaimedFinalizationJob,
) -> anyhow::Result<()> {
    super::async_finalizer::execute(env, runtime, claim)
        .await
        .c(h!())
}
