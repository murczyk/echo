use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Duration, FixedOffset};
use sea_orm::{
    ConnectionTrait, DatabaseBackend, DatabaseConnection, DatabaseTransaction,
    QueryResult, Statement, TransactionTrait,
};
use std::time::Instant;
use uuid::Uuid;

use crate::config::DeviceFileContentConfig;
use crate::h;

const RESERVATION_LOCK_SQL: &str =
    "select pg_advisory_xact_lock(hashtextextended('echo:device-file-content-reservation', 0))";

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

pub(crate) async fn create_or_replay(
    db: &DatabaseConnection,
    request: NewUpload,
    config: &DeviceFileContentConfig,
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
    config: &DeviceFileContentConfig,
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
        return Ok(replay_outcome(upload, &request));
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
        return Ok(replay_outcome(upload, &request));
    }

    let quota = load_quota(transaction, request.created_by_login_id)
        .await
        .context(h!())?;
    if !quota_accepts(&quota, &request, config) {
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
    let expires_at = deadline_after(request.now, config.upload_idle_ttl_secs)
        .context(h!())?;
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
    if now >= upload.expires_at || now >= upload.hard_expires_at {
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

pub(crate) async fn refresh_open(
    db: &DatabaseConnection,
    known: &Upload,
    now: DateTime<FixedOffset>,
    touch_activity: bool,
    config: &DeviceFileContentConfig,
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
"#,
            [upload_id.into(), now.into()],
        ))
        .await
        .context("expire due content upload")
        .context(h!())?;
    Ok(result.rows_affected() > 0)
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
where id = $1
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
    count(*) filter (
        where spool_removed_at is null or status <> 'completed'
    )::bigint as reserved_count,
    count(*) filter (
        where (spool_removed_at is null or status <> 'completed')
          and created_by_login_id = $1
    )::bigint as creator_reserved_count
from file_content_upload
where spool_removed_at is null or status <> 'completed'
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

fn quota_accepts(
    quota: &QuotaUsage,
    request: &NewUpload,
    config: &DeviceFileContentConfig,
) -> bool {
    let Some(reserved_bytes) =
        quota.reserved_bytes.checked_add(request.upload_length)
    else {
        return false;
    };
    let Some(creator_bytes) = quota
        .creator_reserved_bytes
        .checked_add(request.upload_length)
    else {
        return false;
    };
    let Some(required_available) =
        reserved_bytes.checked_add(config.spool_min_free_bytes)
    else {
        return false;
    };
    reserved_bytes <= config.max_reserved_bytes
        && creator_bytes <= config.max_reserved_per_login
        && quota.reserved_count < config.max_reserved_count
        && quota.creator_reserved_count < config.max_count_per_login
        && request.available_spool_bytes >= required_available
}

fn replay_outcome(upload: Upload, request: &NewUpload) -> CreateOutcome {
    if upload.upload_length == request.upload_length
        && upload.expected_sha256 == request.expected_sha256
        && request.now < upload.expires_at
        && request.now < upload.hard_expires_at
    {
        CreateOutcome::Replayed(upload)
    } else {
        CreateOutcome::InProgress(upload)
    }
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
        "select upload_id, file_id, revision from file_content where upload_id = $1",
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
