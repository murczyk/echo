use crate::file_registry::entities::{
    file_analysis_control, file_analysis_device_state,
    file_analysis_reanalysis_job, file_analysis_state, file_entry,
    sea_orm_active_enums::FileEntryKind,
};
use chrono::{DateTime, Duration, FixedOffset, NaiveDateTime, Utc};
use sea_orm::sea_query::{Expr, LockBehavior, LockType, OnConflict};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseBackend,
    DatabaseConnection, DatabaseTransaction, DbErr, EntityTrait,
    FromQueryResult, IntoActiveModel, QueryFilter, QueryOrder, QuerySelect,
    Set, Statement, TransactionTrait,
};
use uuid::Uuid;

const ANALYSIS_LEASE_SECONDS: i64 = 5 * 60;
const LAST_ERROR_MAX_BYTES: usize = 4_096;

#[derive(Clone, Debug, FromQueryResult)]
struct AnalysisStateBackfillFile {
    id: Uuid,
    device_id: Uuid,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ClaimedAnalysisDevice {
    pub device_id: Uuid,
    pub lease_token: Uuid,
}

#[derive(Clone, Debug, FromQueryResult)]
pub(super) struct ClaimedAnalysisFile {
    pub file_entry_id: Uuid,
    pub device_id: Uuid,
    pub name: String,
    pub absolute_path: Option<String>,
    pub extension: Option<String>,
    pub file_entry_created_at: NaiveDateTime,
    pub source_revision: i64,
    pub required_generation: i64,
}

#[derive(Debug)]
pub(super) struct ClaimedAnalysisBatch {
    pub lease_token: Uuid,
    pub files: Vec<ClaimedAnalysisFile>,
}

#[derive(Debug, FromQueryResult)]
struct ClaimedAnalysisDeviceRow {
    device_id: Uuid,
}

#[derive(Debug, FromQueryResult)]
struct DeviceClaimCompletion {
    pending: bool,
}

#[derive(Debug, FromQueryResult)]
struct ReanalysisDeviceScope {
    device_id: Uuid,
    upper_file_entry_id: Uuid,
    scheduled_file_count: i64,
}

pub(super) async fn backfill_missing_analysis_state(
    file_db: &DatabaseConnection,
    limit: u64,
) -> Result<bool, DbErr> {
    let transaction = file_db.begin().await?;
    let Some(control) = file_analysis_control::Entity::find_by_id(true)
        .filter(file_analysis_control::Column::BackfillComplete.eq(false))
        .lock_with_behavior(LockType::Update, LockBehavior::SkipLocked)
        .one(&transaction)
        .await?
    else {
        transaction.commit().await?;
        return Ok(false);
    };

    let fetch_limit = limit.checked_add(1).ok_or_else(|| {
        DbErr::Custom("analysis backfill batch size overflow".to_string())
    })?;
    let mut files_query = file_entry::Entity::find()
        .select_only()
        .column(file_entry::Column::Id)
        .column(file_entry::Column::DeviceId)
        .filter(file_entry::Column::Kind.eq(FileEntryKind::File))
        .order_by_asc(file_entry::Column::Id)
        .limit(fetch_limit);
    if let Some(cursor) = control.backfill_cursor {
        files_query = files_query.filter(file_entry::Column::Id.gt(cursor));
    }
    let mut files = files_query
        .into_model::<AnalysisStateBackfillFile>()
        .all(&transaction)
        .await?;
    let has_more = files.len() as u64 > limit;
    if has_more {
        let limit = usize::try_from(limit).map_err(|_| {
            DbErr::Custom(
                "analysis backfill batch size is too large".to_string(),
            )
        })?;
        files.truncate(limit);
    }
    let now = Utc::now().fixed_offset();

    if !files.is_empty() {
        let states =
            files.iter().map(|file| file_analysis_state::ActiveModel {
                file_entry_id: Set(file.id),
                device_id: Set(file.device_id),
                source_revision: Set(1),
                analyzed_source_revision: Set(0),
                required_generation: Set(0),
                analyzed_generation: Set(0),
                analyzed_rule_revision: Set(0),
                pending: Set(true),
                lease_token: Set(None),
                lease_expires_at: Set(None),
                available_at: Set(now),
                attempt_count: Set(0),
                last_error: Set(None),
                last_attempt_at: Set(None),
                created_at: Set(now),
                updated_at: Set(now),
            });
        file_analysis_state::Entity::insert_many(states)
            .on_conflict(
                OnConflict::column(file_analysis_state::Column::FileEntryId)
                    .do_nothing()
                    .to_owned(),
            )
            .exec_without_returning(&transaction)
            .await?;
    }

    let mut control = control.into_active_model();
    if let Some(last_file) = files.last() {
        control.backfill_cursor = Set(Some(last_file.id));
    }
    if !has_more {
        control.backfill_complete = Set(true);
    }
    control.updated_at = Set(now);
    control.update(&transaction).await?;
    transaction.commit().await?;
    Ok(true)
}

pub(super) async fn expand_next_legacy_reanalysis_job(
    file_db: &DatabaseConnection,
    limit: u64,
) -> Result<bool, DbErr> {
    let transaction = file_db.begin().await?;
    let Some(job) = file_analysis_reanalysis_job::Entity::find()
        .filter(file_analysis_reanalysis_job::Column::DeviceId.is_null())
        .filter(file_analysis_reanalysis_job::Column::ExpandedAt.is_null())
        .order_by_asc(file_analysis_reanalysis_job::Column::CreatedAt)
        .order_by_asc(file_analysis_reanalysis_job::Column::Id)
        .lock_with_behavior(LockType::Update, LockBehavior::SkipLocked)
        .one(&transaction)
        .await?
    else {
        transaction.commit().await?;
        return Ok(false);
    };

    expand_reanalysis_job(&transaction, job, limit).await?;
    transaction.commit().await?;
    Ok(true)
}

pub(super) async fn expand_next_device_reanalysis_job(
    file_db: &DatabaseConnection,
    claim: &ClaimedAnalysisDevice,
    limit: u64,
) -> Result<bool, DbErr> {
    let transaction = file_db.begin().await?;
    let Some(device_state) =
        file_analysis_device_state::Entity::find_by_id(claim.device_id)
            .filter(file_analysis_device_state::Column::Pending.eq(true))
            .filter(
                file_analysis_device_state::Column::LeaseToken
                    .eq(claim.lease_token),
            )
            .lock_exclusive()
            .one(&transaction)
            .await?
    else {
        transaction.commit().await?;
        return Ok(false);
    };

    let now = Utc::now().fixed_offset();
    let mut device_state = device_state.into_active_model();
    device_state.lease_expires_at =
        Set(Some(now + Duration::seconds(ANALYSIS_LEASE_SECONDS)));
    device_state.updated_at = Set(now);
    device_state.update(&transaction).await?;

    let Some(job) = file_analysis_reanalysis_job::Entity::find()
        .filter(
            file_analysis_reanalysis_job::Column::DeviceId.eq(claim.device_id),
        )
        .filter(file_analysis_reanalysis_job::Column::ExpandedAt.is_null())
        .order_by_asc(file_analysis_reanalysis_job::Column::CreatedAt)
        .order_by_asc(file_analysis_reanalysis_job::Column::Id)
        .lock_with_behavior(LockType::Update, LockBehavior::SkipLocked)
        .one(&transaction)
        .await?
    else {
        transaction.commit().await?;
        return Ok(false);
    };

    expand_reanalysis_job(&transaction, job, limit).await?;
    transaction.commit().await?;
    Ok(true)
}

async fn expand_reanalysis_job(
    transaction: &DatabaseTransaction,
    job: file_analysis_reanalysis_job::Model,
    limit: u64,
) -> Result<(), DbErr> {
    if limit == 0 {
        return Err(DbErr::Custom(
            "file analysis expansion batch size must be positive".to_string(),
        ));
    }

    let mut files_query = file_entry::Entity::find()
        .select_only()
        .column(file_entry::Column::Id)
        .column(file_entry::Column::DeviceId)
        .filter(file_entry::Column::Kind.eq(FileEntryKind::File))
        .filter(file_entry::Column::Id.lte(job.upper_file_entry_id))
        .order_by_asc(file_entry::Column::Id)
        .limit(limit);
    if let Some(device_id) = job.device_id {
        files_query =
            files_query.filter(file_entry::Column::DeviceId.eq(device_id));
    }
    if let Some(cursor) = job.cursor_file_entry_id {
        files_query = files_query.filter(file_entry::Column::Id.gt(cursor));
    }
    let files = files_query
        .into_model::<AnalysisStateBackfillFile>()
        .all(transaction)
        .await?;
    let now = Utc::now().fixed_offset();

    if !files.is_empty() {
        let states =
            files.iter().map(|file| file_analysis_state::ActiveModel {
                file_entry_id: Set(file.id),
                device_id: Set(file.device_id),
                source_revision: Set(1),
                analyzed_source_revision: Set(0),
                required_generation: Set(job.generation),
                analyzed_generation: Set(0),
                analyzed_rule_revision: Set(0),
                pending: Set(true),
                lease_token: Set(None),
                lease_expires_at: Set(None),
                available_at: Set(now),
                attempt_count: Set(0),
                last_error: Set(None),
                last_attempt_at: Set(None),
                created_at: Set(now),
                updated_at: Set(now),
            });
        file_analysis_state::Entity::insert_many(states)
            .on_conflict(
                OnConflict::column(file_analysis_state::Column::FileEntryId)
                    .do_nothing()
                    .to_owned(),
            )
            .exec_without_returning(transaction)
            .await?;

        let file_entry_ids =
            files.iter().map(|file| file.id).collect::<Vec<_>>();
        file_analysis_state::Entity::update_many()
            .col_expr(
                file_analysis_state::Column::RequiredGeneration,
                Expr::value(job.generation),
            )
            .col_expr(file_analysis_state::Column::Pending, Expr::value(true))
            .col_expr(
                file_analysis_state::Column::AvailableAt,
                Expr::value(now),
            )
            .col_expr(file_analysis_state::Column::AttemptCount, Expr::value(0))
            .col_expr(
                file_analysis_state::Column::LastError,
                Expr::value(Option::<String>::None),
            )
            .col_expr(file_analysis_state::Column::UpdatedAt, Expr::value(now))
            .filter(
                file_analysis_state::Column::FileEntryId.is_in(file_entry_ids),
            )
            .filter(
                file_analysis_state::Column::RequiredGeneration
                    .lt(job.generation),
            )
            .filter(file_analysis_state::Column::Pending.eq(false))
            .exec(transaction)
            .await?;
    }

    let expanded_file_count = job
        .expanded_file_count
        .checked_add(files.len() as i64)
        .ok_or_else(|| {
            DbErr::Custom("file analysis expansion count overflow".to_string())
        })?;
    let reached_upper_bound = files
        .last()
        .is_some_and(|file| file.id == job.upper_file_entry_id);
    let expansion_complete = files.len() as u64 != limit || reached_upper_bound;
    let mut job = job.into_active_model();
    if let Some(last_file) = files.last() {
        job.cursor_file_entry_id = Set(Some(last_file.id));
    }
    job.expanded_file_count = Set(expanded_file_count);
    if expansion_complete {
        job.expanded_at = Set(Some(now));
    }
    job.updated_at = Set(now);
    job.update(transaction).await?;
    Ok(())
}

pub(super) async fn recover_expired_analysis_leases(
    file_db: &DatabaseConnection,
    limit: u64,
) -> Result<u64, DbErr> {
    let limit = i64::try_from(limit).map_err(|_| {
        DbErr::Custom("analysis batch size is too large".to_string())
    })?;
    file_db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
            with expired as materialized (
                select file_entry_id
                from file_analysis_state
                where pending
                  and lease_token is not null
                  and lease_expires_at <= clock_timestamp()
                order by lease_expires_at, file_entry_id
                limit $1
                for update skip locked
            )
            update file_analysis_state as state
            set lease_token = null,
                lease_expires_at = null,
                available_at = clock_timestamp() + interval '1 second',
                last_error = 'analysis lease expired before acknowledgement',
                updated_at = clock_timestamp()
            from expired
            where state.file_entry_id = expired.file_entry_id
            "#,
            [limit.into()],
        ))
        .await
        .map(|result| result.rows_affected())
}

