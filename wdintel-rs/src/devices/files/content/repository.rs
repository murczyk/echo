use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Duration, FixedOffset};
use sea_orm::{
    ConnectionTrait, DatabaseBackend, DatabaseConnection, DatabaseTransaction,
    FromQueryResult, QueryResult, Statement, TransactionTrait,
};
use sqlx::{PgConnection, Row};
use std::time::Instant;
use uuid::Uuid;

use super::protocol::ContentError;
use crate::config::ContentLimitsConfig;
use crate::devices::upload_finalization::{
    admission,
    ingress::AdmissionOutcome,
    query,
    types::{
        ClaimedFinalizationJob, CompletedStatus, FinalizationCommand,
        FinalizationFailure, FinalizationFileReceipt, FinalizationJobSnapshot,
        FinalizationKind, FinalizationResult, FinalizationTarget,
        VerifiedFinalizationObject,
    },
};
use crate::h;
use crate::types::{DeviceUploadFinalizationSettings, ShortContext};
use log::warn;

#[cfg(test)]
#[path = "async_publication_tests.rs"]
mod async_publication_tests;

const RESERVATION_LOCK_SQL: &str = "select pg_advisory_xact_lock(hashtextextended('echo:device-file-content-reservation', 0))";

#[derive(FromQueryResult)]
pub(in crate::devices) struct PublishedContent {
    pub name: String,
    pub extension: Option<String>,
    pub mime_type: Option<String>,
    pub object_key: String,
    pub source_sha256: Vec<u8>,
    pub source_size_bytes: i64,
    pub is_encrypted: bool,
}

pub(in crate::devices) async fn find_published_content(
    db: &DatabaseConnection,
    device_id: Uuid,
    file_id: Uuid,
    revision: i64,
) -> Result<Option<PublishedContent>> {
    super::super::archive::access::find_published_content(
        db, device_id, file_id, revision,
    )
    .await
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum UploadStatus {
    Open,
    Completed,
    Aborted,
    Expired,
    Stale,
    Rejected,
}

impl UploadStatus {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Completed => "completed",
            Self::Aborted => "upload_aborted",
            Self::Expired => "upload_expired",
            Self::Stale => "upload_stale",
            Self::Rejected => "upload_rejected",
        }
    }

    pub(crate) fn database_value(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Completed => "completed",
            Self::Aborted => "aborted",
            Self::Expired => "expired",
            Self::Stale => "stale",
            Self::Rejected => "rejected",
        }
    }
}

impl TryFrom<&str> for UploadStatus {
    type Error = anyhow::Error;

    fn try_from(value: &str) -> Result<Self> {
        match value {
            "open" => Ok(Self::Open),
            "completed" => Ok(Self::Completed),
            "aborted" => Ok(Self::Aborted),
            "expired" => Ok(Self::Expired),
            "stale" => Ok(Self::Stale),
            "rejected" => Ok(Self::Rejected),
            value => Err(anyhow!("unknown file content upload status {value}")),
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Upload {
    pub id: Uuid,
    pub device_id: Uuid,
    pub file_id: Uuid,
    pub revision: i64,
    pub upload_length: u64,
    pub expected_sha256: [u8; 32],
    pub object_key: String,
    pub status: UploadStatus,
    pub last_activity_at: DateTime<FixedOffset>,
    pub expires_at: DateTime<FixedOffset>,
    pub hard_expires_at: DateTime<FixedOffset>,
    pub next_cleanup_at: Option<DateTime<FixedOffset>>,
}

#[derive(Clone, Debug, serde::Serialize, PartialEq, Eq)]
pub(crate) struct CompletedContent {
    pub upload_id: Uuid,
    pub file_id: Uuid,
    pub revision: i64,
    pub status: &'static str,
}

#[derive(Debug)]
pub(crate) struct NewUpload {
    pub device_id: Uuid,
    pub file_id: Uuid,
    pub revision: i64,
    pub created_by_login_id: Uuid,
    pub upload_length: u64,
    pub expected_sha256: [u8; 32],
    pub available_spool_bytes: u64,
    pub now: DateTime<FixedOffset>,
}

#[derive(Debug)]
pub(crate) enum CreateOutcome {
    Created(Upload),
    Replayed(Upload),
    InProgress(Upload),
    ContentAlreadyCommitted,
    RevisionStale,
    NotFound,
    CapacityUnavailable,
}

#[derive(Debug)]
pub(crate) enum RevalidateOutcome {
    Open(Upload),
    Completed(CompletedContent),
    Terminal(UploadStatus),
    ContentAlreadyCommitted,
    Missing,
}

#[derive(Debug)]
pub(crate) enum PublishOutcome {
    Completed(CompletedContent),
    Terminal(UploadStatus),
    ContentAlreadyCommitted,
    Missing,
    UnknownCommit(anyhow::Error),
}

#[derive(Clone, Debug)]
pub(crate) struct CleanupCandidate {
    pub id: Uuid,
    pub next_cleanup_at: DateTime<FixedOffset>,
}

pub(crate) async fn load_upload(
    db: &DatabaseConnection,
    upload_id: Uuid,
) -> Result<Option<Upload>> {
    load_upload_on(db, upload_id, false).await.context(h!())
}

pub(super) async fn create_or_replay(
    db: &DatabaseConnection,
    request: NewUpload,
    config: &ContentLimitsConfig,
) -> Result<CreateOutcome> {
    let started = Instant::now();
    let transaction = db
        .begin()
        .await
        .context("begin content upload create")
        .context(h!())?;
    let outcome =
        create_or_replay_in(&transaction, request, config, started).await;
    match outcome {
        Ok(outcome) => {
            transaction
                .commit()
                .await
                .context("commit content upload create")
                .context(h!())?;
            Ok(outcome)
        }
        Err(error) => {
            let _ = transaction.rollback().await;
            Err(error)
        }
    }
}

async fn create_or_replay_in(
    transaction: &DatabaseTransaction,
    mut request: NewUpload,
    config: &ContentLimitsConfig,
    started: Instant,
) -> Result<CreateOutcome> {
    let requested_at = request.now;
    let Some(target) = load_target_for_update(transaction, request.file_id)
        .await
        .context(h!())?
    else {
        return Ok(CreateOutcome::NotFound);
    };
    if target.device_id != request.device_id || target.kind != "file" {
        return Ok(CreateOutcome::NotFound);
    }
    if target.revision != Some(request.revision) {
        return Ok(CreateOutcome::RevisionStale);
    }
    if target.content_path.is_some()
        || content_exists(transaction, request.file_id, request.revision)
            .await
            .context(h!())?
    {
        return Ok(CreateOutcome::ContentAlreadyCommitted);
    }
    if let Some(upload) =
        load_open_for_target(transaction, request.file_id, request.revision)
            .await
            .context(h!())?
    {
        request.now = time_after_wait(requested_at, started).context(h!())?;
        let pinned = source_is_pinned_on(transaction, upload.id)
            .await
            .context(h!())?;
        return Ok(replay_outcome(upload, &request, pinned));
    }

    transaction
        .query_one_raw(Statement::from_string(
            DatabaseBackend::Postgres,
            RESERVATION_LOCK_SQL,
        ))
        .await
        .context("lock content upload reservations")
        .context(h!())?;

    if target_content_path(transaction, request.file_id)
        .await
        .context(h!())?
        .is_some()
        || content_exists(transaction, request.file_id, request.revision)
            .await
            .context(h!())?
    {
        return Ok(CreateOutcome::ContentAlreadyCommitted);
    }
    if let Some(upload) =
        load_open_for_target(transaction, request.file_id, request.revision)
            .await
            .context(h!())?
    {
        request.now = time_after_wait(requested_at, started).context(h!())?;
        let pinned = source_is_pinned_on(transaction, upload.id)
            .await
            .context(h!())?;
        return Ok(replay_outcome(upload, &request, pinned));
    }

    let quota = load_quota(transaction, request.created_by_login_id)
        .await
        .context(h!())?;
    if let Some(reason) = quota_rejection(&quota, &request, config) {
        warn!(
            "device content upload rejected by quota ({reason}): device={} file={} revision={} login={} upload_length={} reserved_bytes={} creator_reserved_bytes={} reserved_count={} creator_reserved_count={} available_spool_bytes={} limits=[max_reserved_bytes={} max_reserved_per_login={} max_reserved_count={} max_count_per_login={} spool_min_free_bytes={}]",
            request.device_id,
            request.file_id,
            request.revision,
            request.created_by_login_id,
            request.upload_length,
            quota.reserved_bytes,
            quota.creator_reserved_bytes,
            quota.reserved_count,
            quota.creator_reserved_count,
            request.available_spool_bytes,
            config.max_reserved_bytes,
            config.max_reserved_per_login,
            config.max_reserved_count,
            config.max_count_per_login,
            config.spool_min_free_bytes,
        );
        return Ok(CreateOutcome::CapacityUnavailable);
    }
    request.now = time_after_wait(requested_at, started).context(h!())?;

    let upload_id = Uuid::new_v4();
    let object_key = format!(
        "device-file-content/{}/{}/{}/{}",
        request.device_id, request.file_id, request.revision, upload_id
    );
    let hard_expires_at =
        deadline_after(request.now, config.upload_max_lifetime_secs)
            .context(h!())?;
    let expires_at = std::cmp::min(
        deadline_after(request.now, config.upload_idle_ttl_secs)
            .context(h!())?,
        hard_expires_at,
    );
    let upload_length = i64::try_from(request.upload_length)
        .context("convert upload length")
        .context(h!())?;
    transaction
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
insert into file_content_upload (
    id, device_id, file_id, revision, created_by_login_id,
    upload_length, expected_sha256, object_key, status,
    created_at, last_activity_at, expires_at, hard_expires_at,
    spool_removed_at, next_cleanup_at
) values ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9, $9, $10, $11, null, $10)
"#,
            [
                upload_id.into(),
                request.device_id.into(),
                request.file_id.into(),
                request.revision.into(),
                request.created_by_login_id.into(),
                upload_length.into(),
                request.expected_sha256.to_vec().into(),
                object_key.clone().into(),
                request.now.into(),
                expires_at.into(),
                hard_expires_at.into(),
            ],
        ))
        .await
        .context("insert content upload")
        .context(h!())?;
    let upload = load_upload_on(transaction, upload_id, false)
        .await
        .context(h!())?
        .context("inserted content upload missing")
        .context(h!())?;
    Ok(CreateOutcome::Created(upload))
}

