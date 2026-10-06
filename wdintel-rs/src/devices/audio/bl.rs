use super::{query, DeviceAudioRuntime};
use crate::devices::access;
use crate::error::AppError;
use crate::h;
use crate::types::{ShortContext, Uuid};
use sea_orm::TransactionTrait;

pub(super) async fn set_processed(
    runtime: &DeviceAudioRuntime,
    actor: Uuid,
    command: super::types::SetDeviceAudioProcessingCommand,
) -> anyhow::Result<super::types::SetDeviceAudioProcessingOutcome> {
    use super::types::{
        SetDeviceAudioProcessingOutcome as Outcome, SetDeviceAudioProcessingRsp,
    };
    authorize(runtime, actor, command.device_id, AudioAccess::Edit)
        .await
        .c(h!())?;
    let transaction = runtime.file_database().c(h!())?.begin().await.c(h!())?;
    let current = query::locked_processing(&transaction, &command)
        .await
        .c(h!())?;
    authorize(runtime, actor, command.device_id, AudioAccess::Edit)
        .await
        .c(h!())?;
    let response = SetDeviceAudioProcessingRsp {
        audio_id: command.audio_id.to_string(),
        processed: current.processed,
        processing_version: current.processing_version.to_string(),
    };
    if current.processed == command.processed {
        transaction.commit().await.c(h!())?;
        return Ok(Outcome::Unchanged(response));
    }
    if current.processing_version != command.expected_processing_version {
        transaction.commit().await.c(h!())?;
        return Ok(Outcome::Conflict(response));
    }
    let version = Uuid::new_v4();
    query::update_processing(&transaction, &command, version)
        .await
        .c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(Outcome::Saved(SetDeviceAudioProcessingRsp {
        audio_id: command.audio_id.to_string(),
        processed: command.processed,
        processing_version: version.to_string(),
    }))
}

pub(super) async fn save_transcription(
    runtime: &DeviceAudioRuntime,
    actor: Uuid,
    command: super::types::SaveDeviceAudioTranscriptionCommand,
) -> anyhow::Result<super::types::SaveDeviceAudioTranscriptionOutcome> {
    use super::types::{
        DeviceAudioTranscription,
        SaveDeviceAudioTranscriptionOutcome as Outcome,
        SaveDeviceAudioTranscriptionRsp,
    };
    authorize(runtime, actor, command.device_id, AudioAccess::Edit)
        .await
        .c(h!())?;
    let transaction = runtime.file_database().c(h!())?.begin().await.c(h!())?;
    let current = query::locked_text(&transaction, &command).await.c(h!())?;
    authorize(runtime, actor, command.device_id, AudioAccess::Edit)
        .await
        .c(h!())?;
    if current.text_version != command.expected_text_version {
        transaction.commit().await.c(h!())?;
        return Ok(Outcome::Conflict {
            audio_id: command.audio_id,
            current: DeviceAudioTranscription {
                text: current.transcription,
                text_version: current.text_version.to_string(),
            },
        });
    }
    let unchanged = current.transcription == command.text;
    let version = if unchanged {
        current.text_version
    } else {
        Uuid::new_v4()
    };
    if !unchanged {
        query::update_text(&transaction, &command, version)
            .await
            .c(h!())?;
    }
    transaction.commit().await.c(h!())?;
    let response = SaveDeviceAudioTranscriptionRsp {
        audio_id: command.audio_id.to_string(),
        transcription: DeviceAudioTranscription {
            text: command.text,
            text_version: version.to_string(),
        },
    };
    Ok(if unchanged {
        Outcome::Unchanged(response)
    } else {
        Outcome::Saved(response)
    })
}

pub(super) async fn list(
    runtime: &DeviceAudioRuntime,
    actor: Uuid,
    command: super::types::ListDeviceAudioCommand,
) -> anyhow::Result<super::types::ListDeviceAudioRsp> {
    authorize(runtime, actor, command.device_id, AudioAccess::Read)
        .await
        .c(h!())?;
    if command.limit == 0 || command.limit > super::DEVICE_AUDIO_MAX_PAGE_SIZE {
        return Err(AppError::BadRequestJson { body: serde_json::json!({"message":"Розмір сторінки має бути від 1 до 200"}) }.into());
    }
    let boundary = super::cursor::decode(&command).c(h!())?;
    let mut rows = query::page_query(&command, boundary.as_ref())
        .into_model::<query::AudioRow>()
        .all(runtime.file_database().c(h!())?)
        .await
        .c(h!())?;
    let has_more = rows.len() > command.limit as usize;
    rows.truncate(command.limit as usize);
    let next_cursor = if has_more {
        rows.last()
            .map(|row| {
                super::cursor::encode(
                    &command,
                    row.recording_started_at.with_timezone(&chrono::Utc),
                    row.id,
                )
            })
            .transpose()
            .c(h!())?
    } else {
        None
    };
    authorize(runtime, actor, command.device_id, AudioAccess::Read)
        .await
        .c(h!())?;
    Ok(super::types::ListDeviceAudioRsp {
        audio: rows.into_iter().map(query::AudioRow::summary).collect(),
        next_cursor,
    })
}

pub(super) async fn detail(
    runtime: &DeviceAudioRuntime,
    actor: Uuid,
    command: super::types::DeviceAudioDetailCommand,
) -> anyhow::Result<super::types::DeviceAudioDetails> {
    authorize(runtime, actor, command.device_id, AudioAccess::Read)
        .await
        .c(h!())?;
    let row = query::audio_detail(runtime.file_database().c(h!())?, &command)
        .await
        .c(h!())?;
    let device =
        authorize(runtime, actor, command.device_id, AudioAccess::Read)
            .await
            .c(h!())?;
    Ok(row.details(!device.archived))
}

#[derive(Clone, Copy)]
pub(super) enum AudioAccess {
    Source,
    Read,
    Edit,
}

pub(super) async fn authorize(
    runtime: &DeviceAudioRuntime,
    actor_id: Uuid,
    device_id: Uuid,
    permission: AudioAccess,
) -> anyhow::Result<query::VisibleDevice> {
    let actor = access::resolve_login_by_id(&runtime.dbx, &actor_id)
        .await
        .c(h!())?;
    match permission {
        AudioAccess::Source => {
            access::require_audio_source(&actor.roles).c(h!())?
        }
        AudioAccess::Read => {
            access::require_audio_read(&actor.roles).c(h!())?
        }
        AudioAccess::Edit => {
            access::require_audio_edit(&actor.roles).c(h!())?
        }
    }
    let device = query::find_visible_device(&runtime.dbx, &actor, device_id)
        .await
        .c(h!())?;
    if !matches!(permission, AudioAccess::Read) && device.archived {
        return Err(AppError::Forbidden(
            "archived device cannot be changed".to_string(),
        )
        .into());
    }
    Ok(device)
}