pub(super) async fn recover_expired_analysis_device_leases(
    file_db: &DatabaseConnection,
    limit: u64,
) -> Result<u64, DbErr> {
    let transaction = file_db.begin().await?;
    let now = Utc::now().fixed_offset();
    let expired = file_analysis_device_state::Entity::find()
        .filter(file_analysis_device_state::Column::Pending.eq(true))
        .filter(file_analysis_device_state::Column::LeaseToken.is_not_null())
        .filter(file_analysis_device_state::Column::LeaseExpiresAt.lte(now))
        .order_by_asc(file_analysis_device_state::Column::LeaseExpiresAt)
        .order_by_asc(file_analysis_device_state::Column::DeviceId)
        .limit(limit)
        .lock_with_behavior(LockType::Update, LockBehavior::SkipLocked)
        .all(&transaction)
        .await?;
    if expired.is_empty() {
        transaction.commit().await?;
        return Ok(0);
    }

    let device_ids = expired
        .iter()
        .map(|device| device.device_id)
        .collect::<Vec<_>>();
    let lease_tokens = expired
        .iter()
        .filter_map(|device| device.lease_token)
        .collect::<Vec<_>>();
    let retry_at = now + Duration::seconds(1);
    file_analysis_device_state::Entity::update_many()
        .col_expr(
            file_analysis_device_state::Column::LeaseToken,
            Expr::value(Option::<Uuid>::None),
        )
        .col_expr(
            file_analysis_device_state::Column::LeaseExpiresAt,
            Expr::value(Option::<DateTime<FixedOffset>>::None),
        )
        .col_expr(
            file_analysis_device_state::Column::AvailableAt,
            Expr::value(retry_at),
        )
        .col_expr(
            file_analysis_device_state::Column::UpdatedAt,
            Expr::value(now),
        )
        .filter(file_analysis_device_state::Column::DeviceId.is_in(device_ids))
        .filter(
            file_analysis_device_state::Column::LeaseToken
                .is_in(lease_tokens.iter().copied()),
        )
        .exec(&transaction)
        .await?;
    if !lease_tokens.is_empty() {
        file_analysis_state::Entity::update_many()
            .col_expr(
                file_analysis_state::Column::LeaseToken,
                Expr::value(Option::<Uuid>::None),
            )
            .col_expr(
                file_analysis_state::Column::LeaseExpiresAt,
                Expr::value(Option::<DateTime<FixedOffset>>::None),
            )
            .col_expr(
                file_analysis_state::Column::AvailableAt,
                Expr::value(retry_at),
            )
            .col_expr(
                file_analysis_state::Column::LastError,
                Expr::value("analysis device lease expired before completion"),
            )
            .col_expr(file_analysis_state::Column::UpdatedAt, Expr::value(now))
            .filter(
                file_analysis_state::Column::LeaseToken
                    .is_in(lease_tokens.iter().copied()),
            )
            .exec(&transaction)
            .await?;
    }
    transaction.commit().await?;
    Ok(expired.len() as u64)
}