fn record_committed_transition(
    metrics: Option<&crate::telemetry::Metrics>,
    transition: Option<UploadStatus>,
) {
    if let (Some(metrics), Some(status)) = (metrics, transition) {
        metrics.record_device_file_content_terminal(status.database_value());
    }
}

pub(crate) async fn revalidate_open(
    db: &DatabaseConnection,
    known: &Upload,
    now: DateTime<FixedOffset>,
    metrics: Option<&crate::telemetry::Metrics>,
) -> Result<RevalidateOutcome> {
    let started = Instant::now();
    let transaction = db
        .begin()
        .await
        .context("begin upload revalidation")
        .context(h!())?;
    let outcome = revalidate_open_in(&transaction, known, now, started).await;
    match outcome {
        Ok((outcome, transition)) => {
            transaction
                .commit()
                .await
                .context("commit upload revalidation")
                .context(h!())?;
            record_committed_transition(metrics, transition);
            Ok(outcome)
        }
        Err(error) => {
            let _ = transaction.rollback().await;
            Err(error)
        }
    }
}

async fn revalidate_open_in(
    transaction: &DatabaseTransaction,
    known: &Upload,
    now: DateTime<FixedOffset>,
    started: Instant,
) -> Result<(RevalidateOutcome, Option<UploadStatus>)> {
    let Some(target) = load_target_for_update(transaction, known.file_id)
        .await
        .context(h!())?
    else {
        return Ok((RevalidateOutcome::Missing, None));
    };
    let Some(upload) = load_upload_on(transaction, known.id, true)
        .await
        .context(h!())?
    else {
        return Ok((RevalidateOutcome::Missing, None));
    };
    let now = time_after_wait(now, started).context(h!())?;
    if upload.status == UploadStatus::Completed {
        return Ok((
            match load_completed_on(transaction, upload.id)
                .await
                .context(h!())?
            {
                Some(content) => RevalidateOutcome::Completed(content),
                None => RevalidateOutcome::ContentAlreadyCommitted,
            },
            None,
        ));
    }
    if upload.status != UploadStatus::Open {
        return Ok((RevalidateOutcome::Terminal(upload.status), None));
    }
    if target.device_id != upload.device_id
        || target.kind != "file"
        || target.revision != Some(upload.revision)
    {
        transition_open_in(transaction, upload.id, UploadStatus::Stale, now)
            .await
            .context(h!())?;
        return Ok((
            RevalidateOutcome::Terminal(UploadStatus::Stale),
            Some(UploadStatus::Stale),
        ));
    }
    if (now >= upload.expires_at || now >= upload.hard_expires_at)
        && !source_is_pinned_on(transaction, upload.id)
            .await
            .context(h!())?
    {
        transition_open_in(transaction, upload.id, UploadStatus::Expired, now)
            .await
            .context(h!())?;
        return Ok((
            RevalidateOutcome::Terminal(UploadStatus::Expired),
            Some(UploadStatus::Expired),
        ));
    }
    if target.content_path.is_some()
        || content_exists(transaction, upload.file_id, upload.revision)
            .await
            .context(h!())?
    {
        transition_open_in(transaction, upload.id, UploadStatus::Rejected, now)
            .await
            .context(h!())?;
        return Ok((
            RevalidateOutcome::ContentAlreadyCommitted,
            Some(UploadStatus::Rejected),
        ));
    }
    Ok((RevalidateOutcome::Open(upload), None))
}

