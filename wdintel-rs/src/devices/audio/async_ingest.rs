use actix_web::{HttpResponse, ResponseError};
use chrono::SubsecRound;
use uuid::Uuid;

use super::{
    async_adoption, ingest, pin, query, types::ReceiveDeviceAudioCommand,
    unavailable, upload,
};
use crate::devices::upload_finalization::{
    self as finalization, admission,
    ingress::{self, AdmissionOutcome},
    query as jobs,
    types::*,
};
use crate::{
    error::AppError,
    h,
    types::{Env, ShortContext},
};

pub(super) async fn receive(
    env: &Env,
    actor: Uuid,
    mut command: ReceiveDeviceAudioCommand,
) -> anyhow::Result<HttpResponse> {
    ingest::validate_command(&command).c(h!())?;
    command.recording_started_at =
        command.recording_started_at.trunc_subsecs(6);
    let (upload_id, size) = canonicalize(&mut command).c(h!())?;
    if let Some(response) = replay(env, actor, upload_id, size, &command)
        .await
        .c(h!())?
    {
        return Ok(ingress::mark_response(
            response,
            AdmissionOutcome::Replayed,
        ));
    }
    super::authorize_source(&env.device_audio, actor, command.device_id)
        .await
        .c(h!())?;
    let db = env.device_audio.file_database().c(h!())?;
    let settings = finalization::configured_settings(&env.config, true);
    let deadline = std::time::Instant::now()
        + std::time::Duration::from_millis(settings.source_lock_millis);
    let locked = upload::lock_completed(
        &env.device_audio,
        actor,
        command.device_id,
        &command.upload_url,
        Some(deadline),
    )
    .await;
    let (source, lock) = match locked {
        Ok(locked) => locked,
        Err(error) => {
            if let Some(response) =
                replay(env, actor, upload_id, size, &command)
                    .await
                    .c(h!())?
            {
                return Ok(ingress::mark_response(
                    response,
                    AdmissionOutcome::Replayed,
                ));
            }
            super::authorize_source(
                &env.device_audio,
                actor,
                command.device_id,
            )
            .await
            .c(h!())?;
            return Err(error).c(h!());
        }
    };
    if let Some(response) = replay(env, actor, upload_id, size, &command)
        .await
        .c(h!())?
    {
        return Ok(ingress::mark_response(
            response,
            AdmissionOutcome::Replayed,
        ));
    }
    super::authorize_source(&env.device_audio, actor, command.device_id)
        .await
        .c(h!())?;
    upload::validate_locked_source(&source).await.c(h!())?;
    if !settings.enabled {
        return Ok(no_store(
            unavailable("async finalization is unavailable").error_response(),
        ));
    }
    env.device_audio.byte_store().c(h!())?;
    env.device_audio
        .managed_storage
        .as_ref()
        .ok_or_else(|| unavailable("managed byte storage is unavailable"))
        .c(h!())?;
    let locked =
        pin::LockedSource::accept(&source, lock, command.device_id, actor)
            .c(h!())?;
    finalization::fault::point("audio_source_pinned", upload_id).await;
    let marker = locked.marker();
    let queued = FinalizationCommand {
        created_by_login_id: actor,
        device_id: command.device_id,
        source_size_bytes: i64::try_from(size).c(h!())?,
        source_locator: Some(
            source
                .file_path
                .strip_prefix(&env.device_audio.storage_dir)
                .c(h!())?
                .to_str()
                .c(h!())?
                .to_string(),
        ),
        target: FinalizationTarget::Audio {
            tus_id: upload_id,
            audio_id: Uuid::now_v7(),
            name: command.name,
            recording_started_at: command.recording_started_at,
            pin_token: marker.pin_token,
        },
    };
    super::authorize_source(&env.device_audio, actor, command.device_id)
        .await
        .c(h!())?;
    let mut transaction =
        db.get_postgres_connection_pool().begin().await.c(h!())?;
    let result = admission::admit_with_id_in(
        &mut transaction,
        &queued,
        &settings,
        marker.job_id,
    )
    .await;
    let snapshot = match result {
        Ok(snapshot) => snapshot,
        Err(error) => {
            transaction.rollback().await.c(h!())?;
            locked.release_unaccepted().c(h!())?;
            let capacity = matches!(
                error.downcast_ref::<FinalizationFailure>(),
                Some(FinalizationFailure::CapacityUnavailable)
            );
            let error = admission_error(error);
            if capacity {
                return Ok(ingress::mark_response(
                    super::DeviceAudioHttpError::from(error).error_response(),
                    AdmissionOutcome::CapacityUnavailable,
                ));
            }
            return Err(error);
        }
    };
    if let Err(error) = transaction.commit().await {
        log::warn!("audio finalization admission commit uncertain: {error:#}");
        return Err(
            unavailable("finalization admission must be retried").into()
        );
    }
    finalization::fault::point("audio_admission_committed", upload_id).await;
    Ok(response(snapshot))
}