pub(super) async fn claim_pending_analysis_device(
    file_db: &DatabaseConnection,
) -> Result<Option<ClaimedAnalysisDevice>, DbErr> {
    let lease_token = Uuid::now_v7();
    let device = ClaimedAnalysisDeviceRow::find_by_statement(
        Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
            with candidate as materialized (
                select device_id
                from file_analysis_device_state
                where pending
                  and lease_token is null
                  and available_at <= clock_timestamp()
                  and exists (
                      select 1
                      from file_analysis_control
                      where id and backfill_complete
                  )
                  and not exists (
                      select 1
                      from file_analysis_reanalysis_job
                      where device_id is null and expanded_at is null
                  )
                order by available_at, device_id
                limit 1
                for update skip locked
            )
            update file_analysis_device_state as state
            set lease_token = $1,
                lease_expires_at = clock_timestamp()
                    + ($2::double precision * interval '1 second'),
                updated_at = clock_timestamp()
            from candidate
            where state.device_id = candidate.device_id
            returning state.device_id
            "#,
            [lease_token.into(), ANALYSIS_LEASE_SECONDS.into()],
        ),
    )
    .one(file_db)
    .await?;
    Ok(device.map(|device| ClaimedAnalysisDevice {
        device_id: device.device_id,
        lease_token,
    }))
}

