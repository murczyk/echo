use anyhow::{Context, Result};
use sea_orm::DatabaseConnection;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use super::{query, types::*};
use crate::h;

pub(crate) async fn repair_accounting(
    db: &DatabaseConnection,
    kind: FinalizationKind,
) -> Result<()> {
    let limit = crate::config::DEVICE_UPLOAD_FINALIZATION_ACCOUNTING_BATCH;
    let credits: Vec<Uuid> = sqlx::query_scalar("select a.id from device_upload_finalization_attempt a join device_upload_finalization_job j on j.id=a.job_id where a.write_credit_held and a.write_resolved_at is not null and j.kind=$1 order by a.write_resolved_at,a.id limit $2")
        .bind(kind.as_str()).bind(limit).fetch_all(db.get_postgres_connection_pool()).await.context(h!())?;
    for attempt in credits {
        query::release_write_credit(db, attempt)
            .await
            .context(h!())?;
    }
    let sources: Vec<Uuid> = sqlx::query_scalar("select id from device_upload_finalization_job where kind=$1 and status in ('completed','failed') and quota_released_at is null and source_release_state='released' order by updated_at,id limit $2")
        .bind(kind.as_str()).bind(limit).fetch_all(db.get_postgres_connection_pool()).await.context(h!())?;
    for job in sources {
        query::release_source_quota(db, job).await.context(h!())?;
    }
    Ok(())
}

pub(crate) async fn run_accounting_nofail(
    db: DatabaseConnection,
    kind: FinalizationKind,
    cancellation: tokio_util::sync::CancellationToken,
) {
    loop {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => return,
            result = repair_accounting(&db, kind) => {
                if let Err(error) = result { log::warn!("finalization accounting repair deferred: {error:#}"); }
            }
        }
        tokio::select! {
            _ = cancellation.cancelled() => return,
            _ = tokio::time::sleep(std::time::Duration::from_secs(crate::config::DEVICE_UPLOAD_FINALIZATION_POLL_SECONDS)) => {}
        }
    }
}

pub(crate) async fn retire_unwritten(
    db: &DatabaseConnection,
    claim: &ClaimedFinalizationJob,
) -> Result<()> {
    let mut transaction = db
        .get_postgres_connection_pool()
        .begin()
        .await
        .context(h!())?;
    anyhow::ensure!(
        query::lock_claim(&mut transaction, claim)
            .await
            .context(h!())?,
        FinalizationFailure::StaleClaim
    );
    sqlx::query("update device_upload_finalization_attempt set phase='retired',retired_at=clock_timestamp(),cleanup_next_at=clock_timestamp(),updated_at=clock_timestamp() where job_id=$1 and phase in ('preparing','prepared') and write_intent_at is null")
        .bind(claim.job_id).execute(&mut *transaction).await.context(h!())?;
    transaction.commit().await.context(h!())
}

pub(crate) async fn fail_file(
    db: &DatabaseConnection,
    claim: &ClaimedFinalizationJob,
    failure: FinalizationFailure,
) -> Result<bool> {
    let mut transaction = db
        .get_postgres_connection_pool()
        .begin()
        .await
        .context(h!())?;
    let binding = sqlx::query("select file_id,file_upload_id from device_upload_finalization_job where id=$1 and kind='file'")
        .bind(claim.job_id).fetch_one(&mut *transaction).await.context(h!())?;
    let file: Uuid = binding.try_get("file_id").context(h!())?;
    let upload: Uuid = binding.try_get("file_upload_id").context(h!())?;
    sqlx::query("select id from file_entry where id=$1 for update")
        .bind(file)
        .fetch_optional(&mut *transaction)
        .await
        .context(h!())?;
    sqlx::query("select id from file_content_upload where id=$1 for update")
        .bind(upload)
        .fetch_one(&mut *transaction)
        .await
        .context(h!())?;
    if !query::lock_claim(&mut transaction, claim)
        .await
        .context(h!())?
    {
        return Ok(false);
    }
    let uncertain: bool = sqlx::query_scalar("select exists(select 1 from device_upload_finalization_attempt where job_id=$1 and (phase='selected' or write_credit_held or (write_intent_at is not null and write_resolved_at is null))) or exists(select 1 from file_content_upload_object where upload_id=$2)")
        .bind(claim.job_id).bind(upload).fetch_one(&mut *transaction).await.context(h!())?;
    if uncertain {
        return Ok(false);
    }
    retire_attempts_in(&mut transaction, claim.job_id)
        .await
        .context(h!())?;
    retire_canonical_in(&mut transaction, claim)
        .await
        .context(h!())?;
    sqlx::query("update file_content_upload set status=$2::file_content_upload_status,next_cleanup_at=clock_timestamp() where id=$1 and status='open'")
        .bind(upload).bind(if failure == FinalizationFailure::TargetRevisionChanged { "stale" } else { "rejected" })
        .execute(&mut *transaction).await.context(h!())?;
    let diagnostic = failure.diagnostic();
    let action = serde_json::to_value(diagnostic.action).context(h!())?;
    let changed = sqlx::query("update device_upload_finalization_job set status='failed',finished_at=clock_timestamp(),updated_at=clock_timestamp(),lease_owner=null,lease_until=null,error_code=$4,error_message=$5,error_action=$6,source_release_state='release_pending' where id=$1 and lease_owner=$2 and lease_epoch=$3 and lease_until>clock_timestamp()")
        .bind(claim.job_id).bind(claim.owner).bind(claim.lease_epoch)
        .bind(diagnostic.code).bind(diagnostic.message).bind(action.as_str().context(h!())?)
        .execute(&mut *transaction).await.context(h!())?;
    anyhow::ensure!(
        changed.rows_affected() == 1,
        FinalizationFailure::StaleClaim
    );
    transaction.commit().await.context(h!())?;
    Ok(true)
}

