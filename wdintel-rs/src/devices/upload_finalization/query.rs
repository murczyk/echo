use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use sea_orm::DatabaseConnection;
use serde::Deserialize;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

use super::types::*;
use crate::h;

#[derive(Debug, Deserialize)]
pub(crate) struct JobRecord {
    pub id: Uuid,
    pub kind: FinalizationKind,
    pub source_identity: String,
    pub created_by_login_id: Uuid,
    pub device_id: Uuid,
    pub file_upload_id: Option<Uuid>,
    pub file_id: Option<Uuid>,
    pub revision: Option<i64>,
    pub audio_id: Option<Uuid>,
    pub pin_token: Option<Uuid>,
    pub source_locator: Option<String>,
    pub upload_url: Option<String>,
    pub audio_name: Option<String>,
    pub recording_started_at: Option<DateTime<Utc>>,
    pub source_size_bytes: i64,
    pub status: FinalizationStatus,
    pub active_attempt_id: Option<Uuid>,
    pub winning_attempt_id: Option<Uuid>,
    pub attempt_count: i64,
    pub source_release_state: String,
    pub quota_released_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub next_run_at: DateTime<Utc>,
    pub result: Option<StoredResult>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub error_action: Option<FinalizationAction>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct StoredResult {
    pub version: u32,
    pub value: FinalizationResult,
}

impl JobRecord {
    pub(crate) fn is_sync_adoption(&self) -> bool {
        self.status == FinalizationStatus::FinalizationCompleted
            && self.active_attempt_id.is_none()
            && self.winning_attempt_id.is_none()
            && self.attempt_count == 0
            && self.source_release_state == "released"
            && self.quota_released_at.is_some()
    }

    pub(crate) fn snapshot(
        self,
        now: DateTime<Utc>,
    ) -> Result<FinalizationJobSnapshot> {
        let terminal = matches!(
            self.status,
            FinalizationStatus::FinalizationCompleted
                | FinalizationStatus::FinalizationFailed
        );
        let result = match self.result {
            Some(result) => {
                anyhow::ensure!(
                    result.version == 1,
                    "unsupported finalization result version"
                );
                anyhow::ensure!(
                    matches!(
                        (&self.kind, &result.value),
                        (
                            FinalizationKind::FinalizationFileKind,
                            FinalizationResult::FinalizationFileResult(_)
                        ) | (
                            FinalizationKind::FinalizationAudioKind,
                            FinalizationResult::FinalizationAudioResult(_)
                        )
                    ),
                    "invalid finalization result kind"
                );
                Some(result.value)
            }
            None => None,
        };
        let error =
            match (self.error_code, self.error_message, self.error_action) {
                (Some(code), Some(message), Some(action)) => {
                    Some(FinalizationError {
                        code,
                        message,
                        action,
                    })
                }
                (None, None, None) => None,
                _ => anyhow::bail!("invalid finalization diagnostic"),
            };
        Ok(FinalizationJobSnapshot {
            job_id: self.id,
            kind: self.kind,
            status: self.status,
            created_at: self.created_at.to_rfc3339(),
            updated_at: self.updated_at.to_rfc3339(),
            finished_at: self.finished_at.map(|time| time.to_rfc3339()),
            retry_after_seconds: (!terminal).then(|| {
                (self.next_run_at - now).num_seconds().clamp(
                    1,
                    crate::config::DEVICE_UPLOAD_FINALIZATION_POLL_MAX_SECONDS
                        as i64,
                ) as u64
            }),
            result,
            error,
        })
    }