pub(super) async fn claim_pending_analysis_files(
    file_db: &DatabaseConnection,
    device: &ClaimedAnalysisDevice,
    limit: u64,
) -> Result<ClaimedAnalysisBatch, DbErr> {
    let limit = i64::try_from(limit).map_err(|_| {
        DbErr::Custom("analysis batch size is too large".to_string())
    })?;
    let transaction = file_db.begin().await?;
    let files =
        ClaimedAnalysisFile::find_by_statement(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
            with renewed_device as materialized (
                update file_analysis_device_state
                set lease_expires_at = clock_timestamp()
                        + ($3::double precision * interval '1 second'),
                    updated_at = clock_timestamp()
                where device_id = $1
                  and pending
                  and lease_token = $2
                  and lease_expires_at > clock_timestamp()
                returning device_id
            ), candidates as materialized (
                select file_entry_id
                from file_analysis_state
                where device_id = $1
                  and pending
                  and lease_token is null
                  and available_at <= clock_timestamp()
                  and exists (select 1 from renewed_device)
                order by available_at, file_entry_id
                limit $4
                for update skip locked
            ), claimed as (
                update file_analysis_state as state
                set lease_token = $2,
                    lease_expires_at = clock_timestamp()
                        + ($3::double precision * interval '1 second'),
                    attempt_count = state.attempt_count + 1,
                    last_attempt_at = clock_timestamp(),
                    updated_at = clock_timestamp()
                from candidates
                where state.file_entry_id = candidates.file_entry_id
                returning
                    state.file_entry_id,
                    state.source_revision,
                    state.required_generation
            )
            select
                claimed.file_entry_id,
                entry.device_id,
                entry.name,
                entry.absolute_path,
                entry.extension,
                entry.created_at as file_entry_created_at,
                claimed.source_revision,
                claimed.required_generation
            from claimed
            join file_entry as entry
              on entry.id = claimed.file_entry_id
            order by claimed.file_entry_id
            "#,
            [
                device.device_id.into(),
                device.lease_token.into(),
                ANALYSIS_LEASE_SECONDS.into(),
                limit.into(),
            ],
        ))
        .all(&transaction)
        .await?;
    transaction.commit().await?;
    Ok(ClaimedAnalysisBatch {
        lease_token: device.lease_token,
        files,
    })
}