pub(super) async fn refresh_open(
    db: &DatabaseConnection,
    known: &Upload,
    now: DateTime<FixedOffset>,
    touch_activity: bool,
    config: &ContentLimitsConfig,
    metrics: Option<&crate::telemetry::Metrics>,
) -> Result<RevalidateOutcome> {
    let started = Instant::now();
    let transaction = db
        .begin()
        .await
        .context("begin upload refresh")
        .context(h!())?;
    let (outcome, transition) =
        revalidate_open_in(&transaction, known, now, started)
            .await
            .context(h!())?;
    let now = time_after_wait(now, started).context(h!())?;
    let outcome = match outcome {
        RevalidateOutcome::Open(upload) => {
            if source_is_pinned_on(&transaction, upload.id)
                .await
                .context(h!())?
            {
                transaction.commit().await.context(h!())?;
                return Ok(RevalidateOutcome::Open(upload));
            }
            let expires_at = std::cmp::min(
                deadline_after(now, config.upload_idle_ttl_secs)
                    .context(h!())?,
                upload.hard_expires_at,
            );
            transaction
                .execute_raw(Statement::from_sql_and_values(
                    DatabaseBackend::Postgres,
                    r#"
update file_content_upload
set last_activity_at = case when $2 then $3 else last_activity_at end,
    expires_at = $4,
    next_cleanup_at = $4
where id = $1 and status = 'open'
"#,
                    [
                        upload.id.into(),
                        touch_activity.into(),
                        now.into(),
                        expires_at.into(),
                    ],
                ))
                .await
                .context("refresh content upload")
                .context(h!())?;
            let mut upload = upload;
            if touch_activity {
                upload.last_activity_at = now;
            }
            upload.expires_at = expires_at;
            upload.next_cleanup_at = Some(expires_at);
            RevalidateOutcome::Open(upload)
        }
        outcome => outcome,
    };
    transaction
        .commit()
        .await
        .context("commit upload refresh")
        .context(h!())?;
    record_committed_transition(metrics, transition);
    Ok(outcome)
}

pub(crate) async fn transition_open(
    db: &DatabaseConnection,
    known: &Upload,
    status: UploadStatus,
    now: DateTime<FixedOffset>,
    metrics: Option<&crate::telemetry::Metrics>,
) -> Result<RevalidateOutcome> {
    let started = Instant::now();
    if status == UploadStatus::Open || status == UploadStatus::Completed {
        return Err(anyhow!("invalid explicit upload terminal transition"));
    }
    let transaction = db
        .begin()
        .await
        .context("begin upload transition")
        .context(h!())?;
    let (outcome, mut transition) =
        revalidate_open_in(&transaction, known, now, started)
            .await
            .context(h!())?;
    if status == UploadStatus::Aborted {
        anyhow::ensure!(
            !source_is_pinned_on(&transaction, known.id)
                .await
                .context(h!())?,
            crate::devices::upload_finalization::types::FinalizationFailure::SourceOwned
        );
    }
    let now = time_after_wait(now, started).context(h!())?;
    let outcome = match outcome {
        RevalidateOutcome::Open(upload) => {
            transition_open_in(&transaction, upload.id, status, now)
                .await
                .context(h!())?;
            transition = Some(status);
            RevalidateOutcome::Terminal(status)
        }
        outcome => outcome,
    };
    transaction
        .commit()
        .await
        .context("commit upload transition")
        .context(h!())?;
    record_committed_transition(metrics, transition);
    Ok(outcome)
}

pub(crate) async fn publish(
    db: &DatabaseConnection,
    known: &Upload,
    is_encrypted: bool,
    now: DateTime<FixedOffset>,
    metrics: Option<&crate::telemetry::Metrics>,
) -> Result<PublishOutcome> {
    let started = Instant::now();
    let transaction = db
        .begin()
        .await
        .context("begin content publication")
        .context(h!())?;
    let outcome =
        publish_in(&transaction, known, is_encrypted, now, started).await;
    let (outcome, transition) = match outcome {
        Ok(outcome) => outcome,
        Err(error) => {
            let _ = transaction.rollback().await;
            return Err(error);
        }
    };
    match transaction.commit().await {
        Ok(()) => {
            record_committed_transition(metrics, transition);
            Ok(outcome)
        }
        Err(error) => Ok(PublishOutcome::UnknownCommit(
            anyhow::Error::new(error)
                .context("commit content publication")
                .context(h!()),
        )),
    }
}

pub(crate) async fn publish_file_in(
    transaction: &mut PgConnection,
    claim: &ClaimedFinalizationJob,
    verified: &VerifiedFinalizationObject,
) -> Result<CompletedContent> {
    let upload = lock_file_publication(transaction, claim)
        .await
        .context(h!())?;
    validate_file_attempt(transaction, claim, verified, &upload)
        .await
        .context(h!())?;
    write_file_publication(transaction, &upload, verified)
        .await
        .context(h!())?;
    super::super::archive::enqueue::ensure_sqlx_in(
        transaction,
        upload.device_id,
        upload.file_id,
        upload.revision,
    )
    .await
    .context(h!())?;
    retire_canonical_allocation(transaction, claim, &upload)
        .await
        .context(h!())?;
    let receipt = CompletedContent {
        upload_id: upload.id,
        file_id: upload.file_id,
        revision: upload.revision,
        status: "completed",
    };
    complete_file_job(transaction, claim, verified, &receipt)
        .await
        .context(h!())?;
    super::super::stats::record_content_completed_sqlx_in(
        transaction,
        upload.device_id,
        upload.id,
        chrono::Utc::now().fixed_offset(),
    )
    .await
    .context(h!())?;
    Ok(receipt)
}

struct LockedAsyncUpload {
    id: Uuid,
    device_id: Uuid,
    file_id: Uuid,
    revision: i64,
    created_by_login_id: Uuid,
    source_size_bytes: i64,
    expected_sha256: Vec<u8>,
    object_key: String,
    status: UploadStatus,
    expired: bool,
}

async fn lock_async_target(
    transaction: &mut PgConnection,
    file_id: Uuid,
) -> Result<Option<LockedTarget>> {
    let row = sqlx::query("select device_id,kind::text as kind,revision,content_path from file_entry where id=$1 for update")
        .bind(file_id).fetch_optional(transaction).await.c(h!())?;
    row.map(|row| {
        Ok(LockedTarget {
            device_id: row.try_get("device_id").c(h!())?,
            kind: row.try_get("kind").c(h!())?,
            revision: row.try_get("revision").c(h!())?,
            content_path: row.try_get("content_path").c(h!())?,
        })
    })
    .transpose()
}