pub(crate) async fn fail_audio(
    db: &DatabaseConnection,
    claim: &ClaimedFinalizationJob,
    failure: FinalizationFailure,
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
    let uncertain: bool = sqlx::query_scalar("select exists(select 1 from device_upload_finalization_attempt where job_id=$1 and (phase='selected' or write_credit_held or (write_intent_at is not null and write_resolved_at is null))) or exists(select 1 from device_audio a join device_upload_finalization_job j on j.audio_id=a.id where j.id=$1)")
        .bind(claim.job_id).fetch_one(&mut *transaction).await.context(h!())?;
    if uncertain {
        return Ok(false);
    }
    retire_attempts_in(&mut transaction, claim.job_id)
        .await
        .context(h!())?;
    let diagnostic = failure.diagnostic();
    let action = serde_json::to_value(diagnostic.action).context(h!())?;
    let changed = sqlx::query("update device_upload_finalization_job set status='failed',finished_at=clock_timestamp(),updated_at=clock_timestamp(),lease_owner=null,lease_until=null,error_code=$4,error_message=$5,error_action=$6,source_release_state='release_pending' where id=$1 and kind='audio' and lease_owner=$2 and lease_epoch=$3 and lease_until>clock_timestamp()")
        .bind(claim.job_id).bind(claim.owner).bind(claim.lease_epoch)
        .bind(diagnostic.code).bind(diagnostic.message).bind(action.as_str().context(h!())?)
        .execute(&mut *transaction).await.context(h!())?;
    anyhow::ensure!(
        changed.rows_affected() == 1,
        FinalizationFailure::StaleClaim
    );
    transaction.commit().await.context(h!())?;
    Ok(true)
}

async fn retire_canonical_in(
    connection: &mut PgConnection,
    claim: &ClaimedFinalizationJob,
) -> Result<()> {
    sqlx::query("insert into device_upload_finalization_attempt(id,job_id,kind,origin,ordinal,lease_epoch,file_upload_id,device_id,object_key,is_encrypted,source_size_bytes,phase,retired_at,cleanup_next_at,late_write_possible) select $1,j.id,'file','legacy_cleanup',(select coalesce(max(ordinal),0)+1 from device_upload_finalization_attempt where job_id=j.id),$3,u.id,u.device_id,u.object_key,false,j.source_size_bytes,'retired',clock_timestamp(),clock_timestamp(),true from device_upload_finalization_job j join file_content_upload u on u.id=j.file_upload_id where j.id=$2")
        .bind(Uuid::now_v7()).bind(claim.job_id).bind(claim.lease_epoch)
        .execute(connection).await.context(h!())?;
    Ok(())
}

async fn retire_attempts_in(
    connection: &mut PgConnection,
    job: Uuid,
) -> Result<()> {
    sqlx::query("update device_upload_finalization_attempt set phase='retired',retired_at=clock_timestamp(),cleanup_next_at=clock_timestamp(),late_write_possible=(write_intent_at is not null and write_acknowledged_at is null),updated_at=clock_timestamp() where job_id=$1 and phase not in ('retired','selected')")
        .bind(job).execute(connection).await.context(h!())?;
    Ok(())
}

pub(crate) async fn source_removed(
    db: &DatabaseConnection,
    job: Uuid,
) -> Result<()> {
    sqlx::query("update device_upload_finalization_job set source_release_state='released',source_released_at=coalesce(source_released_at,clock_timestamp()) where id=$1 and status in ('completed','failed')")
        .bind(job).execute(db.get_postgres_connection_pool()).await.context(h!())?;
    query::release_source_quota(db, job).await.context(h!())?;
    Ok(())
}
