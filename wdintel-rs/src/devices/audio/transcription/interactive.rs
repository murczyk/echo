use super::super::{bl, types::*, DeviceAudioRuntime};
use super::{
    admission, guards::MainGuard, query, status, ActorAudioCommand,
    AdmissionOutcome, StatusCommand,
};
use crate::file_registry::entities::device_audio_asr_job as job;
use crate::{error::AppError, h, types::ShortContext};
use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, DatabaseTransaction, EntityTrait, IntoActiveModel,
    QuerySelect, Set, TransactionTrait,
};
use uuid::Uuid;

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
    let files = runtime.file_database().c(h!())?.begin().await.c(h!())?;
    let enabled = admission::lock_setting(&files, target.device_id)
        .await
        .c(h!())?;
    let source = query::source(&files, target, true)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())?;
    let current = job::Entity::find_by_id(target.audio_id)
        .lock_exclusive()
        .one(&files)
        .await
        .c(h!())?;
    main.authorize_read(command.actor_id).await.c(h!())?;
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
    if !enabled || !main.global_enabled {
        return if retry {
            Err(conflict(
                "transcription_disabled",
                "Автотранскрибацію вимкнено",
            ))
            .c(h!())
        } else {
            Ok(AdmissionOutcome::NotEligible)
        };
    }
    runtime.byte_store().c(h!())?;
    let outcome = if source.has_automatic {
        AdmissionOutcome::AlreadyCompleted
    } else if let Some(current) = current {
        transition(&files, current, retry).await.c(h!())?
    } else if retry {
        return Err(conflict(
            "retry_not_available",
            "Спочатку відкрийте аудіо",
        ))
        .c(h!());
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
        let current = job::Entity::find_by_id(target.audio_id)
            .one(&files)
            .await
            .c(h!())?
            .ok_or(AppError::NotFound)
            .c(h!())?;
        promote(&files, current).await.c(h!())?;
        AdmissionOutcome::Queued
    };
    main.commit_files(files).await.c(h!())?;
    if matches!(
        outcome,
        AdmissionOutcome::Queued | AdmissionOutcome::AlreadyActive
    ) {
        runtime.asr_wake.notify_one();
    }
    Ok(outcome)
}

async fn transition(
    files: &DatabaseTransaction,
    current: job::Model,
    retry: bool,
) -> anyhow::Result<AdmissionOutcome> {
    match current.state.as_str() {
        "outcome_unknown" if retry => Err(conflict(
            "recovery_required",
            "Потрібна операторська перевірка",
        ))
        .c(h!()),
        "preparing" | "running" | "outcome_unknown" => {
            Ok(AdmissionOutcome::AlreadyActive)
        }
        "queued" | "retry_wait" | "policy_pending" => {
            promote(files, current).await.c(h!())?;
            Ok(AdmissionOutcome::AlreadyActive)
        }
        "succeeded" => Ok(AdmissionOutcome::AlreadyCompleted),
        "failed" | "no_speech" if retry => {
            enqueue_generation(files, current).await.c(h!())?;
            Ok(AdmissionOutcome::Queued)
        }
        "suppressed" if !retry => {
            enqueue_generation(files, current).await.c(h!())?;
            Ok(AdmissionOutcome::Queued)
        }
        _ if retry => Err(conflict(
            "retry_not_available",
            "Повтор транскрибації недоступний",
        ))
        .c(h!()),
        _ => Ok(AdmissionOutcome::NotEligible),
    }
}

async fn promote(
    files: &DatabaseTransaction,
    current: job::Model,
) -> anyhow::Result<()> {
    if current.priority == 0 {
        return Ok(());
    }
    let mut current = current.into_active_model();
    current.priority = Set(0);
    current.trigger = Set("interactive".into());
    current.updated_at = Set(Utc::now().fixed_offset());
    current.update(files).await.c(h!())?;
    Ok(())
}

async fn enqueue_generation(
    files: &DatabaseTransaction,
    current: job::Model,
) -> anyhow::Result<()> {
    let now = Utc::now().fixed_offset();
    let mut current = current.into_active_model();
    query::clear_attempt(&mut current);
    current.state = Set("queued".into());
    current.priority = Set(0);
    current.trigger = Set("interactive".into());
    current.generation = Set(Uuid::new_v4());
    current.status_version = Set(Uuid::new_v4());
    current.attempt_count = Set(0);
    current.generation_started_at = Set(now);
    current.next_attempt_at = Set(Some(now));
    current.updated_at = Set(now);
    current.error_code = Set(None);
    current.update(files).await.c(h!())?;
    Ok(())
}