async fn lock_async_upload(
    transaction: &mut PgConnection,
    upload_id: Uuid,
) -> Result<Option<LockedAsyncUpload>> {
    let row = sqlx::query("select id,device_id,file_id,revision,created_by_login_id,upload_length,expected_sha256,object_key,status::text as status,(expires_at<=clock_timestamp() or hard_expires_at<=clock_timestamp()) as expired from file_content_upload where id=$1 for update")
        .bind(upload_id).fetch_optional(transaction).await.c(h!())?;
    row.map(|row| {
        let status: String = row.try_get("status").c(h!())?;
        Ok(LockedAsyncUpload {
            id: row.try_get("id").c(h!())?,
            device_id: row.try_get("device_id").c(h!())?,
            file_id: row.try_get("file_id").c(h!())?,
            revision: row.try_get("revision").c(h!())?,
            created_by_login_id: row.try_get("created_by_login_id").c(h!())?,
            source_size_bytes: row.try_get("upload_length").c(h!())?,
            expected_sha256: row.try_get("expected_sha256").c(h!())?,
            object_key: row.try_get("object_key").c(h!())?,
            status: UploadStatus::try_from(status.as_str()).context(h!())?,
            expired: row.try_get("expired").c(h!())?,
        })
    })
    .transpose()
}

async fn lock_file_publication(
    transaction: &mut PgConnection,
    claim: &ClaimedFinalizationJob,
) -> Result<LockedAsyncUpload> {
    anyhow::ensure!(
        claim.kind == FinalizationKind::FinalizationFileKind,
        FinalizationFailure::StaleClaim
    );
    let identity = sqlx::query("select file_id,file_upload_id from device_upload_finalization_job where id=$1 and kind='file'")
        .bind(claim.job_id).fetch_optional(&mut *transaction).await.c(h!())?
        .ok_or(FinalizationFailure::StaleClaim).context(h!())?;
    let file_id: Uuid = identity.try_get("file_id").c(h!())?;
    let upload_id: Uuid = identity.try_get("file_upload_id").c(h!())?;
    let target = lock_async_target(transaction, file_id)
        .await
        .context(h!())?
        .ok_or(FinalizationFailure::TargetUnavailable)
        .context(h!())?;
    let upload = lock_async_upload(transaction, upload_id)
        .await
        .context(h!())?
        .ok_or(FinalizationFailure::TargetUnavailable)
        .context(h!())?;
    anyhow::ensure!(
        query::lock_claim(transaction, claim).await.context(h!())?,
        FinalizationFailure::StaleClaim
    );
    anyhow::ensure!(
        target.device_id == upload.device_id && target.kind == "file",
        FinalizationFailure::TargetUnavailable
    );
    anyhow::ensure!(
        target.revision == Some(upload.revision)
            && upload.status != UploadStatus::Stale,
        FinalizationFailure::TargetRevisionChanged
    );
    anyhow::ensure!(
        upload.status == UploadStatus::Open && target.content_path.is_none(),
        FinalizationFailure::TargetUnavailable
    );
    let published: bool = sqlx::query_scalar("select exists(select 1 from file_content where file_id=$1 and revision=$2)")
        .bind(upload.file_id).bind(upload.revision).fetch_one(transaction).await.c(h!())?;
    anyhow::ensure!(!published, FinalizationFailure::TargetUnavailable);
    Ok(upload)
}

async fn validate_file_attempt(
    transaction: &mut PgConnection,
    claim: &ClaimedFinalizationJob,
    verified: &VerifiedFinalizationObject,
    upload: &LockedAsyncUpload,
) -> Result<()> {
    let attempt = sqlx::query("select a.object_key,a.source_size_bytes,a.source_sha256,a.is_encrypted from device_upload_finalization_attempt a join device_upload_finalization_job j on j.id=a.job_id where a.id=$1 and a.job_id=$2 and a.origin='async' and a.kind='file' and a.phase='verified' and a.verified_at is not null and a.retired_at is null and a.file_upload_id=$3 and j.active_attempt_id=a.id and j.status='processing' for update of a")
        .bind(verified.attempt_id).bind(claim.job_id).bind(upload.id)
        .fetch_optional(transaction).await.c(h!())?
        .ok_or(FinalizationFailure::StaleClaim).context(h!())?;
    anyhow::ensure!(
        verified.audio.is_none()
            && verified.source_size_bytes == upload.source_size_bytes
            && verified.source_sha256.as_slice() == upload.expected_sha256
            && attempt.try_get::<String, _>("object_key").c(h!())?
                == verified.object_key
            && attempt.try_get::<i64, _>("source_size_bytes").c(h!())?
                == verified.source_size_bytes
            && attempt.try_get::<Vec<u8>, _>("source_sha256").c(h!())?
                == verified.source_sha256
            && attempt.try_get::<bool, _>("is_encrypted").c(h!())?
                == verified.is_encrypted,
        FinalizationFailure::SourceDigestMismatch
    );
    Ok(())
}

async fn write_file_publication(
    transaction: &mut PgConnection,
    upload: &LockedAsyncUpload,
    verified: &VerifiedFinalizationObject,
) -> Result<()> {
    sqlx::query("insert into file_content_upload_object(upload_id,file_id,object_key,source_size_bytes,source_sha256,is_encrypted,attempt_id) values($1,$2,$3,$4,$5,$6,$7)")
        .bind(upload.id).bind(upload.file_id).bind(&verified.object_key)
        .bind(verified.source_size_bytes).bind(verified.source_sha256.as_slice())
        .bind(verified.is_encrypted).bind(verified.attempt_id)
        .execute(&mut *transaction).await.c(h!())?;
    sqlx::query("insert into file_content(file_id,revision,upload_id,object_key,source_size_bytes,source_sha256,is_encrypted,created_at) values($1,$2,$3,$4,$5,$6,$7,clock_timestamp())")
        .bind(upload.file_id).bind(upload.revision).bind(upload.id).bind(&verified.object_key)
        .bind(verified.source_size_bytes).bind(verified.source_sha256.as_slice()).bind(verified.is_encrypted)
        .execute(&mut *transaction).await.c(h!())?;
    sqlx::query("update file_entry set content_path=$2 where id=$1")
        .bind(upload.file_id)
        .bind(&verified.object_key)
        .execute(&mut *transaction)
        .await
        .c(h!())?;
    sqlx::query("update file_content_upload set status='completed',next_cleanup_at=clock_timestamp() where id=$1")
        .bind(upload.id).execute(&mut *transaction).await.c(h!())?;
    sqlx::query("update device_upload_finalization_attempt set phase='selected',updated_at=clock_timestamp() where id=$1")
        .bind(verified.attempt_id).execute(transaction).await.c(h!())?;
    Ok(())
}

async fn retire_canonical_allocation(
    transaction: &mut PgConnection,
    claim: &ClaimedFinalizationJob,
    upload: &LockedAsyncUpload,
) -> Result<()> {
    sqlx::query("insert into device_upload_finalization_attempt(id,job_id,kind,origin,ordinal,lease_epoch,file_upload_id,device_id,object_key,is_encrypted,source_size_bytes,phase,retired_at,cleanup_next_at,late_write_possible) values($1,$2,'file','legacy_cleanup',(select coalesce(max(ordinal),0)+1 from device_upload_finalization_attempt where job_id=$2),$3,$4,$5,$6,false,$7,'retired',clock_timestamp(),clock_timestamp(),true)")
        .bind(Uuid::now_v7()).bind(claim.job_id).bind(claim.lease_epoch)
        .bind(upload.id).bind(upload.device_id).bind(&upload.object_key).bind(upload.source_size_bytes)
        .execute(transaction).await.c(h!())?;
    Ok(())
}

