use anyhow::{Context, Result};
use sea_orm::{
    sea_query::OnConflict, ActiveModelTrait, ConnectionTrait,
    DatabaseTransaction, DbBackend, EntityTrait, IntoActiveModel, Set,
    Statement, TransactionTrait, Value,
};
use uuid::Uuid;

use super::{probe::ProbedAudio, query, transcription, DeviceAudioRuntime};
use crate::devices::upload_finalization::{query::JobRecord, types::*};
use crate::{
    error::AppError,
    file_registry::entities::{device_audio, device_audio_ingest},
    h,
};

pub(super) async fn publish(
    runtime: &DeviceAudioRuntime,
    claim: &ClaimedFinalizationJob,
    job: &JobRecord,
    verified: &VerifiedFinalizationObject,
) -> Result<()> {
    let policy = Some(
        transcription::publication_guard(runtime, job.device_id)
            .await
            .context(h!())?,
    );
    let forwarding = policy
        .as_ref()
        .context(h!())?
        .forwarding_snapshot()
        .await
        .context(h!())?;
    authorize(runtime, job, policy.as_ref())
        .await
        .context(h!())?;
    let transaction = runtime
        .file_database()
        .context(h!())?
        .begin()
        .await
        .context(h!())?;
    let enabled =
        transcription::publication_setting(&transaction, job.device_id)
            .await
            .context(h!())?;
    validate_evidence(&transaction, claim, job, verified)
        .await
        .context(h!())?;
    authorize(runtime, job, policy.as_ref())
        .await
        .context(h!())?;
    let audio = publish_audio_in(&transaction, job, verified)
        .await
        .context(h!())?;
    transcription::publish(
        &transaction,
        audio.device_id,
        audio.id,
        enabled,
        policy.as_ref(),
    )
    .await
    .context(h!())?;
    authorize(runtime, job, policy.as_ref())
        .await
        .context(h!())?;
    super::forwarding::publish(
        &transaction,
        &audio,
        job.created_by_login_id,
        &forwarding,
    )
    .await
    .context(h!())?;
    complete(&transaction, claim, verified, &audio)
        .await
        .context(h!())?;
    let committed = match policy {
        Some(policy) => policy.commit_files(transaction).await,
        None => transaction.commit().await.map_err(Into::into),
    };
    if let Err(error) = committed {
        log::warn!(
            "audio publication commit requires reconciliation: {error:#}"
        );
        return Err(FinalizationFailure::StorageOutcomeUnknown.into());
    }
    Ok(())
}

async fn authorize(
    runtime: &DeviceAudioRuntime,
    job: &JobRecord,
    policy: Option<&transcription::guards::MainGuard>,
) -> Result<()> {
    let result = match policy {
        Some(policy) => policy.authorize_source(job.created_by_login_id).await,
        None => {
            super::authorize_source(
                runtime,
                job.created_by_login_id,
                job.device_id,
            )
            .await
        }
    };
    result.map_err(|error| match error.downcast_ref::<AppError>() {
        Some(
            AppError::Unauthenticated
            | AppError::Forbidden(_)
            | AppError::ForbiddenWithHeader { .. },
        ) => FinalizationFailure::PublicationForbidden.into(),
        Some(AppError::NotFound | AppError::Form(_)) => {
            FinalizationFailure::TargetUnavailable.into()
        }
        _ => error,
    })
}

fn statement(sql: &str, values: Vec<Value>) -> Statement {
    Statement::from_sql_and_values(DbBackend::Postgres, sql, values)
}

async fn validate_evidence(
    transaction: &DatabaseTransaction,
    claim: &ClaimedFinalizationJob,
    job: &JobRecord,
    verified: &VerifiedFinalizationObject,
) -> Result<()> {
    let row = transaction.query_one_raw(statement("select id from device_upload_finalization_job where id=$1 and kind='audio' and status in ('processing','outcome_unknown') and lease_owner=$2 and lease_epoch=$3 and lease_until>clock_timestamp() and active_attempt_id=$4 for update",
        vec![claim.job_id.into(), claim.owner.into(), claim.lease_epoch.into(), verified.attempt_id.into()])).await.context(h!())?;
    anyhow::ensure!(row.is_some(), FinalizationFailure::StaleClaim);
    let row = transaction.query_one_raw(statement("select object_key,source_size_bytes,source_sha256,is_encrypted,media_type,duration_seconds,recording_ended_at from device_upload_finalization_attempt where id=$1 and job_id=$2 and kind='audio' and device_id=$3 and audio_id=$4 and phase='verified' and verified_at is not null and not write_credit_held and write_resolved_at is not null for update",
        vec![verified.attempt_id.into(), job.id.into(), job.device_id.into(), job.audio_id.context(h!())?.into()])).await.context(h!())?.context(h!())?;
    let media = verified.audio.as_ref().context(h!())?;
    anyhow::ensure!(
        verified.is_encrypted
            && row.try_get::<bool>("", "is_encrypted").context(h!())?
            && row.try_get::<String>("", "object_key").context(h!())?
                == verified.object_key
            && row.try_get::<i64>("", "source_size_bytes").context(h!())?
                == job.source_size_bytes
            && verified.source_size_bytes == job.source_size_bytes
            && row.try_get::<Vec<u8>>("", "source_sha256").context(h!())?
                == verified.source_sha256
            && row.try_get::<String>("", "media_type").context(h!())?
                == media.media_type
            && row.try_get::<f64>("", "duration_seconds").context(h!())?
                == media.duration_seconds
            && row
                .try_get::<chrono::DateTime<chrono::Utc>>(
                    "",
                    "recording_ended_at"
                )
                .context(h!())?
                == media.recording_ended_at,
        FinalizationFailure::StorageOutcomeUnknown
    );
    Ok(())
}