pub(super) async fn lock_claim_states(
    transaction: &DatabaseTransaction,
    lease_token: Uuid,
    file_entry_ids: &[Uuid],
) -> Result<Vec<file_analysis_state::Model>, DbErr> {
    if file_entry_ids.is_empty() {
        return Ok(Vec::new());
    }
    file_analysis_state::Entity::find()
        .filter(
            file_analysis_state::Column::FileEntryId
                .is_in(file_entry_ids.iter().copied()),
        )
        .filter(file_analysis_state::Column::LeaseToken.eq(lease_token))
        .filter(file_analysis_state::Column::Pending.eq(true))
        .order_by_asc(file_analysis_state::Column::FileEntryId)
        .lock_exclusive()
        .all(transaction)
        .await
}

pub(super) async fn acknowledge_claim(
    transaction: &DatabaseTransaction,
    lease_token: Uuid,
    file_entry_ids: &[Uuid],
    analyzed_rule_revision: i64,
) -> Result<u64, DbErr> {
    if file_entry_ids.is_empty() {
        return Ok(0);
    }
    let now = Utc::now().fixed_offset();
    file_analysis_state::Entity::update_many()
        .col_expr(
            file_analysis_state::Column::AnalyzedSourceRevision,
            Expr::col(file_analysis_state::Column::SourceRevision),
        )
        .col_expr(
            file_analysis_state::Column::AnalyzedGeneration,
            Expr::col(file_analysis_state::Column::RequiredGeneration),
        )
        .col_expr(
            file_analysis_state::Column::AnalyzedRuleRevision,
            Expr::value(analyzed_rule_revision),
        )
        .col_expr(file_analysis_state::Column::Pending, Expr::value(false))
        .col_expr(
            file_analysis_state::Column::LeaseToken,
            Expr::value(Option::<Uuid>::None),
        )
        .col_expr(
            file_analysis_state::Column::LeaseExpiresAt,
            Expr::value(Option::<DateTime<FixedOffset>>::None),
        )
        .col_expr(file_analysis_state::Column::AvailableAt, Expr::value(now))
        .col_expr(file_analysis_state::Column::AttemptCount, Expr::value(0))
        .col_expr(
            file_analysis_state::Column::LastError,
            Expr::value(Option::<String>::None),
        )
        .col_expr(file_analysis_state::Column::UpdatedAt, Expr::value(now))
        .filter(
            file_analysis_state::Column::FileEntryId
                .is_in(file_entry_ids.iter().copied()),
        )
        .filter(file_analysis_state::Column::LeaseToken.eq(lease_token))
        .exec(transaction)
        .await
        .map(|result| result.rows_affected)
}