async fn complete_file_job(
    transaction: &mut PgConnection,
    claim: &ClaimedFinalizationJob,
    verified: &VerifiedFinalizationObject,
    receipt: &CompletedContent,
) -> Result<()> {
    let result = serde_json::json!({"version": 1, "value": receipt});
    let changed = sqlx::query("update device_upload_finalization_job set status='completed',winning_attempt_id=$4,result=$5,finished_at=clock_timestamp(),updated_at=clock_timestamp(),lease_owner=null,lease_until=null,error_code=null,error_message=null,error_action=null,source_release_state='release_pending' where id=$1 and lease_owner=$2 and lease_epoch=$3 and lease_until>clock_timestamp() and status='processing'")
        .bind(claim.job_id).bind(claim.owner).bind(claim.lease_epoch).bind(verified.attempt_id).bind(result)
        .execute(transaction).await.c(h!())?;
    anyhow::ensure!(
        changed.rows_affected() == 1,
        FinalizationFailure::StaleClaim
    );
    Ok(())
}

pub(crate) async fn admit_file(
    db: &DatabaseConnection,
    known: &Upload,
    actor: Uuid,
    settings: &DeviceUploadFinalizationSettings,
) -> std::result::Result<FinalizationJobSnapshot, ContentError> {
    let mut transaction = db
        .get_postgres_connection_pool()
        .begin()
        .await
        .c(h!())
        .map_err(super::repository_unavailable)?;
    let target = lock_async_target(&mut transaction, known.file_id)
        .await
        .context(h!())
        .map_err(super::repository_unavailable)?
        .ok_or_else(ContentError::not_found)?;
    let upload = lock_async_upload(&mut transaction, known.id)
        .await
        .context(h!())
        .map_err(super::repository_unavailable)?
        .ok_or_else(ContentError::not_found)?;
    validate_file_admission(&target, &upload, known, actor)?;
    let exists: bool = sqlx::query_scalar("select exists(select 1 from file_content where file_id=$1 and revision=$2)")
        .bind(upload.file_id).bind(upload.revision).fetch_one(&mut *transaction).await
        .c(h!()).map_err(super::repository_unavailable)?;
    if exists {
        return Err(ContentError::conflict("content_already_committed"));
    }
    let command = file_command(&upload, actor);
    let snapshot = admission::admit_in(&mut transaction, &command, settings)
        .await
        .context(h!())
        .map_err(file_admission_error)?;
    transaction
        .commit()
        .await
        .c(h!())
        .map_err(super::repository_unavailable)?;
    Ok(snapshot)
}

pub(crate) async fn adopt_completed_file(
    db: &DatabaseConnection,
    known: &Upload,
    actor: Uuid,
) -> Result<FinalizationJobSnapshot> {
    let mut transaction =
        db.get_postgres_connection_pool().begin().await.c(h!())?;
    lock_async_target(&mut transaction, known.file_id)
        .await
        .c(h!())?;
    let upload = lock_async_upload(&mut transaction, known.id)
        .await
        .c(h!())?
        .context(h!())?;
    anyhow::ensure!(
        upload.created_by_login_id == actor,
        FinalizationFailure::SourceOwned
    );
    let command = file_command(&upload, actor);
    if let Some(snapshot) = admission::replay_in(&mut transaction, &command)
        .await
        .c(h!())?
    {
        transaction.commit().await.c(h!())?;
        return Ok(snapshot);
    }
    let proven: bool = sqlx::query_scalar("select exists(select 1 from file_content c join file_content_upload_object o on o.upload_id=c.upload_id and o.file_id=c.file_id and o.object_key=c.object_key where c.upload_id=$1 and c.file_id=$2 and c.revision=$3 and o.attempt_id is null and o.object_key=$4)")
        .bind(upload.id).bind(upload.file_id).bind(upload.revision).bind(&upload.object_key)
        .fetch_one(&mut *transaction).await.c(h!())?;
    anyhow::ensure!(
        upload.status == UploadStatus::Completed && proven,
        FinalizationFailure::CommandConflict
    );
    let result =
        FinalizationResult::FinalizationFileResult(FinalizationFileReceipt {
            upload_id: upload.id,
            file_id: upload.file_id,
            revision: upload.revision,
            status: CompletedStatus::FinalizationFileCompleted,
        });
    let snapshot =
        admission::adopt_completed_in(&mut transaction, &command, &result)
            .await
            .c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(snapshot)
}

fn file_command(
    upload: &LockedAsyncUpload,
    actor: Uuid,
) -> FinalizationCommand {
    FinalizationCommand {
        created_by_login_id: actor,
        device_id: upload.device_id,
        source_size_bytes: upload.source_size_bytes,
        source_locator: (upload.source_size_bytes != 0)
            .then(|| format!("{}.data", upload.id)),
        target: FinalizationTarget::File {
            upload_id: upload.id,
            file_id: upload.file_id,
            revision: upload.revision,
        },
    }
}

fn validate_file_admission(
    target: &LockedTarget,
    upload: &LockedAsyncUpload,
    known: &Upload,
    actor: Uuid,
) -> std::result::Result<(), ContentError> {
    if upload.created_by_login_id != actor
        || upload.device_id != known.device_id
        || upload.file_id != known.file_id
        || target.device_id != known.device_id
        || target.kind != "file"
    {
        return Err(ContentError::not_found());
    }
    if upload.status == UploadStatus::Completed || target.content_path.is_some()
    {
        return Err(ContentError::conflict("content_already_committed"));
    }
    if upload.status != UploadStatus::Open {
        return Err(ContentError::gone(upload.status.code()));
    }
    if target.revision != Some(upload.revision)
        || upload.revision != known.revision
    {
        return Err(ContentError::gone(UploadStatus::Stale.code()));
    }
    if upload.expired {
        return Err(ContentError::gone(UploadStatus::Expired.code()));
    }
    if upload.source_size_bytes as u64 != known.upload_length
        || upload.expected_sha256 != known.expected_sha256
    {
        return Err(ContentError::conflict("upload_metadata_mismatch"));
    }
    Ok(())
}

fn file_admission_error(error: anyhow::Error) -> ContentError {
    match error.downcast_ref::<FinalizationFailure>() {
        Some(FinalizationFailure::SourceOwned) => ContentError::not_found(),
        Some(FinalizationFailure::CommandConflict) => {
            ContentError::conflict("command_conflict")
        }
        Some(FinalizationFailure::CapacityUnavailable) => {
            ContentError::unavailable(
                "finalization_unavailable",
                crate::devices::config::DEVICE_FILE_CONTENT_BUSY_RETRY_AFTER_SECS,
            )
            .with_finalization_outcome(AdmissionOutcome::CapacityUnavailable)
        }
        Some(FinalizationFailure::DependencyUnavailable) => {
            ContentError::unavailable(
                "finalization_unavailable",
                crate::devices::config::DEVICE_FILE_CONTENT_BUSY_RETRY_AFTER_SECS,
            )
        }
        _ => super::repository_unavailable(error),
    }
}

