use super::{
    super::{bl, types::*, DeviceAudioRuntime},
    ActorAudioCommand, StatusCommand,
};
use crate::file_registry::entities::{
    device_audio as audio, device_audio_asr_job as job,
    device_audio_asr_setting as setting,
};
use crate::{devices::access, error::AppError, h, types::ShortContext};
use sea_orm::{
    sea_query::{Expr, ExprTrait},
    AccessMode, ColumnTrait, ConnectionTrait, EntityTrait, FromQueryResult,
    IsolationLevel, JoinType, QueryFilter, QuerySelect, TransactionTrait,
};
use uuid::Uuid;

#[derive(FromQueryResult)]
struct Metadata {
    version: Option<Uuid>,
    state: Option<String>,
    retry_at: Option<chrono::DateTime<chrono::FixedOffset>>,
    has_automatic: bool,
}

async fn metadata<C: ConnectionTrait>(
    db: &C,
    command: ActorAudioCommand,
) -> anyhow::Result<Metadata> {
    audio::Entity::find_by_id(command.target.audio_id)
        .filter(audio::Column::DeviceId.eq(command.target.device_id))
        .join(
            JoinType::LeftJoin,
            audio::Entity::belongs_to(job::Entity)
                .from(audio::Column::Id)
                .to(job::Column::AudioId)
                .into(),
        )
        .select_only()
        .column_as(
            Expr::col((job::Entity, job::Column::StatusVersion)),
            "version",
        )
        .column_as(Expr::col((job::Entity, job::Column::State)), "state")
        .column_as(
            Expr::col((job::Entity, job::Column::NextAttemptAt)),
            "retry_at",
        )
        .column_as(
            Expr::col((audio::Entity, audio::Column::AutomaticTranscription))
                .is_not_null(),
            "has_automatic",
        )
        .into_model::<Metadata>()
        .one(db)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())
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
    let files = runtime
        .file_database()
        .c(h!())?
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(AccessMode::ReadOnly),
        )
        .await
        .c(h!())?;
    let metadata = metadata(&files, command.audio).await.c(h!())?;
    let version = metadata.version.unwrap_or_else(Uuid::nil);
    let snapshot = if command.known_version == Some(version) {
        None
    } else {
        let text = audio::Entity::find_by_id(target.audio_id)
            .select_only()
            .column(audio::Column::AutomaticTranscription)
            .into_tuple::<Option<String>>()
            .one(&files)
            .await
            .c(h!())?
            .flatten();
        Some(DeviceAudioAutomaticTranscriptionSnapshot {
            version,
            text,
            state: public_state(&metadata),
            retry_at: metadata.retry_at.map(|value| value.to_rfc3339()),
            message: message(metadata.state.as_deref()).map(str::to_owned),
        })
    };
    files.commit().await.c(h!())?;
    let availability = availability(runtime, command.audio, &metadata)
        .await
        .c(h!())?;
    Ok(DeviceAudioTranscriptionStatusRsp {
        snapshot,
        availability,
    })
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
    let blocked_reason = if metadata.state.as_deref() == Some("outcome_unknown")
    {
        Some("Потрібна операторська перевірка")
    } else if device.archived {
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

fn public_state(metadata: &Metadata) -> DeviceAudioAutomaticTranscriptionState {
    use DeviceAudioAutomaticTranscriptionState::*;
    if metadata.has_automatic {
        return AudioAsrSucceeded;
    }
    match metadata.state.as_deref() {
        Some("policy_pending" | "queued") => AudioAsrQueued,
        Some("preparing") => AudioAsrPreparing,
        Some("running") => AudioAsrRunning,
        Some("retry_wait") => AudioAsrRetryWait,
        Some("succeeded") => AudioAsrSucceeded,
        Some("no_speech") => AudioAsrNoSpeech,
        Some("failed") => AudioAsrFailed,
        Some("outcome_unknown") => AudioAsrOutcomeUnknown,
        Some("cancelled") => AudioAsrCancelled,
        _ => AudioAsrNotRequested,
    }
}

fn message(state: Option<&str>) -> Option<&'static str> {
    match state {
        Some("policy_pending") => {
            Some("Очікуємо перевірки налаштувань транскрибації")
        }
        Some("suppressed") => Some("Автотранскрибацію не було заплановано"),
        Some("retry_wait") => Some("Транскрибацію буде повторено"),
        Some("no_speech") => Some("Мовлення не виявлено"),
        Some("failed") => Some("Не вдалося виконати транскрибацію"),
        Some("outcome_unknown") => Some("Потрібна операторська перевірка"),
        Some("cancelled") => Some("Транскрибацію скасовано"),
        _ => None,
    }
}
