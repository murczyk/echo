use super::super::{bl, types::*, DeviceAudioRuntime};
use super::{
    admission, guards::MainGuard, status, ActorAudioCommand, AdmissionOutcome,
    StatusCommand,
};
use crate::file_registry::entities::device_audio as audio;
use crate::{error::AppError, h, types::ShortContext};
use sea_orm::{
    ColumnTrait, EntityTrait, QueryFilter, QuerySelect, TransactionTrait,
};

pub(crate) async fn open(
    runtime: &DeviceAudioRuntime,
    command: ActorAudioCommand,
) -> anyhow::Result<AdmissionOutcome> {
    admit(runtime, command, false).await.c(h!())
}

pub(crate) async fn retry(
    runtime: &DeviceAudioRuntime,
    command: ActorAudioCommand,
) -> anyhow::Result<RetryDeviceAudioTranscriptionRsp> {
    use DeviceAudioTranscriptionDisposition::*;
    let disposition = match admit(runtime, command, true).await.c(h!())? {
        AdmissionOutcome::Queued => AudioAsrRetryQueued,
        AdmissionOutcome::AlreadyActive => AudioAsrRetryAlreadyActive,
        AdmissionOutcome::AlreadyCompleted => AudioAsrRetryAlreadyCompleted,
        AdmissionOutcome::NotEligible => {
            return Err(conflict(
                "retry_not_available",
                "Повтор транскрибації недоступний",
            ))
            .c(h!())
        }
    };
    let current = status::status(
        runtime,
        StatusCommand {
            audio: command,
            known_version: None,
        },
    )
    .await
    .c(h!())?;
    Ok(RetryDeviceAudioTranscriptionRsp {
        snapshot: current
            .snapshot
            .ok_or_else(|| anyhow::anyhow!("initial ASR status missing"))
            .c(h!())?,
        availability: current.availability,
        disposition,
    })
}

fn conflict(code: &str, message: &str) -> AppError {
    AppError::ConflictJson {
        body: serde_json::json!({"code": code, "message": message}),
    }
}

async fn admit(
    runtime: &DeviceAudioRuntime,
    command: ActorAudioCommand,
    retry: bool,
) -> anyhow::Result<AdmissionOutcome> {
    let target = command.target;
    bl::authorize(
        runtime,
        command.actor_id,
        target.device_id,
        bl::AudioAccess::Read,
    )
    .await
    .c(h!())?;
    let main = MainGuard::acquire(runtime, target.device_id, true)
        .await
        .c(h!())?;
    main.authorize_read(command.actor_id).await.c(h!())?;
    let files = runtime.file_database().c(h!())?.begin().await.c(h!())?;
    let enabled = admission::lock_setting(&files, target.device_id)
        .await
        .c(h!())?;
    let row = audio::Entity::find_by_id(target.audio_id)
        .filter(audio::Column::DeviceId.eq(target.device_id))
        .lock_exclusive()
        .one(&files)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())?;
    if !main.active() {
        return if retry {
            Err(AppError::Forbidden(
                "archived device cannot be changed".into(),
            ))
            .c(h!())
        } else {
            Ok(AdmissionOutcome::NotEligible)
        };
    }
    if !main.global_enabled || !enabled {
        return if retry {
            Err(conflict(
                "transcription_disabled",
                "Транскрибація недоступна",
            ))
            .c(h!())
        } else {
            Ok(AdmissionOutcome::NotEligible)
        };
    }
    runtime.byte_store().c(h!())?;
    if row.automatic_transcription_pending.is_some() {
        return Ok(AdmissionOutcome::AlreadyActive);
    }
    if !retry && row.automatic_transcribed_at.is_some() {
        return Ok(AdmissionOutcome::AlreadyCompleted);
    }
    let mut outcome = AdmissionOutcome::Queued;
    if retry {
        // Do not hold files row locks while entering shared source coordination.
        files.commit().await.c(h!())?;
        let (source, _) = crate::transcription::service::enqueue(
            &runtime.dbx,
            &row.storage_key,
        )
        .await
        .c(h!())?;
        let task = echo_gpu_client::lookup(&runtime.dbx, source)
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)
            .c(h!())?
            .0;
        if matches!(task.state.as_str(), "terminal" | "completed") {
            if !crate::transcriber::reprocess::request_for_device(
                &runtime.dbx,
                runtime.file_database().c(h!())?,
                source,
            )
            .await
            .c(h!())?
            {
                outcome = AdmissionOutcome::AlreadyActive;
            }
        } else {
            outcome = AdmissionOutcome::AlreadyActive;
            audio::Entity::update_many()
                .col_expr(
                    audio::Column::AutomaticTranscriptionPending,
                    sea_orm::sea_query::Expr::value(0),
                )
                .filter(audio::Column::Id.eq(row.id))
                .filter(audio::Column::AutomaticTranscriptionPending.is_null())
                .exec(runtime.file_database().c(h!())?)
                .await
                .c(h!())?;
        }
    } else {
        admission::publish(
            &files,
            target.device_id,
            target.audio_id,
            true,
            Some(&main),
        )
        .await
        .c(h!())?;
        main.commit_files(files).await.c(h!())?;
    }
    runtime.asr_wake.notify_one();
    Ok(outcome)
}
