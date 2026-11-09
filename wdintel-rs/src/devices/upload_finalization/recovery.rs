use anyhow::{Context, Result};
use rand::Rng;
use sea_orm::DatabaseConnection;
use sqlx::Row;

use super::{query, types::*};
use crate::{h, types::DeviceUploadFinalizationSettings};

pub(crate) fn retry_delay(
    settings: &DeviceUploadFinalizationSettings,
    attempts: i64,
    dependency_hint: Option<u64>,
) -> u64 {
    let maximum = settings.retry_max_seconds.max(1);
    let exponential = settings
        .retry_min_seconds
        .max(1)
        .saturating_mul(
            1_u64
                .checked_shl(attempts.clamp(0, 63) as u32)
                .unwrap_or(u64::MAX),
        )
        .min(maximum);
    let jitter = rand::rng().random_range(1..=exponential);
    jitter.max(dependency_hint.unwrap_or(1)).min(maximum)
}

pub(crate) async fn schedule_retry(
    db: &DatabaseConnection,
    claim: &ClaimedFinalizationJob,
    failure: &FinalizationFailure,
    unknown: bool,
    delay_seconds: u64,
) -> Result<bool> {
    let mut transaction = db
        .get_postgres_connection_pool()
        .begin()
        .await
        .context(h!())?;
    if !query::lock_claim(&mut transaction, claim)
        .await
        .context(h!())?
    {
        return Ok(false);
    }
    let row = sqlx::query("select exists(select 1 from device_upload_finalization_attempt where job_id=$1 and ((write_intent_at is not null and phase not in ('retired','selected')) or write_credit_held)) as uncertain")
        .bind(claim.job_id).fetch_one(&mut *transaction).await.context(h!())?;
    let unknown =
        unknown || row.try_get::<bool, _>("uncertain").context(h!())?;
    let diagnostic = if unknown {
        FinalizationFailure::StorageOutcomeUnknown.diagnostic()
    } else {
        failure.diagnostic()
    };
    let delay = delay_seconds.clamp(
        1,
        crate::config::DEVICE_UPLOAD_FINALIZATION_POLL_MAX_SECONDS,
    ) as i64;
    sqlx::query("update device_upload_finalization_job set status=$4,updated_at=clock_timestamp(),next_run_at=clock_timestamp()+$5*interval '1 second',lease_owner=null,lease_until=null,error_code=$6,error_message=$7,error_action='retry_poll' where id=$1 and lease_owner=$2 and lease_epoch=$3")
        .bind(claim.job_id).bind(claim.owner).bind(claim.lease_epoch)
        .bind(if unknown {"outcome_unknown"} else {"retry_wait"}).bind(delay)
        .bind(diagnostic.code).bind(diagnostic.message).execute(&mut *transaction).await.context(h!())?;
    transaction.commit().await.context(h!())?;
    Ok(true)
}

pub(crate) async fn retry_not_dispatched(
    db: &DatabaseConnection,
    claim: &ClaimedFinalizationJob,
) -> Result<bool> {
    let mut transaction = db
        .get_postgres_connection_pool()
        .begin()
        .await
        .context(h!())?;
    if !query::lock_claim(&mut transaction, claim)
        .await
        .context(h!())?
    {
        return Ok(false);
    }
    let diagnostic = FinalizationFailure::DependencyUnavailable.diagnostic();
    let changed = sqlx::query("update device_upload_finalization_job j set status='retry_wait',next_run_at=clock_timestamp(),lease_owner=null,lease_until=null,error_code=$2,error_message=$3,error_action='retry_poll',updated_at=clock_timestamp() where j.id=$1 and j.status='outcome_unknown' and j.winning_attempt_id is null and exists(select 1 from device_upload_finalization_attempt a where a.id=j.active_attempt_id and a.phase='retired' and a.last_error_code='write_not_dispatched' and a.write_resolved_at is not null and not a.write_credit_held) and not exists(select 1 from device_upload_finalization_attempt a where a.job_id=j.id and ((a.write_intent_at is not null and a.phase not in ('retired','selected')) or a.write_credit_held))")
        .bind(claim.job_id).bind(diagnostic.code).bind(diagnostic.message).execute(&mut *transaction).await.context(h!())?;
    transaction.commit().await.context(h!())?;
    Ok(changed.rows_affected() == 1)
}

#[derive(Debug)]
pub(crate) enum Reconciliation {
    Published,
    Verified(VerifiedFinalizationObject),
    Retired,
    /// The attempt's object is absent; its write never completed.
    Missing(uuid::Uuid),
    Unresolved,
}