async fn publish_in(
    transaction: &DatabaseTransaction,
    known: &Upload,
    is_encrypted: bool,
    now: DateTime<FixedOffset>,
    started: Instant,
) -> Result<(PublishOutcome, Option<UploadStatus>)> {
    let Some(target) = load_target_for_update(transaction, known.file_id)
        .await
        .context(h!())?
    else {
        return Ok((PublishOutcome::Missing, None));
    };
    let Some(upload) = load_upload_on(transaction, known.id, true)
        .await
        .context(h!())?
    else {
        return Ok((PublishOutcome::Missing, None));
    };
    let now = time_after_wait(now, started).context(h!())?;
    if upload.status == UploadStatus::Completed {
        return Ok((
            load_completed_on(transaction, upload.id)
                .await
                .context(h!())?
                .map(PublishOutcome::Completed)
                .unwrap_or(PublishOutcome::ContentAlreadyCommitted),
            None,
        ));
    }
    if upload.status != UploadStatus::Open {
        return Ok((PublishOutcome::Terminal(upload.status), None));
    }
    if target.device_id != upload.device_id
        || target.kind != "file"
        || target.revision != Some(upload.revision)
    {
        transition_open_in(transaction, upload.id, UploadStatus::Stale, now)
            .await
            .context(h!())?;
        return Ok((
            PublishOutcome::Terminal(UploadStatus::Stale),
            Some(UploadStatus::Stale),
        ));
    }
    if now >= upload.expires_at || now >= upload.hard_expires_at {
        transition_open_in(transaction, upload.id, UploadStatus::Expired, now)
            .await
            .context(h!())?;
        return Ok((
            PublishOutcome::Terminal(UploadStatus::Expired),
            Some(UploadStatus::Expired),
        ));
    }
    if target.content_path.is_some()
        || content_exists(transaction, upload.file_id, upload.revision)
            .await
            .context(h!())?
    {
        transition_open_in(transaction, upload.id, UploadStatus::Rejected, now)
            .await
            .context(h!())?;
        return Ok((
            PublishOutcome::ContentAlreadyCommitted,
            Some(UploadStatus::Rejected),
        ));
    }

    transaction
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
insert into file_content (
    file_id, revision, upload_id, object_key, source_size_bytes,
    source_sha256, is_encrypted, created_at
)
select file_id, revision, id, object_key, upload_length,
       expected_sha256, $2, $3
from file_content_upload
where id = $1 and status = 'open'
"#,
            [upload.id.into(), is_encrypted.into(), now.into()],
        ))
        .await
        .context("insert immutable file content")
        .context(h!())?;
    transaction
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "update file_entry set content_path = $2 where id = $1",
            [upload.file_id.into(), upload.object_key.clone().into()],
        ))
        .await
        .context("publish current file content pointer")
        .context(h!())?;
    transaction
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
update file_content_upload
set status = 'completed', next_cleanup_at = $2
where id = $1 and status = 'open'
"#,
            [upload.id.into(), now.into()],
        ))
        .await
        .context("complete content upload")
        .context(h!())?;
    super::super::archive::enqueue::ensure_in(
        transaction,
        upload.device_id,
        upload.file_id,
        upload.revision,
    )
    .await
    .context(h!())?;
    super::super::stats::record_content_completed_in(
        transaction,
        upload.device_id,
        upload.id,
        now,
    )
    .await
    .context(h!())?;
    Ok((
        PublishOutcome::Completed(completed(&upload)),
        Some(UploadStatus::Completed),
    ))
}

pub(crate) fn deadline_after(
    now: DateTime<FixedOffset>,
    seconds: u64,
) -> Result<DateTime<FixedOffset>> {
    let seconds = i64::try_from(seconds).context(h!())?;
    let duration = Duration::try_seconds(seconds)
        .context("content upload duration is out of range")
        .context(h!())?;
    now.checked_add_signed(duration)
        .context("content upload deadline overflowed")
        .context(h!())
}

fn time_after_wait(
    now: DateTime<FixedOffset>,
    started: Instant,
) -> Result<DateTime<FixedOffset>> {
    let elapsed = Duration::from_std(started.elapsed()).context(h!())?;
    now.checked_add_signed(elapsed)
        .context("content upload checkpoint time overflowed")
        .context(h!())
}

pub(crate) async fn reconcile_publication(
    db: &DatabaseConnection,
    upload_id: Uuid,
) -> Result<Option<CompletedContent>> {
    load_completed_on(db, upload_id).await.context(h!())
}

pub(crate) async fn list_cleanup_candidates(
    db: &DatabaseConnection,
    cursor: Option<(DateTime<FixedOffset>, Uuid)>,
    now: DateTime<FixedOffset>,
    limit: usize,
) -> Result<Vec<CleanupCandidate>> {
    let limit = i64::try_from(limit)
        .context("convert cleanup batch size")
        .context(h!())?;
    let (query, values) = match cursor {
        Some((time, id)) => (
            r#"
select id, next_cleanup_at
from file_content_upload
where next_cleanup_at <= $1
  and (next_cleanup_at, id) > ($2, $3)
  and finalization_job_id is null
order by next_cleanup_at, id
limit $4
"#,
            vec![now.into(), time.into(), id.into(), limit.into()],
        ),
        None => (
            r#"
select id, next_cleanup_at
from file_content_upload
where next_cleanup_at <= $1
  and finalization_job_id is null
order by next_cleanup_at, id
limit $2
"#,
            vec![now.into(), limit.into()],
        ),
    };
    let rows = db
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            query,
            values,
        ))
        .await
        .context("list content cleanup candidates")
        .context(h!())?;
    rows.into_iter()
        .map(map_cleanup_candidate)
        .collect::<Result<Vec<_>>>()
        .context(h!())
}

pub(crate) async fn expire_if_due(
    db: &DatabaseConnection,
    upload_id: Uuid,
    now: DateTime<FixedOffset>,
) -> Result<bool> {
    let result = db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
update file_content_upload
set status = 'expired', next_cleanup_at = $2
where id = $1 and status = 'open'
  and (expires_at <= $2 or hard_expires_at <= $2)
  and not exists (
      select 1 from device_upload_finalization_job j
      where j.kind = 'file' and j.source_identity = $1::uuid::text
        and j.file_upload_id = $1 and j.source_release_state <> 'released'
  )
"#,
            [upload_id.into(), now.into()],
        ))
        .await
        .context("expire due content upload")
        .context(h!())?;
    Ok(result.rows_affected() > 0)
}