async fn publish_audio_in(
    transaction: &DatabaseTransaction,
    job: &JobRecord,
    verified: &VerifiedFinalizationObject,
) -> Result<device_audio::Model> {
    let audio_id = job.audio_id.context(h!())?;
    let name = job.audio_name.as_ref().context(h!())?;
    let media = verified.audio.as_ref().context(h!())?;
    let start = job.recording_started_at.context(h!())?;
    let duration_us = (media.recording_ended_at - start)
        .num_microseconds()
        .context(h!())?;
    anyhow::ensure!(
        duration_us > 0
            && duration_us as f64
                / super::DEVICE_AUDIO_MICROSECONDS_PER_SECOND as f64
                == media.duration_seconds,
        FinalizationFailure::StorageOutcomeUnknown
    );
    let mime_type = match media.media_type.as_str() {
        "audio/wav" => "audio/wav",
        "audio/mpeg" => "audio/mpeg",
        _ => return Err(FinalizationFailure::UnsupportedAudio.into()),
    };
    let media = ProbedAudio {
        duration_us,
        mime_type,
        recording_ended_at: media.recording_ended_at,
    };
    let tus = job
        .source_identity
        .split_once('/')
        .context(h!())?
        .1
        .parse::<Uuid>()
        .context(h!())?;
    let now = chrono::Utc::now().fixed_offset();
    let ingest = device_audio_ingest::ActiveModel {
        id: Set(verified.attempt_id),
        audio_id: Set(audio_id),
        device_id: Set(job.device_id),
        actor_id: Set(job.created_by_login_id),
        tus_owner_id: Set(job.created_by_login_id),
        tus_upload_ref: Set(job.upload_url.clone().context(h!())?),
        tus_upload_id: Set(tus),
        name: Set(name.clone()),
        name_key: Set(name.as_bytes().to_vec()),
        recording_started_at: Set(start.fixed_offset()),
        created_at: Set(now),
        heartbeat_at: Set(now),
        storage_key: Set(verified.object_key.clone()),
        status: Set("finalizing".into()),
        lease_token: Set(Uuid::new_v4()),
        source_size_bytes: Set(None),
        source_sha256: Set(None),
        duration_us: Set(None),
        mime_type: Set(None),
        cleanup_token: Set(None),
        next_cleanup_at: Set(None),
        source_consumed_at: Set(None),
        last_error: Set(None),
    }
    .insert(transaction)
    .await
    .context(h!())?;
    let mut ingest = ingest.into_active_model();
    ingest.status = Set("storing".into());
    ingest.source_size_bytes = Set(Some(verified.source_size_bytes));
    ingest.source_sha256 = Set(Some(verified.source_sha256.to_vec()));
    ingest.duration_us = Set(Some(duration_us));
    ingest.mime_type = Set(Some(mime_type.into()));
    let ingest = ingest.update(transaction).await.context(h!())?;
    let inserted = device_audio::Entity::insert(
        query::ready_audio(&ingest, &media).context(h!())?,
    )
    .on_conflict(
        OnConflict::columns([
            device_audio::Column::DeviceId,
            device_audio::Column::NameKey,
        ])
        .do_nothing()
        .to_owned(),
    )
    .exec_without_returning(transaction)
    .await
    .context(h!())?;
    anyhow::ensure!(inserted == 1, FinalizationFailure::AudioNameConflict);
    let mut ingest = ingest.into_active_model();
    ingest.status = Set("ready".into());
    let ingest = ingest.update(transaction).await.context(h!())?;
    query::own_ready(transaction, &ingest)
        .await
        .context(h!())?
        .context(h!())
}

async fn complete(
    transaction: &DatabaseTransaction,
    claim: &ClaimedFinalizationJob,
    verified: &VerifiedFinalizationObject,
    audio: &device_audio::Model,
) -> Result<()> {
    transaction.execute_raw(statement("update device_upload_finalization_attempt set phase='selected',updated_at=clock_timestamp() where id=$1 and phase='verified'", vec![verified.attempt_id.into()])).await.context(h!())?;
    let result = serde_json::json!({"version":1,"value":{"audio":query::audio_summary(audio)}});
    let changed = transaction.execute_raw(statement("update device_upload_finalization_job set status='completed',winning_attempt_id=$4,result=$5,finished_at=clock_timestamp(),updated_at=clock_timestamp(),lease_owner=null,lease_until=null,error_code=null,error_message=null,error_action=null,source_release_state='release_pending' where id=$1 and lease_owner=$2 and lease_epoch=$3 and lease_until>clock_timestamp() and status in ('processing','outcome_unknown')",
        vec![claim.job_id.into(), claim.owner.into(), claim.lease_epoch.into(), verified.attempt_id.into(), result.into()])).await.context(h!())?;
    anyhow::ensure!(
        changed.rows_affected() == 1,
        FinalizationFailure::StaleClaim
    );
    Ok(())
}