    pub(super) fn matches(&self, command: &FinalizationCommand) -> bool {
        if self.device_id != command.device_id
            || self.source_size_bytes != command.source_size_bytes
            || self.source_identity != command.source_identity()
            || self.kind != command.kind()
        {
            return false;
        }
        match &command.target {
            FinalizationTarget::File {
                upload_id,
                file_id,
                revision,
            } => {
                self.file_upload_id == Some(*upload_id)
                    && self.file_id == Some(*file_id)
                    && self.revision == Some(*revision)
            }
            FinalizationTarget::Audio {
                name,
                recording_started_at,
                ..
            } => {
                self.audio_name.as_deref() == Some(name.as_str())
                    && self.recording_started_at.is_some_and(|time| {
                        time.timestamp_micros()
                            == recording_started_at.timestamp_micros()
                    })
            }
        }
    }
}

pub(crate) async fn read_job(
    db: &DatabaseConnection,
    id: Uuid,
) -> Result<Option<(JobRecord, DateTime<Utc>)>> {
    let row = sqlx::query("select to_jsonb(j) as job, clock_timestamp() as now from device_upload_finalization_job j where id = $1")
        .bind(id).fetch_optional(db.get_postgres_connection_pool()).await.context(h!())?;
    row.map(decode_job).transpose().context(h!())
}

pub(super) fn decode_job(
    row: sqlx::postgres::PgRow,
) -> Result<(JobRecord, DateTime<Utc>)> {
    let job: serde_json::Value = row.try_get("job").context(h!())?;
    Ok((
        serde_json::from_value(job).context(h!())?,
        row.try_get("now").context(h!())?,
    ))
}

pub(super) async fn lock_budgets(
    connection: &mut PgConnection,
    kind: FinalizationKind,
    actor: Uuid,
) -> Result<(String, String)> {
    let global = format!("global:{}", kind.as_str());
    let actor = format!("actor:{actor}:{}", kind.as_str());
    for scope in [&global, &actor] {
        sqlx::query("insert into device_upload_finalization_budget(scope) values ($1) on conflict do nothing")
            .bind(scope).execute(&mut *connection).await.context(h!())?;
        sqlx::query("select scope from device_upload_finalization_budget where scope = $1 for update")
            .bind(scope).fetch_one(&mut *connection).await.context(h!())?;
    }
    Ok((global, actor))
}

pub(crate) async fn is_current(
    db: &DatabaseConnection,
    claim: &ClaimedFinalizationJob,
) -> Result<bool> {
    let row = sqlx::query("select exists(select 1 from device_upload_finalization_job where id = $1 and lease_owner = $2 and lease_epoch = $3 and lease_until > clock_timestamp() and status in ('processing','outcome_unknown')) as current")
        .bind(claim.job_id).bind(claim.owner).bind(claim.lease_epoch)
        .fetch_one(db.get_postgres_connection_pool()).await.context(h!())?;
    row.try_get("current").context(h!())
}

pub(crate) async fn heartbeat(
    db: &DatabaseConnection,
    claim: &ClaimedFinalizationJob,
    lease_seconds: u64,
) -> Result<bool> {
    let lease_seconds = i64::try_from(lease_seconds).context(h!())?;
    anyhow::ensure!(lease_seconds > 0, "invalid lease duration");
    let result = sqlx::query("update device_upload_finalization_job set lease_until = clock_timestamp() + $4 * interval '1 second' where id = $1 and lease_owner = $2 and lease_epoch = $3 and lease_until > clock_timestamp() and status in ('processing','outcome_unknown')")
        .bind(claim.job_id).bind(claim.owner).bind(claim.lease_epoch).bind(lease_seconds)
        .execute(db.get_postgres_connection_pool()).await.context(h!())?;
    Ok(result.rows_affected() == 1)
}

pub(crate) async fn lock_claim(
    connection: &mut PgConnection,
    claim: &ClaimedFinalizationJob,
) -> Result<bool> {
    let row = sqlx::query("select id from device_upload_finalization_job where id = $1 and lease_owner = $2 and lease_epoch = $3 and lease_until > clock_timestamp() and status in ('processing','outcome_unknown') for update")
        .bind(claim.job_id).bind(claim.owner).bind(claim.lease_epoch)
        .fetch_optional(connection).await.context(h!())?;
    Ok(row.is_some())
}

pub(crate) async fn create_attempt(
    db: &DatabaseConnection,
    claim: &ClaimedFinalizationJob,
    is_encrypted: bool,
) -> Result<Uuid> {
    let mut transaction = db
        .get_postgres_connection_pool()
        .begin()
        .await
        .context(h!())?;
    anyhow::ensure!(
        lock_claim(&mut transaction, claim).await.context(h!())?,
        FinalizationFailure::StaleClaim
    );
    let row = sqlx::query("select active_attempt_id from device_upload_finalization_job where id = $1")
        .bind(claim.job_id).fetch_one(&mut *transaction).await.context(h!())?;
    let existing: Option<Uuid> =
        row.try_get("active_attempt_id").context(h!())?;
    if let Some(id) = existing {
        let phase: String = sqlx::query_scalar("select phase from device_upload_finalization_attempt where id = $1")
            .bind(id).fetch_one(&mut *transaction).await.context(h!())?;
        anyhow::ensure!(
            phase == "retired",
            FinalizationFailure::StorageOutcomeUnknown
        );
        let unresolved: bool = sqlx::query_scalar("select exists(select 1 from device_upload_finalization_attempt where job_id = $1 and write_credit_held)")
            .bind(claim.job_id).fetch_one(&mut *transaction).await.context(h!())?;
        anyhow::ensure!(
            !unresolved,
            FinalizationFailure::StorageOutcomeUnknown
        );
    }
    let id = Uuid::now_v7();
    sqlx::query("insert into device_upload_finalization_attempt(id,job_id,kind,ordinal,lease_epoch,file_upload_id,device_id,audio_id,object_key,is_encrypted,source_size_bytes) select $1,j.id,j.kind,coalesce((select max(ordinal)+1 from device_upload_finalization_attempt where job_id=j.id),1),j.lease_epoch,j.file_upload_id,j.device_id,j.audio_id,case j.kind when 'file' then 'device-file-finalization/'||j.file_upload_id::text||'/'||$1::text else 'device-audio/'||j.device_id::text||'/'||j.audio_id::text||'/'||$1::text end,$3,j.source_size_bytes from device_upload_finalization_job j where j.id=$2")
        .bind(id).bind(claim.job_id).bind(is_encrypted).execute(&mut *transaction).await.context(h!())?;
    sqlx::query("update device_upload_finalization_job set active_attempt_id=$2 where id=$1")
        .bind(claim.job_id).bind(id).execute(&mut *transaction).await.context(h!())?;
    transaction.commit().await.context(h!())?;
    Ok(id)
}

pub(crate) async fn prepare_attempt(
    db: &DatabaseConnection,
    claim: &ClaimedFinalizationJob,
    attempt_id: Uuid,
    size: i64,
    sha256: &[u8; 32],
    audio: Option<&PreparedAudio>,
) -> Result<bool> {
    let mut transaction = db
        .get_postgres_connection_pool()
        .begin()
        .await
        .context(h!())?;
    if !lock_claim(&mut transaction, claim).await.context(h!())? {
        return Ok(false);
    }
    let result = sqlx::query("update device_upload_finalization_attempt a set phase='prepared',source_size_bytes=$3,source_sha256=$4,media_type=$5,duration_seconds=$6,recording_ended_at=$7,updated_at=clock_timestamp() from device_upload_finalization_job j where a.id=$1 and a.job_id=$2 and a.phase='preparing' and j.id=a.job_id and j.active_attempt_id=a.id")
        .bind(attempt_id).bind(claim.job_id).bind(size).bind(sha256.as_slice())
        .bind(audio.map(|a| a.media_type.as_str())).bind(audio.map(|a| a.duration_seconds))
        .bind(audio.map(|a| a.recording_ended_at)).execute(&mut *transaction).await.context(h!())?;
    transaction.commit().await.context(h!())?;
    Ok(result.rows_affected() == 1)
}

pub(crate) async fn record_write_intent(
    db: &DatabaseConnection,
    claim: &ClaimedFinalizationJob,
    attempt_id: Uuid,
    limit: u32,
) -> Result<bool> {
    let mut transaction = db
        .get_postgres_connection_pool()
        .begin()
        .await
        .context(h!())?;
    let actor: Uuid = sqlx::query_scalar("select created_by_login_id from device_upload_finalization_job where id=$1")
        .bind(claim.job_id).fetch_one(&mut *transaction).await.context(h!())?;
    let (global, _) = lock_budgets(&mut transaction, claim.kind, actor)
        .await
        .context(h!())?;
    if !lock_claim(&mut transaction, claim).await.context(h!())? {
        return Ok(false);
    }
    let available: bool = sqlx::query_scalar("select unresolved_writes < $2 from device_upload_finalization_budget where scope=$1")
        .bind(&global).bind(i64::from(limit)).fetch_one(&mut *transaction).await.context(h!())?;
    if !available {
        let dispatchable: bool = sqlx::query_scalar("select exists(select 1 from device_upload_finalization_attempt a join device_upload_finalization_job j on j.id=a.job_id where a.id=$1 and a.job_id=$2 and a.phase='prepared' and j.active_attempt_id=a.id and j.status='processing' and not exists(select 1 from device_upload_finalization_attempt other where other.job_id=j.id and other.write_credit_held))")
            .bind(attempt_id).bind(claim.job_id).fetch_one(&mut *transaction).await.context(h!())?;
        anyhow::ensure!(
            !dispatchable,
            FinalizationFailure::CapacityUnavailable
        );
        return Ok(false);
    }
    let changed = sqlx::query("update device_upload_finalization_attempt a set phase='write_intent',write_intent_at=clock_timestamp(),write_credit_held=true,updated_at=clock_timestamp() from device_upload_finalization_job j where a.id=$1 and a.job_id=$2 and a.phase='prepared' and j.id=a.job_id and j.active_attempt_id=a.id and j.status='processing' and not exists(select 1 from device_upload_finalization_attempt other where other.job_id=j.id and other.write_credit_held)")
        .bind(attempt_id).bind(claim.job_id).execute(&mut *transaction).await.context(h!())?;
    if changed.rows_affected() != 1 {
        return Ok(false);
    }
    sqlx::query("update device_upload_finalization_budget set unresolved_writes=unresolved_writes+1 where scope=$1")
        .bind(global).execute(&mut *transaction).await.context(h!())?;
    transaction.commit().await.context(h!())?;
    Ok(true)
}

pub(crate) async fn record_not_dispatched(
    db: &DatabaseConnection,
    claim: &ClaimedFinalizationJob,
    attempt_id: Uuid,
) -> Result<()> {
    let mut transaction = db
        .get_postgres_connection_pool()
        .begin()
        .await
        .context(h!())?;
    let actor: Uuid = sqlx::query_scalar("select created_by_login_id from device_upload_finalization_job where id=$1 and kind=$2")
        .bind(claim.job_id).bind(claim.kind.as_str()).fetch_one(&mut *transaction).await.context(h!())?;
    let (global, _) = lock_budgets(&mut transaction, claim.kind, actor)
        .await
        .context(h!())?;
    sqlx::query(
        "select id from device_upload_finalization_job where id=$1 for update",
    )
    .bind(claim.job_id)
    .fetch_one(&mut *transaction)
    .await
    .context(h!())?;
    // This is evidence about the exact operation, not authority to mutate its job.
    let credit: Option<bool> = sqlx::query_scalar("select write_credit_held from device_upload_finalization_attempt where id=$1 and job_id=$2 and lease_epoch=$3 and origin='async' and phase='write_intent' and write_acknowledged_at is null and verified_at is null for update")
        .bind(attempt_id).bind(claim.job_id).bind(claim.lease_epoch)
        .fetch_optional(&mut *transaction).await.context(h!())?;
    if let Some(credit) = credit {
        sqlx::query("update device_upload_finalization_attempt set phase='retired',write_resolved_at=coalesce(write_resolved_at,clock_timestamp()),write_credit_held=false,retired_at=clock_timestamp(),cleanup_confirmed_at=clock_timestamp(),last_error_code='write_not_dispatched',updated_at=clock_timestamp() where id=$1")
            .bind(attempt_id).execute(&mut *transaction).await.context(h!())?;
        if credit {
            sqlx::query("update device_upload_finalization_budget set unresolved_writes=unresolved_writes-1 where scope=$1")
                .bind(global).execute(&mut *transaction).await.context(h!())?;
        }
    }
    transaction.commit().await.context(h!())?;
    Ok(())
}

/// Retires an active write whose object is absent once its lease and write
/// timeout have passed, so the job can dispatch a fresh attempt. A late write
/// may still land, so cleanup keeps rechecking the retired key.
pub(crate) async fn retire_unconfirmed_write(
    db: &DatabaseConnection,
    claim: &ClaimedFinalizationJob,
    attempt_id: Uuid,
    write_timeout_seconds: u64,
) -> Result<bool> {
    let mut transaction = db
        .get_postgres_connection_pool()
        .begin()
        .await
        .context(h!())?;
    let actor: Uuid = sqlx::query_scalar("select created_by_login_id from device_upload_finalization_job where id=$1")
        .bind(claim.job_id).fetch_one(&mut *transaction).await.context(h!())?;
    let (global, _) = lock_budgets(&mut transaction, claim.kind, actor)
        .await
        .context(h!())?;
    if !lock_claim(&mut transaction, claim).await.context(h!())? {
        return Ok(false);
    }
    let timeout = i64::try_from(write_timeout_seconds).context(h!())?;
    let credit: Option<bool> = sqlx::query_scalar("select a.write_credit_held from device_upload_finalization_attempt a join device_upload_finalization_job j on j.id=a.job_id and j.active_attempt_id=a.id where a.id=$1 and a.job_id=$2 and a.lease_epoch<$3 and a.origin='async' and a.phase='write_intent' and a.write_acknowledged_at is null and a.verified_at is null and a.write_intent_at<clock_timestamp()-$4*interval '1 second' for update of a")
        .bind(attempt_id).bind(claim.job_id).bind(claim.lease_epoch).bind(timeout)
        .fetch_optional(&mut *transaction).await.context(h!())?;
    let Some(credit) = credit else {
        return Ok(false);
    };
    sqlx::query("update device_upload_finalization_attempt set phase='retired',write_resolved_at=coalesce(write_resolved_at,clock_timestamp()),write_credit_held=false,retired_at=clock_timestamp(),cleanup_next_at=clock_timestamp(),late_write_possible=true,last_error_code='write_unconfirmed',updated_at=clock_timestamp() where id=$1")
        .bind(attempt_id).execute(&mut *transaction).await.context(h!())?;
    if credit {
        sqlx::query("update device_upload_finalization_budget set unresolved_writes=unresolved_writes-1 where scope=$1")
            .bind(global).execute(&mut *transaction).await.context(h!())?;
    }
    let diagnostic = FinalizationFailure::DependencyUnavailable.diagnostic();
    sqlx::query("update device_upload_finalization_job set status='retry_wait',next_run_at=clock_timestamp(),lease_owner=null,lease_until=null,error_code=$2,error_message=$3,error_action='retry_poll',updated_at=clock_timestamp() where id=$1")
        .bind(claim.job_id).bind(diagnostic.code).bind(diagnostic.message)
        .execute(&mut *transaction).await.context(h!())?;
    transaction.commit().await.context(h!())?;
    Ok(true)
}

pub(crate) async fn record_write_resolution(
    db: &DatabaseConnection,
    claim: &ClaimedFinalizationJob,
    attempt_id: Uuid,
    evidence: WriteResolution,
) -> Result<bool> {
    let mut transaction = db
        .get_postgres_connection_pool()
        .begin()
        .await
        .context(h!())?;
    if !lock_claim(&mut transaction, claim).await.context(h!())? {
        return Ok(false);
    }
    let result = sqlx::query("update device_upload_finalization_attempt set write_resolved_at=clock_timestamp(),write_acknowledged_at=case when $3 then clock_timestamp() else write_acknowledged_at end,updated_at=clock_timestamp() where id=$1 and job_id=$2 and write_intent_at is not null and write_resolved_at is null")
        .bind(attempt_id).bind(claim.job_id).bind(matches!(evidence, WriteResolution::Acknowledged)).execute(&mut *transaction).await.context(h!())?;
    transaction.commit().await.context(h!())?;
    Ok(result.rows_affected() == 1)
}

pub(crate) async fn release_write_credit(
    db: &DatabaseConnection,
    attempt_id: Uuid,
) -> Result<bool> {
    let mut transaction = db
        .get_postgres_connection_pool()
        .begin()
        .await
        .context(h!())?;
    let row = sqlx::query("select j.kind,j.created_by_login_id from device_upload_finalization_attempt a join device_upload_finalization_job j on j.id=a.job_id where a.id=$1")
        .bind(attempt_id).fetch_one(&mut *transaction).await.context(h!())?;
    let kind: String = row.try_get("kind").context(h!())?;
    let kind = if kind == "file" {
        FinalizationKind::FinalizationFileKind
    } else {
        FinalizationKind::FinalizationAudioKind
    };
    let (global, _) = lock_budgets(
        &mut transaction,
        kind,
        row.try_get("created_by_login_id").context(h!())?,
    )
    .await
    .context(h!())?;
    let changed = sqlx::query("update device_upload_finalization_attempt set write_credit_held=false,updated_at=clock_timestamp() where id=$1 and write_credit_held and write_resolved_at is not null")
        .bind(attempt_id).execute(&mut *transaction).await.context(h!())?;
    if changed.rows_affected() != 1 {
        return Ok(false);
    }
    sqlx::query("update device_upload_finalization_budget set unresolved_writes=unresolved_writes-1 where scope=$1")
        .bind(global).execute(&mut *transaction).await.context(h!())?;
    transaction.commit().await.context(h!())?;
    Ok(true)
}

pub(crate) async fn release_source_quota(
    db: &DatabaseConnection,
    job_id: Uuid,
) -> Result<bool> {
    let Some((job, _)) = read_job(db, job_id).await.context(h!())? else {
        return Ok(false);
    };
    let mut transaction = db
        .get_postgres_connection_pool()
        .begin()
        .await
        .context(h!())?;
    let (global, actor) =
        lock_budgets(&mut transaction, job.kind, job.created_by_login_id)
            .await
            .context(h!())?;
    let changed = sqlx::query("update device_upload_finalization_job set quota_released_at=clock_timestamp() where id=$1 and source_release_state='released' and quota_released_at is null")
        .bind(job_id).execute(&mut *transaction).await.context(h!())?;
    if changed.rows_affected() != 1 {
        return Ok(false);
    }
    sqlx::query("update device_upload_finalization_budget set reserved_jobs=reserved_jobs-1,reserved_source_bytes=reserved_source_bytes-$3 where scope in ($1,$2)")
        .bind(global).bind(actor).bind(job.source_size_bytes).execute(&mut *transaction).await.context(h!())?;
    transaction.commit().await.context(h!())?;
    Ok(true)
}

pub(crate) async fn exact_publication(
    db: &DatabaseConnection,
    claim: &ClaimedFinalizationJob,
) -> Result<bool> {
    sqlx::query_scalar(r#"select exists(
        select 1 from device_upload_finalization_job j where j.id=$1 and (
            (j.kind='file' and exists(select 1 from file_content c
                join file_content_upload u on u.id=c.upload_id
                where c.upload_id=j.file_upload_id and c.file_id=j.file_id and c.revision=j.revision
                    and u.created_by_login_id=j.created_by_login_id and u.status='completed'))
            or (j.kind='audio' and exists(select 1 from device_audio a
                join device_audio_ingest i on i.id=a.ingest_id
                where a.id=j.audio_id and a.device_id=j.device_id and i.actor_id=j.created_by_login_id
                    and i.tus_upload_id::text=split_part(j.source_identity,'/',2)
                    and i.name_key=j.audio_name_key and i.recording_started_at=j.recording_started_at
                    and i.status='ready'))))"#)
        .bind(claim.job_id).fetch_one(db.get_postgres_connection_pool()).await.context(h!())
}

pub(crate) async fn active_object(
    db: &DatabaseConnection,
    claim: &ClaimedFinalizationJob,
) -> Result<Option<VerifiedFinalizationObject>> {
    let row = sqlx::query("select a.id,a.object_key,a.source_size_bytes,a.source_sha256,a.is_encrypted,a.media_type,a.duration_seconds,a.recording_ended_at from device_upload_finalization_job j join device_upload_finalization_attempt a on a.id=j.active_attempt_id where j.id=$1 and a.origin='async' and a.phase in ('write_intent','verified')")
        .bind(claim.job_id).fetch_optional(db.get_postgres_connection_pool()).await.context(h!())?;
    let Some(row) = row else {
        return Ok(None);
    };
    let digest: Vec<u8> = row.try_get("source_sha256").context(h!())?;
    let audio = if claim.kind == FinalizationKind::FinalizationAudioKind {
        Some(PreparedAudio {
            media_type: row.try_get("media_type").context(h!())?,
            duration_seconds: row.try_get("duration_seconds").context(h!())?,
            recording_ended_at: row
                .try_get("recording_ended_at")
                .context(h!())?,
        })
    } else {
        None
    };
    Ok(Some(VerifiedFinalizationObject {
        attempt_id: row.try_get("id").context(h!())?,
        object_key: row.try_get("object_key").context(h!())?,
        source_size_bytes: row.try_get("source_size_bytes").context(h!())?,
        source_sha256: digest
            .try_into()
            .map_err(|_| anyhow::anyhow!("invalid persisted source digest"))
            .context(h!())?,
        is_encrypted: row.try_get("is_encrypted").context(h!())?,
        audio,
    }))
}

pub(crate) async fn record_verified(
    db: &DatabaseConnection,
    claim: &ClaimedFinalizationJob,
    attempt_id: Uuid,
) -> Result<bool> {
    let mut transaction = db
        .get_postgres_connection_pool()
        .begin()
        .await
        .context(h!())?;
    if !lock_claim(&mut transaction, claim).await.context(h!())? {
        return Ok(false);
    }
    let result = sqlx::query("update device_upload_finalization_attempt a set phase='verified',verified_at=coalesce(verified_at,clock_timestamp()),write_resolved_at=coalesce(write_resolved_at,clock_timestamp()),updated_at=clock_timestamp() from device_upload_finalization_job j where a.id=$1 and a.job_id=$2 and a.phase in ('write_intent','verified') and j.id=a.job_id and j.active_attempt_id=a.id")
        .bind(attempt_id).bind(claim.job_id).execute(&mut *transaction).await.context(h!())?;
    if result.rows_affected() != 1 {
        return Ok(false);
    }
    sqlx::query("update device_upload_finalization_job set status='processing',error_code=null,error_message=null,error_action=null,updated_at=clock_timestamp() where id=$1")
        .bind(claim.job_id).execute(&mut *transaction).await.context(h!())?;
    transaction.commit().await.context(h!())?;
    release_write_credit(db, attempt_id).await.context(h!())?;
    Ok(true)
}

pub(crate) async fn read_file_job(
    db: &DatabaseConnection,
    upload_id: Uuid,
) -> Result<Option<(JobRecord, DateTime<Utc>)>> {
    let row = sqlx::query("select to_jsonb(j) as job, clock_timestamp() as now from device_upload_finalization_job j where kind='file' and source_identity=$1")
        .bind(upload_id.to_string()).fetch_optional(db.get_postgres_connection_pool()).await.context(h!())?;
    row.map(decode_job).transpose().context(h!())
}

pub(crate) async fn file_source_is_pinned(
    db: &DatabaseConnection,
    upload_id: Uuid,
) -> Result<bool> {
    sqlx::query_scalar("select exists(select 1 from device_upload_finalization_job where kind='file' and source_identity=$1 and source_release_state<>'released')")
        .bind(upload_id.to_string()).fetch_one(db.get_postgres_connection_pool()).await.context(h!())
}

pub(crate) async fn read_audio_job(
    db: &DatabaseConnection,
    device: Uuid,
    upload: Uuid,
) -> Result<Option<(JobRecord, DateTime<Utc>)>> {
    let row = sqlx::query("select to_jsonb(j) as job,clock_timestamp() as now from device_upload_finalization_job j where kind='audio' and source_identity=$1")
        .bind(format!("{device}/{upload}")).fetch_optional(db.get_postgres_connection_pool()).await.context(h!())?;
    row.map(decode_job).transpose().context(h!())
}