pub(super) async fn release_claim(
    transaction: &DatabaseTransaction,
    lease_token: Uuid,
) -> Result<u64, DbErr> {
    let now = Utc::now().fixed_offset();
    file_analysis_state::Entity::update_many()
        .col_expr(
            file_analysis_state::Column::LeaseToken,
            Expr::value(Option::<Uuid>::None),
        )
        .col_expr(
            file_analysis_state::Column::LeaseExpiresAt,
            Expr::value(Option::<DateTime<FixedOffset>>::None),
        )
        .col_expr(file_analysis_state::Column::AvailableAt, Expr::value(now))
        .col_expr(file_analysis_state::Column::AttemptCount, Expr::value(0))
        .col_expr(
            file_analysis_state::Column::LastError,
            Expr::value(Option::<String>::None),
        )
        .col_expr(file_analysis_state::Column::UpdatedAt, Expr::value(now))
        .filter(file_analysis_state::Column::LeaseToken.eq(lease_token))
        .exec(transaction)
        .await
        .map(|result| result.rows_affected)
}

pub(super) async fn release_claim_with_error<C>(
    file_db: &C,
    lease_token: Uuid,
    error: &str,
) -> Result<u64, DbErr>
where
    C: ConnectionTrait,
{
    let error = truncate_last_error(error);
    file_analysis_state::Entity::update_many()
        .col_expr(
            file_analysis_state::Column::LeaseToken,
            Expr::value(Option::<Uuid>::None),
        )
        .col_expr(
            file_analysis_state::Column::LeaseExpiresAt,
            Expr::value(Option::<DateTime<FixedOffset>>::None),
        )
        .col_expr(
            file_analysis_state::Column::AvailableAt,
            Expr::cust(
                "clock_timestamp() + (
                    least(
                        300,
                        power(
                            2,
                            least(greatest(attempt_count - 1, 0), 8)
                        )::integer
                    )::double precision * interval '1 second'
                )",
            ),
        )
        .col_expr(file_analysis_state::Column::LastError, Expr::value(error))
        .col_expr(
            file_analysis_state::Column::UpdatedAt,
            Expr::cust("clock_timestamp()"),
        )
        .filter(file_analysis_state::Column::LeaseToken.eq(lease_token))
        .exec(file_db)
        .await
        .map(|result| result.rows_affected)
}