pub(super) fn canonicalize(
    command: &mut ReceiveDeviceAudioCommand,
) -> anyhow::Result<(Uuid, u64)> {
    let prefix = format!("/api/device/audio/{}/uploads/", command.device_id);
    let name = command
        .upload_url
        .strip_prefix(&prefix)
        .ok_or(AppError::NotFound)
        .c(h!())?;
    let (upload, size) =
        crate::sigint::file_upload::tus::parse_request_file(name)
            .ok_or(AppError::NotFound)
            .c(h!())?;
    command.upload_url = format!("{prefix}{upload}.{size}");
    Ok((upload, size))
}

async fn replay(
    env: &Env,
    actor: Uuid,
    upload: Uuid,
    size: u64,
    command: &ReceiveDeviceAudioCommand,
) -> anyhow::Result<Option<HttpResponse>> {
    let db = env.device_audio.file_database().c(h!())?;
    let Some((job, _)) = jobs::read_audio_job(db, command.device_id, upload)
        .await
        .map_err(|_| unavailable("finalization outcome is unavailable"))
        .c(h!())?
    else {
        return async_adoption::adopt(env, actor, upload, size, command)
            .await
            .map(|snapshot| snapshot.map(response))
            .c(h!());
    };
    if job.created_by_login_id != actor {
        return Err(AppError::NotFound.into());
    }
    let snapshot = finalization::get_snapshot(env, job.id, actor)
        .await
        .c(h!())?;
    if job.audio_name.as_deref() != Some(command.name.as_str())
        || job.recording_started_at != Some(command.recording_started_at)
        || u64::try_from(job.source_size_bytes).ok() != Some(size)
    {
        return Err(query::conflict(
            "command_conflict",
            "Метадані прийнятого завантаження не можна змінити",
        ));
    }
    Ok(Some(response(snapshot)))
}

fn response(snapshot: FinalizationJobSnapshot) -> HttpResponse {
    let response = if matches!(
        snapshot.status,
        FinalizationStatus::FinalizationCompleted
            | FinalizationStatus::FinalizationFailed
    ) {
        HttpResponse::Ok().json(snapshot)
    } else {
        HttpResponse::Accepted()
            .insert_header((
                "Location",
                format!(
                    "/api/device/upload-finalization-jobs/{}",
                    snapshot.job_id
                ),
            ))
            .insert_header(("Retry-After", "1"))
            .json(QueuedAcknowledgement {
                status: QueuedStatus::FinalizationQueuedAcknowledgement,
                job_id: snapshot.job_id,
            })
    };
    no_store(response)
}

pub(super) fn no_store(mut response: HttpResponse) -> HttpResponse {
    response.headers_mut().insert(
        actix_web::http::header::CACHE_CONTROL,
        actix_web::http::header::HeaderValue::from_static("private, no-store"),
    );
    response
}

pub(super) fn admission_error(error: anyhow::Error) -> anyhow::Error {
    match error.downcast_ref::<FinalizationFailure>() {
        Some(FinalizationFailure::SourceOwned) => AppError::NotFound.into(),
        Some(FinalizationFailure::CommandConflict) => query::conflict(
            "command_conflict",
            "Метадані завантаження конфліктують",
        ),
        _ => unavailable(
            "async finalization admission is temporarily unavailable",
        )
        .into(),
    }
}

pub(super) async fn synchronous_outcome(
    runtime: &super::DeviceAudioRuntime,
    actor: Uuid,
    command: &ReceiveDeviceAudioCommand,
) -> anyhow::Result<Option<super::types::ReceiveDeviceAudioOutcome>> {
    let prefix = format!("/api/device/audio/{}/uploads/", command.device_id);
    let Some((upload, size)) = command
        .upload_url
        .strip_prefix(&prefix)
        .and_then(crate::sigint::file_upload::tus::parse_request_file)
    else {
        return Ok(None);
    };
    let Some((job, _)) = jobs::read_audio_job(
        runtime.file_database().c(h!())?,
        command.device_id,
        upload,
    )
    .await
    .c(h!())?
    else {
        return Ok(None);
    };
    if job.created_by_login_id != actor {
        return Err(AppError::NotFound.into());
    }
    if job.audio_name.as_deref() != Some(command.name.as_str())
        || job.recording_started_at != Some(command.recording_started_at)
        || u64::try_from(job.source_size_bytes).ok() != Some(size)
    {
        return Err(query::conflict(
            "device_audio_upload_metadata_conflict",
            "Метадані цього завантаження вже зафіксовано",
        ));
    }
    match job.status {
        FinalizationStatus::FinalizationCompleted => {
            Ok(Some(super::types::ReceiveDeviceAudioOutcome::Duplicate))
        }
        FinalizationStatus::FinalizationFailed => {
            match job.error_code.as_deref() {
                Some("invalid_audio") => {
                    Err(super::DeviceAudioMediaError::InvalidAudio {
                        reason: "asynchronous validation rejected the source"
                            .into(),
                    }
                    .into())
                }
                Some("unsupported_audio") => {
                    Err(super::DeviceAudioMediaError::UnsupportedMedia.into())
                }
                _ => Err(query::rejected()),
            }
        }
        _ => Err(unavailable(
            "source is owned by an asynchronous finalization",
        )
        .into()),
    }
}