/// Reopens an open-but-due or expired upload whose source is still spooled,
/// so recovery can admit it. The target must still expect this revision.
pub(super) async fn reopen_for_recovery(
    db: &DatabaseConnection,
    upload_id: Uuid,
    idle_ttl_secs: u64,
) -> Result<bool> {
    let ttl = i64::try_from(idle_ttl_secs).context(h!())?;
    let result = db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
with deadline as (
    select clock_timestamp() + $2 * interval '1 second' as at
)
update file_content_upload u
set status = 'open',
    expires_at = deadline.at,
    hard_expires_at = greatest(u.hard_expires_at, deadline.at),
    next_cleanup_at = deadline.at
from deadline
where u.id = $1
  and u.status in ('open', 'expired')
  and u.spool_removed_at is null
  and u.finalization_job_id is null
  and exists (
      select 1 from file_entry f
      where f.id = u.file_id and f.device_id = u.device_id
        and f.kind = 'file' and f.revision = u.revision
        and f.content_path is null and f.archive_file_id is null
  )
  and not exists (
      select 1 from file_content c
      where c.file_id = u.file_id and c.revision = u.revision
  )
"#,
            [upload_id.into(), ttl.into()],
        ))
        .await
        .context("reopen content upload for recovery")
        .context(h!())?;
    Ok(result.rows_affected() == 1)
}

pub(crate) async fn mark_spool_removed(
    db: &DatabaseConnection,
    upload_id: Uuid,
    now: DateTime<FixedOffset>,
) -> Result<()> {
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
update file_content_upload
set spool_removed_at = coalesce(spool_removed_at, $2),
    next_cleanup_at = case when status = 'completed' then null else next_cleanup_at end
where id = $1 and status <> 'open'
"#,
        [upload_id.into(), now.into()],
    ))
    .await
    .context("mark content upload spool removed")
    .context(h!())?;
    Ok(())
}

pub(crate) async fn schedule_cleanup_retry(
    db: &DatabaseConnection,
    upload_id: Uuid,
    now: DateTime<FixedOffset>,
    retry_at: DateTime<FixedOffset>,
) -> Result<bool> {
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
with candidate as materialized (
    select status
    from file_content_upload
    where id = $1
      and not exists (
          select 1 from device_upload_finalization_job j
          where j.kind = 'file' and j.source_identity = $1::uuid::text
            and j.file_upload_id = $1 and j.source_release_state <> 'released'
      )
      and (
          (status = 'open' and (expires_at <= $2 or hard_expires_at <= $2))
          or (status <> 'open' and next_cleanup_at is not null)
      )
    for update
)
update file_content_upload as upload
set status = case
        when candidate.status = 'open'
            then 'expired'::file_content_upload_status
        else candidate.status
    end,
    next_cleanup_at = $3
from candidate
where upload.id = $1
returning candidate.status = 'open'::file_content_upload_status as expired
"#,
            [upload_id.into(), now.into(), retry_at.into()],
        ))
        .await
        .context("schedule content cleanup retry")
        .context(h!())?;
    row.map(|row| row.try_get("", "expired").context(h!()))
        .transpose()
        .context(h!())
        .map(|expired| expired.unwrap_or(false))
}

pub(crate) async fn object_is_referenced(
    db: &DatabaseConnection,
    object_key: &str,
) -> Result<bool> {
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select exists(select 1 from file_content where object_key = $1) as referenced",
            [object_key.into()],
        ))
        .await
        .context("check content object reference")
        .context(h!())?
        .context("content object reference result missing")
        .context(h!())?;
    row.try_get("", "referenced")
        .context("decode content object reference")
        .context(h!())
}

pub(crate) async fn delete_uncommitted_upload(
    db: &DatabaseConnection,
    upload_id: Uuid,
) -> Result<()> {
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
delete from file_content_upload u
where u.id = $1
  and u.status in ('aborted', 'expired', 'stale', 'rejected')
  and not exists (select 1 from file_content c where c.upload_id = u.id)
  and not exists (
      select 1 from device_upload_finalization_job j
      where j.kind = 'file' and j.source_identity = u.id::text
        and j.file_upload_id = u.id
  )
"#,
        [upload_id.into()],
    ))
    .await
    .context("delete cleaned content upload")
    .context(h!())?;
    Ok(())
}

async fn load_upload_on<C: ConnectionTrait>(
    db: &C,
    upload_id: Uuid,
    for_update: bool,
) -> Result<Option<Upload>> {
    let suffix = if for_update { " for update" } else { "" };
    let sql = format!(
        r#"
select id, device_id, file_id, revision, created_by_login_id,
       upload_length, expected_sha256, object_key, status::text as status,
       created_at, last_activity_at, expires_at, hard_expires_at,
       spool_removed_at, next_cleanup_at
from file_content_upload
where id = $1{suffix}
"#
    );
    db.query_one_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        [upload_id.into()],
    ))
    .await
    .context("load content upload")
    .context(h!())?
    .map(map_upload)
    .transpose()
    .context(h!())
}

async fn load_open_for_target<C: ConnectionTrait>(
    db: &C,
    file_id: Uuid,
    revision: i64,
) -> Result<Option<Upload>> {
    db.query_one_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
select id, device_id, file_id, revision, created_by_login_id,
       upload_length, expected_sha256, object_key, status::text as status,
       created_at, last_activity_at, expires_at, hard_expires_at,
       spool_removed_at, next_cleanup_at
from file_content_upload
where file_id = $1 and revision = $2 and status = 'open'
"#,
        [file_id.into(), revision.into()],
    ))
    .await
    .context("load open content upload")
    .context(h!())?
    .map(map_upload)
    .transpose()
    .context(h!())
}

#[derive(Debug)]
struct LockedTarget {
    device_id: Uuid,
    kind: String,
    revision: Option<i64>,
    content_path: Option<String>,
}

async fn load_target_for_update(
    transaction: &DatabaseTransaction,
    file_id: Uuid,
) -> Result<Option<LockedTarget>> {
    transaction
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
select device_id, kind::text as kind, revision, content_path
from file_entry
where id = $1 and archive_file_id is null
for update
"#,
            [file_id.into()],
        ))
        .await
        .context("lock content target")
        .context(h!())?
        .map(|row| {
            Ok::<LockedTarget, anyhow::Error>(LockedTarget {
                device_id: row.try_get("", "device_id").context(h!())?,
                kind: row.try_get("", "kind").context(h!())?,
                revision: row.try_get("", "revision").context(h!())?,
                content_path: row.try_get("", "content_path").context(h!())?,
            })
        })
        .transpose()
        .context("decode content target")
        .context(h!())
}

async fn target_content_path(
    transaction: &DatabaseTransaction,
    file_id: Uuid,
) -> Result<Option<String>> {
    let row = transaction
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select content_path from file_entry where id = $1",
            [file_id.into()],
        ))
        .await
        .context("reload content target")
        .context(h!())?
        .context("content target disappeared while locked")
        .context(h!())?;
    row.try_get("", "content_path")
        .context("decode current content path")
        .context(h!())
}

async fn content_exists<C: ConnectionTrait>(
    db: &C,
    file_id: Uuid,
    revision: i64,
) -> Result<bool> {
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select exists(select 1 from file_content where file_id = $1 and revision = $2) as exists",
            [file_id.into(), revision.into()],
        ))
        .await
        .context("check committed file content")
        .context(h!())?
        .context("committed content check missing")
        .context(h!())?;
    row.try_get("", "exists")
        .context("decode committed content check")
        .context(h!())
}