pub(super) async fn release_analysis_device_claim(
    file_db: &DatabaseConnection,
    claim: &ClaimedAnalysisDevice,
) -> Result<u64, DbErr> {
    file_analysis_device_state::Entity::update_many()
        .col_expr(
            file_analysis_device_state::Column::LeaseToken,
            Expr::value(Option::<Uuid>::None),
        )
        .col_expr(
            file_analysis_device_state::Column::LeaseExpiresAt,
            Expr::value(Option::<DateTime<FixedOffset>>::None),
        )
        .col_expr(
            file_analysis_device_state::Column::AvailableAt,
            Expr::cust("clock_timestamp()"),
        )
        .col_expr(
            file_analysis_device_state::Column::UpdatedAt,
            Expr::cust("clock_timestamp()"),
        )
        .filter(
            file_analysis_device_state::Column::DeviceId.eq(claim.device_id),
        )
        .filter(
            file_analysis_device_state::Column::LeaseToken
                .eq(claim.lease_token),
        )
        .exec(file_db)
        .await
        .map(|result| result.rows_affected)
}

pub(super) async fn release_analysis_device_claim_with_error(
    file_db: &DatabaseConnection,
    claim: &ClaimedAnalysisDevice,
    error: &str,
) -> Result<(), DbErr> {
    let transaction = file_db.begin().await?;
    release_claim_with_error(&transaction, claim.lease_token, error).await?;
    file_analysis_device_state::Entity::update_many()
        .col_expr(
            file_analysis_device_state::Column::LeaseToken,
            Expr::value(Option::<Uuid>::None),
        )
        .col_expr(
            file_analysis_device_state::Column::LeaseExpiresAt,
            Expr::value(Option::<DateTime<FixedOffset>>::None),
        )
        .col_expr(
            file_analysis_device_state::Column::AvailableAt,
            Expr::cust("clock_timestamp() + interval '1 second'"),
        )
        .col_expr(
            file_analysis_device_state::Column::UpdatedAt,
            Expr::cust("clock_timestamp()"),
        )
        .filter(
            file_analysis_device_state::Column::DeviceId.eq(claim.device_id),
        )
        .filter(
            file_analysis_device_state::Column::LeaseToken
                .eq(claim.lease_token),
        )
        .exec(&transaction)
        .await?;
    transaction.commit().await
}

pub(super) async fn complete_analysis_device_claim(
    file_db: &DatabaseConnection,
    claim: &ClaimedAnalysisDevice,
) -> Result<Option<bool>, DbErr> {
    DeviceClaimCompletion::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"
        with remaining as materialized (
            select min(
                case
                    when lease_token is null then available_at
                    else greatest(available_at, lease_expires_at)
                end
            ) as next_available_at
            from file_analysis_state
            where device_id = $1 and pending
        ), active_job as materialized (
            select exists (
                select 1
                from file_analysis_reanalysis_job
                where device_id = $1 and expanded_at is null
            ) as present
        )
        update file_analysis_device_state as state
        set pending = (
                remaining.next_available_at is not null or active_job.present
            ),
            lease_token = null,
            lease_expires_at = null,
            available_at = case
                when active_job.present then clock_timestamp()
                else coalesce(
                    remaining.next_available_at,
                    clock_timestamp()
                )
            end,
            updated_at = clock_timestamp()
        from remaining, active_job
        where state.device_id = $1 and state.lease_token = $2
        returning state.pending
        "#,
        [claim.device_id.into(), claim.lease_token.into()],
    ))
    .one(file_db)
    .await
    .map(|completion| completion.map(|completion| completion.pending))
}

