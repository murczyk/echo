use super::{
    super::{bl, types::*, DeviceAudioRuntime},
    ActorAudioCommand, StatusCommand,
};
use crate::file_registry::entities::{
    device_audio as audio, device_audio_asr_setting as setting,
};
use crate::{devices::access, error::AppError, h, types::ShortContext};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QuerySelect};
use sha2::{Digest, Sha256};
use uuid::Uuid;

struct Metadata {
    state: Option<String>,
    has_automatic: bool,
}

pub(crate) async fn status(
    runtime: &DeviceAudioRuntime,
    command: StatusCommand,
) -> anyhow::Result<DeviceAudioTranscriptionStatusRsp> {
    let target = command.audio.target;
    bl::authorize(
        runtime,
        command.audio.actor_id,
        target.device_id,
        bl::AudioAccess::Read,
    )
    .await
    .c(h!())?;
    let row = audio::Entity::find_by_id(target.audio_id)
        .filter(audio::Column::DeviceId.eq(target.device_id))
        .one(runtime.file_database().c(h!())?)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())?;
    // Saved text/no-speech is complete locally. Native diagnostics are optional.
    let task = if row.automatic_transcription_pending.is_some()
        || row.automatic_transcribed_at.is_none()
    {
        match native(runtime, &row.storage_key).await {
            Ok(task) => task,
            Err(error) => {
                log::warn!(
                    "device transcription diagnostics unavailable: {error:#}"
                );
                None
            }
        }
    } else {
        None
    };
    let mut state = if row.automatic_transcription_pending.is_some() {
        match task.as_ref().map(|task| task.state.as_str()) {
            Some("processing") => "running",
            Some("retrying") => "retry_wait",
            _ => "queued",
        }
    } else if row.automatic_transcribed_at.is_some() {
        if row.automatic_transcription.is_some() {
            "succeeded"
        } else {
            "no_speech"
        }
    } else if task.as_ref().is_some_and(|task| task.state == "terminal") {
        "failed"
    } else {
        "not_requested"
    };
    let metadata = Metadata {
        state: Some(state.into()),
        has_automatic: row.automatic_transcription.is_some(),
    };
    let availability = availability(runtime, command.audio, &metadata)
        .await
        .c(h!())?;
    if row.automatic_transcribed_at.is_none()
        && row.automatic_transcription_pending.is_none()
        && availability.blocked_reason.as_deref() == Some("Пристрій архівовано")
    {
        state = "cancelled";
    }
    let retry_at = task
        .as_ref()
        .and_then(|task| task.next_retry_at)
        .map(|at| at.and_utc().to_rfc3339());
    let digest = Sha256::digest(
        format!(
            "{:?}|{:?}|{:?}|{}|{:?}",
            row.automatic_transcription,
            row.automatic_transcribed_at,
            row.automatic_transcription_pending,
            state,
            retry_at
        )
        .as_bytes(),
    );
    let version = Uuid::from_bytes(digest[..16].try_into().c(h!())?);
    let snapshot = (command.known_version != Some(version)).then(|| {
        DeviceAudioAutomaticTranscriptionSnapshot {
            version,
            text: row.automatic_transcription,
            state: public_state(state),
            retry_at,
            message: match state {
                "failed" => Some("Не вдалося виконати транскрибацію".into()),
                "no_speech" => Some("Мовлення не виявлено".into()),
                "retry_wait" => Some("Транскрибацію буде повторено".into()),
                _ => None,
            },
        }
    });
    Ok(DeviceAudioTranscriptionStatusRsp {
        snapshot,
        availability,
    })
}

async fn native(
    runtime: &DeviceAudioRuntime,
    key: &str,
) -> anyhow::Result<
    Option<echo_gpu_client::entities::echo_gpu_transcription_queue::Model>,
> {
    let Some(source) =
        crate::transcription::service::source_id(&runtime.dbx, key)
            .await
            .c(h!())?
    else {
        return Ok(None);
    };
    Ok(echo_gpu_client::lookup(&runtime.dbx, source)
        .await
        .c(h!())?
        .map(|task| task.0))
}

async fn availability(
    runtime: &DeviceAudioRuntime,
    command: ActorAudioCommand,
    metadata: &Metadata,
) -> anyhow::Result<DeviceAudioTranscriptionAvailability> {
    let device_enabled = setting::Entity::find_by_id(command.target.device_id)
        .select_only()
        .column(setting::Column::Enabled)
        .into_tuple::<bool>()
        .one(runtime.file_database().c(h!())?)
        .await
        .c(h!())?
        .unwrap_or(true);
    let global_enabled =
        crate::system_settings::audio_transcription_enabled(&runtime.dbx)
            .await
            .c(h!())?;
    let actor = access::resolve_login_by_id(&runtime.dbx, &command.actor_id)
        .await
        .c(h!())?;
    access::require_audio_read(&actor.roles).c(h!())?;
    let device = super::super::query::find_visible_device(
        &runtime.dbx,
        &actor,
        command.target.device_id,
    )
    .await
    .c(h!())?;
    let editable =
        !device.archived && access::require_audio_edit(&actor.roles).is_ok();
    let blocked_reason = if device.archived {
        Some("Пристрій архівовано")
    } else if !global_enabled {
        Some("Сервіс транскрибації вимкнено")
    } else if !device_enabled {
        Some("Автотранскрибацію пристрою вимкнено")
    } else if runtime.byte_store().is_err() {
        Some("Сховище аудіо недоступне")
    } else {
        None
    };
    Ok(DeviceAudioTranscriptionAvailability {
        device_enabled,
        global_enabled,
        can_edit_manual: editable,
        can_manage_setting: editable,
        can_retry: blocked_reason.is_none()
            && !metadata.has_automatic
            && matches!(
                metadata.state.as_deref(),
                Some("failed" | "no_speech")
            ),
        blocked_reason: blocked_reason.map(str::to_owned),
    })
}

fn public_state(state: &str) -> DeviceAudioAutomaticTranscriptionState {
    use DeviceAudioAutomaticTranscriptionState::*;
    match state {
        "queued" => AudioAsrQueued,
        "running" => AudioAsrRunning,
        "retry_wait" => AudioAsrRetryWait,
        "succeeded" => AudioAsrSucceeded,
        "no_speech" => AudioAsrNoSpeech,
        "failed" => AudioAsrFailed,
        "cancelled" => AudioAsrCancelled,
        _ => AudioAsrNotRequested,
    }
}
