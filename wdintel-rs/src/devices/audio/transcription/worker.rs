use super::{super::DeviceAudioRuntime, query, source, Claim, Failure};
use crate::{devices::config::*, h, types::ShortContext};
use echo_gpu_client::{EchoGpuClient, TransportError, TransportErrorKind};
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(PartialEq, Eq)]
pub(super) enum Iteration {
    Idle,
    Worked,
    ProviderUnavailable,
}

#[cfg(test)]
pub(super) async fn run_once(
    runtime: Arc<DeviceAudioRuntime>,
    client: &EchoGpuClient,
    owner: Uuid,
) -> anyhow::Result<bool> {
    Ok(iteration(runtime, client, owner, &CancellationToken::new())
        .await
        .c(h!())?
        != Iteration::Idle)
}

pub(super) async fn healthy_instance(
    client: &EchoGpuClient,
) -> anyhow::Result<Option<Uuid>> {
    for instance in client.reload_instances().await.c(h!())? {
        let health = client.health(&instance).await;
        if health.rust.ok && health.python.ok {
            return Ok(Some(instance.id));
        }
    }
    Ok(None)
}

pub(super) async fn iteration(
    runtime: Arc<DeviceAudioRuntime>,
    client: &EchoGpuClient,
    owner: Uuid,
    cancel: &CancellationToken,
) -> anyhow::Result<Iteration> {
    query::recover_stale(&runtime).await.c(h!())?;
    query::resolve_pending(&runtime).await.c(h!())?;
    if cancel.is_cancelled()
        || !query::has_due_work(&runtime).await.c(h!())?
        || !crate::system_settings::audio_transcription_enabled(&runtime.dbx)
            .await
            .c(h!())?
    {
        return Ok(Iteration::Idle);
    }
    let Some(instance) = healthy_instance(client).await.c(h!())? else {
        return Ok(Iteration::Idle);
    };
    if cancel.is_cancelled() {
        return Ok(Iteration::Idle);
    }
    let Some(claim) = query::claim(&runtime, owner).await.c(h!())? else {
        return Ok(Iteration::Idle);
    };
    let work = execute(runtime.clone(), client, &claim, instance, cancel);
    let pulse = heartbeat(&runtime, &claim);
    tokio::select! {
        result = work => result.c(h!()),
        _ = pulse => unreachable!("heartbeat loop only ends with its attempt"),
    }
}

async fn heartbeat(runtime: &DeviceAudioRuntime, claim: &Claim) {
    loop {
        tokio::time::sleep(Duration::from_secs(
            DEVICE_AUDIO_ASR_HEARTBEAT_SECS,
        ))
        .await;
        if query::heartbeat(runtime, claim).await.is_err() {
            log::warn!(
                "device ASR heartbeat unavailable: audio_id={}",
                claim.target.audio_id
            );
        }
    }
}

async fn upload(
    runtime: Arc<DeviceAudioRuntime>,
    client: &EchoGpuClient,
    claim: &Claim,
    instance: Uuid,
) -> anyhow::Result<Option<echo_gpu_client::AudioHandle>> {
    let materialized = source::materialize(runtime, claim).await.c(h!())?;
    let name = materialized
        .path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow::anyhow!("invalid ASR temporary filename"))
        .c(h!())?;
    let handle = client
        .ensure_uploaded(Some(instance), &materialized.path, name)
        .await
        .c(h!())?;
    let Ok(health) = client.check_instance(handle.instance_id).await else {
        return Ok(None);
    };
    Ok((health.rust.ok && health.python.ok).then_some(handle))
}