async fn load_reanalysis_scopes(
    transaction: &DatabaseTransaction,
    device_id: Option<Uuid>,
    target_rule_revision: i64,
) -> Result<Vec<ReanalysisDeviceScope>, DbErr> {
    let (sql, values) = if let Some(device_id) = device_id {
        (
            r#"
            select distinct on (entry.device_id)
                entry.device_id,
                entry.id as upper_file_entry_id,
                count(*) over (partition by entry.device_id)
                    as scheduled_file_count
            from file_entry as entry
            join file_analysis_state as state
              on state.file_entry_id = entry.id
            where entry.kind = 'file'
              and not state.pending
              and entry.device_id = $2
              and not exists (
                  select 1
                  from file_analysis_reanalysis_job as job
                  where job.expanded_at is null
                    and job.target_rule_revision = $1
                    and (
                        job.device_id is null
                        or job.device_id = entry.device_id
                    )
              )
            order by entry.device_id, entry.id desc
            "#,
            vec![target_rule_revision.into(), device_id.into()],
        )
    } else {
        (
            r#"
            select distinct on (entry.device_id)
                entry.device_id,
                entry.id as upper_file_entry_id,
                count(*) over (partition by entry.device_id)
                    as scheduled_file_count
            from file_entry as entry
            join file_analysis_state as state
              on state.file_entry_id = entry.id
            where entry.kind = 'file'
              and not state.pending
              and not exists (
                  select 1
                  from file_analysis_reanalysis_job as job
                  where job.expanded_at is null
                    and job.target_rule_revision = $1
                    and (
                        job.device_id is null
                        or job.device_id = entry.device_id
                    )
              )
            order by entry.device_id, entry.id desc
            "#,
            vec![target_rule_revision.into()],
        )
    };
    ReanalysisDeviceScope::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        sql,
        values,
    ))
    .all(transaction)
    .await
}

pub(super) async fn schedule_reanalysis(
    file_db: &DatabaseConnection,
    device_id: Option<Uuid>,
    target_rule_revision: i64,
) -> Result<u64, DbErr> {
    if target_rule_revision < 0 {
        return Err(DbErr::Custom(
            "analytics tag rule revision must be non-negative".to_string(),
        ));
    }

    let transaction = file_db.begin().await?;
    let control = file_analysis_control::Entity::find_by_id(true)
        .lock_exclusive()
        .one(&transaction)
        .await?
        .ok_or_else(|| {
            DbErr::RecordNotFound(
                "file_analysis_control singleton is missing".to_string(),
            )
        })?;
    let scopes =
        load_reanalysis_scopes(&transaction, device_id, target_rule_revision)
            .await?;
    if scopes.is_empty() {
        transaction.commit().await?;
        return Ok(0);
    }

    let generation_count = i64::try_from(scopes.len()).map_err(|_| {
        DbErr::Custom("file analysis scope count is too large".to_string())
    })?;
    let next_generation = control
        .next_generation
        .checked_add(generation_count)
        .ok_or_else(|| {
            DbErr::Custom("file analysis generation overflow".to_string())
        })?;
    let now = Utc::now().fixed_offset();
    let first_generation = control.next_generation;
    let mut control = control.into_active_model();
    control.next_generation = Set(next_generation);
    control.updated_at = Set(now);
    control.update(&transaction).await?;

    let scheduled_file_count =
        scopes.iter().try_fold(0_i64, |total, scope| {
            total
                .checked_add(scope.scheduled_file_count)
                .ok_or_else(|| {
                    DbErr::Custom(
                        "file analysis scheduled count overflow".to_string(),
                    )
                })
        })?;
    let jobs = (first_generation..next_generation).zip(scopes).map(
        |(generation, scope)| file_analysis_reanalysis_job::ActiveModel {
            id: Set(Uuid::now_v7()),
            device_id: Set(Some(scope.device_id)),
            target_rule_revision: Set(target_rule_revision),
            generation: Set(generation),
            upper_file_entry_id: Set(scope.upper_file_entry_id),
            cursor_file_entry_id: Set(None),
            scheduled_file_count: Set(scope.scheduled_file_count),
            expanded_file_count: Set(0),
            expanded_at: Set(None),
            created_at: Set(now),
            updated_at: Set(now),
        },
    );
    file_analysis_reanalysis_job::Entity::insert_many(jobs)
        .exec_without_returning(&transaction)
        .await?;

    let scheduled_file_count =
        scheduled_file_count.try_into().map_err(|_| {
            DbErr::Custom("negative scheduled file count".to_string())
        })?;
    transaction.commit().await?;
    Ok(scheduled_file_count)
}

fn truncate_last_error(error: &str) -> String {
    if error.len() <= LAST_ERROR_MAX_BYTES {
        return error.to_string();
    }
    let suffix = "...";
    let mut end = LAST_ERROR_MAX_BYTES - suffix.len();
    while !error.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{suffix}", &error[..end])
}