struct QuotaUsage {
    reserved_bytes: u64,
    creator_reserved_bytes: u64,
    reserved_count: usize,
    creator_reserved_count: usize,
}

async fn load_quota(
    transaction: &DatabaseTransaction,
    creator: Uuid,
) -> Result<QuotaUsage> {
    let row = transaction
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
select
    coalesce(sum(upload_length) filter (where spool_removed_at is null), 0)::bigint as reserved_bytes,
    coalesce(sum(upload_length) filter (
        where spool_removed_at is null and created_by_login_id = $1
    ), 0)::bigint as creator_reserved_bytes,
    count(*)::bigint as reserved_count,
    count(*) filter (
        where created_by_login_id = $1
    )::bigint as creator_reserved_count
from file_content_upload
where spool_removed_at is null
   or (status <> 'completed' and finalization_job_id is null)
"#,
            [creator.into()],
        ))
        .await
        .context("load content upload quota")
        .context(h!())?
        .context("content upload quota missing")
        .context(h!())?;
    let reserved_bytes: i64 =
        row.try_get("", "reserved_bytes").context(h!())?;
    let creator_reserved_bytes: i64 =
        row.try_get("", "creator_reserved_bytes").context(h!())?;
    let reserved_count: i64 =
        row.try_get("", "reserved_count").context(h!())?;
    let creator_reserved_count: i64 =
        row.try_get("", "creator_reserved_count").context(h!())?;
    Ok(QuotaUsage {
        reserved_bytes: u64::try_from(reserved_bytes).context(h!())?,
        creator_reserved_bytes: u64::try_from(creator_reserved_bytes)
            .context(h!())?,
        reserved_count: usize::try_from(reserved_count).context(h!())?,
        creator_reserved_count: usize::try_from(creator_reserved_count)
            .context(h!())?,
    })
}

fn quota_rejection(
    quota: &QuotaUsage,
    request: &NewUpload,
    config: &ContentLimitsConfig,
) -> Option<&'static str> {
    let Some(reserved_bytes) =
        quota.reserved_bytes.checked_add(request.upload_length)
    else {
        return Some("reserved bytes overflow");
    };
    let Some(creator_bytes) = quota
        .creator_reserved_bytes
        .checked_add(request.upload_length)
    else {
        return Some("creator reserved bytes overflow");
    };
    let Some(required_available) =
        reserved_bytes.checked_add(config.spool_min_free_bytes)
    else {
        return Some("required spool space overflow");
    };
    if reserved_bytes > config.max_reserved_bytes {
        Some("global reserved bytes")
    } else if creator_bytes > config.max_reserved_per_login {
        Some("per-login reserved bytes")
    } else if quota.reserved_count >= config.max_reserved_count {
        Some("global reserved count")
    } else if quota.creator_reserved_count >= config.max_count_per_login {
        Some("per-login reserved count")
    } else if request.available_spool_bytes < required_available {
        Some("spool free space")
    } else {
        None
    }
}

fn replay_outcome(
    upload: Upload,
    request: &NewUpload,
    pinned: bool,
) -> CreateOutcome {
    if upload.upload_length == request.upload_length
        && upload.expected_sha256 == request.expected_sha256
        && (pinned
            || (request.now < upload.expires_at
                && request.now < upload.hard_expires_at))
    {
        CreateOutcome::Replayed(upload)
    } else {
        CreateOutcome::InProgress(upload)
    }
}

async fn source_is_pinned_on<C: ConnectionTrait>(
    db: &C,
    upload_id: Uuid,
) -> Result<bool> {
    let row = db.query_one_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "select exists(select 1 from device_upload_finalization_job where kind='file' and source_identity=$1::uuid::text and file_upload_id=$1 and source_release_state<>'released') as pinned",
        [upload_id.into()],
    ))
    .await.c(h!())?.context(h!())?;
    row.try_get("", "pinned").c(h!())
}

async fn transition_open_in<C: ConnectionTrait>(
    db: &C,
    upload_id: Uuid,
    status: UploadStatus,
    now: DateTime<FixedOffset>,
) -> Result<()> {
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
update file_content_upload
set status = $2::file_content_upload_status, next_cleanup_at = $3
where id = $1 and status = 'open'
"#,
        [upload_id.into(), status.database_value().into(), now.into()],
    ))
    .await
    .context("transition content upload")
    .context(h!())?;
    Ok(())
}

async fn load_completed_on<C: ConnectionTrait>(
    db: &C,
    upload_id: Uuid,
) -> Result<Option<CompletedContent>> {
    db.query_one_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "select c.upload_id, c.file_id, c.revision from file_content c join file_content_upload u on u.id=c.upload_id where c.upload_id=$1 and c.revision=u.revision",
        [upload_id.into()],
    ))
    .await
    .context("load completed file content")
    .context(h!())?
    .map(|row| {
        Ok::<CompletedContent, anyhow::Error>(CompletedContent {
            upload_id: row.try_get("", "upload_id").context(h!())?,
            file_id: row.try_get("", "file_id").context(h!())?,
            revision: row.try_get("", "revision").context(h!())?,
            status: "completed",
        })
    })
    .transpose()
    .context("decode completed file content")
    .context(h!())
}

fn completed(upload: &Upload) -> CompletedContent {
    CompletedContent {
        upload_id: upload.id,
        file_id: upload.file_id,
        revision: upload.revision,
        status: "completed",
    }
}

fn map_upload(row: QueryResult) -> Result<Upload> {
    let digest: Vec<u8> = row.try_get("", "expected_sha256").context(h!())?;
    let expected_sha256: [u8; 32] = digest
        .try_into()
        .map_err(|_| anyhow!("stored content upload digest is not 32 bytes"))
        .context(h!())?;
    let upload_length: i64 = row.try_get("", "upload_length").context(h!())?;
    let status: String = row.try_get("", "status").context(h!())?;
    Ok(Upload {
        id: row.try_get("", "id").context(h!())?,
        device_id: row.try_get("", "device_id").context(h!())?,
        file_id: row.try_get("", "file_id").context(h!())?,
        revision: row.try_get("", "revision").context(h!())?,
        upload_length: u64::try_from(upload_length).context(h!())?,
        expected_sha256,
        object_key: row.try_get("", "object_key").context(h!())?,
        status: UploadStatus::try_from(status.as_str()).context(h!())?,
        last_activity_at: row.try_get("", "last_activity_at").context(h!())?,
        expires_at: row.try_get("", "expires_at").context(h!())?,
        hard_expires_at: row.try_get("", "hard_expires_at").context(h!())?,
        next_cleanup_at: row.try_get("", "next_cleanup_at").context(h!())?,
    })
}

fn map_cleanup_candidate(row: QueryResult) -> Result<CleanupCandidate> {
    Ok(CleanupCandidate {
        id: row.try_get("", "id").context(h!())?,
        next_cleanup_at: row.try_get("", "next_cleanup_at").context(h!())?,
    })
}