async fn execute(
    runtime: Arc<DeviceAudioRuntime>,
    client: &EchoGpuClient,
    claim: &Claim,
    instance: Uuid,
    cancel: &CancellationToken,
) -> anyhow::Result<Iteration> {
    let handle = match upload(runtime.clone(), client, claim, instance).await {
        Ok(Some(handle)) => handle,
        Ok(None) => {
            persist(&runtime, claim, Completion::ProviderUnavailable).await;
            return Ok(Iteration::ProviderUnavailable);
        }
        Err(_) => {
            persist(
                &runtime,
                claim,
                Completion::Failure(Failure::Safe("preparation_failed")),
            )
            .await;
            return Ok(Iteration::Worked);
        }
    };
    if cancel.is_cancelled() {
        persist(
            &runtime,
            claim,
            Completion::Failure(Failure::Safe("preparation_interrupted")),
        )
        .await;
        return Ok(Iteration::Worked);
    }
    if !query::dispatch(&runtime, claim, handle.instance_id, handle.audio_id)
        .await
        .c(h!())?
    {
        return Ok(Iteration::Worked);
    }
    match client
        .raw_guess(handle.instance_id, handle.audio_id, None)
        .await
    {
        Ok(response)
            if Uuid::parse_str(&response.audio_id).ok()
                == Some(handle.audio_id) =>
        {
            persist(&runtime, claim, Completion::Text(&response.full_phrase))
                .await;
        }
        Ok(_) => {
            persist(&runtime, claim, Completion::Failure(Failure::Unknown))
                .await;
        }
        Err(error) => {
            persist(&runtime, claim, Completion::Failure(classify(&error)))
                .await;
        }
    }
    Ok(Iteration::Worked)
}

fn classify(error: &anyhow::Error) -> Failure {
    let Some(error) = error.downcast_ref::<TransportError>() else {
        return Failure::Unknown;
    };
    match error.kind {
        TransportErrorKind::Connect | TransportErrorKind::NotReady => {
            Failure::Safe("provider_not_ready")
        }
        TransportErrorKind::Overloaded if provider_rejected_overload(error) => {
            Failure::Overloaded {
                retry_after_secs: error
                    .retry_after
                    .map(|delay| delay.as_secs()),
            }
        }
        _ => Failure::Unknown,
    }
}

fn provider_rejected_overload(error: &TransportError) -> bool {
    let Some(status) = error.status else {
        return false;
    };
    // The pinned client exposes the provider body only in this message;
    // a status code alone cannot rule out inference behind a proxy.
    let prefix = format!("Echo GPU returned status {status}: ");
    error
        .message
        .strip_prefix(&prefix)
        .and_then(|body| serde_json::from_str::<serde_json::Value>(body).ok())
        .is_some_and(|body| {
            body.get("error").and_then(|v| v.as_str()) == Some("overloaded")
        })
}

enum Completion<'a> {
    Text(&'a str),
    Failure(Failure),
    ProviderUnavailable,
}

async fn persist(
    runtime: &DeviceAudioRuntime,
    claim: &Claim,
    completion: Completion<'_>,
) {
    loop {
        let result = match completion {
            Completion::Text(text) => {
                query::complete(runtime, claim, text).await.map(|_| ())
            }
            Completion::Failure(failure) => {
                query::fail(runtime, claim, failure).await
            }
            Completion::ProviderUnavailable => {
                query::defer_provider(runtime, claim).await
            }
        };
        if result.is_ok() {
            return;
        }
        log::warn!(
            "device ASR result persistence unavailable: audio_id={}",
            claim.target.audio_id
        );
        tokio::time::sleep(Duration::from_secs(
            DEVICE_AUDIO_ASR_PERSIST_RETRY_SECS,
        ))
        .await;
    }
}

pub(crate) async fn run(
    runtime: Arc<DeviceAudioRuntime>,
    client: Arc<EchoGpuClient>,
    cancel: CancellationToken,
) {
    if runtime.file_database().is_err() || runtime.byte_store().is_err() {
        log::warn!("device ASR worker unavailable: files database or byte storage is missing");
        return;
    }
    let owner = Uuid::new_v4();
    while !cancel.is_cancelled() {
        let work = iteration(runtime.clone(), &client, owner, &cancel);
        tokio::pin!(work);
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                if tokio::time::timeout(Duration::from_secs(DEVICE_AUDIO_ASR_SHUTDOWN_GRACE_SECS), &mut work).await.is_err() {
                    log::warn!("device ASR shutdown grace expired; durable dispatch retains its slot");
                }
                break;
            }
            result = &mut work => result,
        };
        match result {
            Ok(Iteration::Worked | Iteration::ProviderUnavailable) => continue,
            Ok(Iteration::Idle) => (),
            Err(_) => log::warn!("device ASR worker iteration unavailable"),
        }
        tokio::select! {
            _ = cancel.cancelled() => break,
            _ = runtime.asr_wake.notified() => (),
            _ = tokio::time::sleep(Duration::from_secs(DEVICE_AUDIO_ASR_IDLE_SECS)) => (),
        }
    }
}
