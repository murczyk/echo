use super::DEVICE_FILE_ANALYSIS_MAX_ATTEMPTS;
use crate::file_registry::entities::{
    file_analysis_control, file_analysis_device_state,
    file_analysis_reanalysis_job, file_analysis_state, file_entry,
    sea_orm_active_enums::FileEntryKind,
};
use chrono::{DateTime, Duration, FixedOffset, NaiveDateTime, Utc};
use sea_orm::sea_query::{
    Alias, Expr, Func, JoinType, LockBehavior, LockType, OnConflict, Order,
    Query, SimpleExpr,
};
use sea_orm::{
    ActiveEnum, ActiveModelTrait, ColumnTrait, Condition, ConnectionTrait,
    DatabaseConnection, DatabaseTransaction, DbErr, EntityTrait, ExprTrait,
    FromQueryResult, IntoActiveModel, QueryFilter, QueryOrder, QuerySelect,
    QueryTrait, RelationTrait, Set, TransactionTrait,
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
struct RemainingAnalysisState {
    next_available_at: Option<DateTime<FixedOffset>>,
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
                retry_exhausted: Set(false),
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
                retry_exhausted: Set(false),
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
                file_analysis_state::Column::RetryExhausted,
                Expr::value(false),
            )
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
    let transaction = file_db.begin().await?;
    let now = Utc::now().fixed_offset();
    let expired = file_analysis_state::Entity::find()
        .filter(file_analysis_state::Column::Pending.eq(true))
        .filter(file_analysis_state::Column::LeaseToken.is_not_null())
        .filter(file_analysis_state::Column::LeaseExpiresAt.lte(now))
        .order_by_asc(file_analysis_state::Column::LeaseExpiresAt)
        .order_by_asc(file_analysis_state::Column::FileEntryId)
        .limit(limit)
        .lock_with_behavior(LockType::Update, LockBehavior::SkipLocked)
        .all(&transaction)
        .await?;
    if expired.is_empty() {
        transaction.commit().await?;
        return Ok(0);
    }

    let file_entry_ids = expired
        .iter()
        .map(|state| state.file_entry_id)
        .collect::<Vec<_>>();
    let retry_at = now + Duration::seconds(1);
    let result = file_analysis_state::Entity::update_many()
        .col_expr(
            file_analysis_state::Column::Pending,
            Expr::col(file_analysis_state::Column::AttemptCount)
                .lt(DEVICE_FILE_ANALYSIS_MAX_ATTEMPTS),
        )
        .col_expr(
            file_analysis_state::Column::RetryExhausted,
            Expr::col(file_analysis_state::Column::AttemptCount)
                .gte(DEVICE_FILE_ANALYSIS_MAX_ATTEMPTS),
        )
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
            Expr::case(
                Expr::col(file_analysis_state::Column::AttemptCount)
                    .gte(DEVICE_FILE_ANALYSIS_MAX_ATTEMPTS),
                now,
            )
            .finally(retry_at)
            .into(),
        )
        .col_expr(
            file_analysis_state::Column::LastError,
            Expr::value("analysis lease expired before acknowledgement"),
        )
        .col_expr(file_analysis_state::Column::UpdatedAt, Expr::value(now))
        .filter(file_analysis_state::Column::FileEntryId.is_in(file_entry_ids))
        .exec(&transaction)
        .await?;
    transaction.commit().await?;
    Ok(result.rows_affected)
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
                file_analysis_state::Column::Pending,
                Expr::col(file_analysis_state::Column::AttemptCount)
                    .lt(DEVICE_FILE_ANALYSIS_MAX_ATTEMPTS),
            )
            .col_expr(
                file_analysis_state::Column::RetryExhausted,
                Expr::col(file_analysis_state::Column::AttemptCount)
                    .gte(DEVICE_FILE_ANALYSIS_MAX_ATTEMPTS),
            )
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
    let transaction = file_db.begin().await?;
    let now = Utc::now().fixed_offset();
    let completed_backfill = file_analysis_control::Entity::find()
        .select_only()
        .expr(Expr::value(1))
        .filter(file_analysis_control::Column::Id.eq(true))
        .filter(file_analysis_control::Column::BackfillComplete.eq(true))
        .into_query();
    let active_legacy_reanalysis = file_analysis_reanalysis_job::Entity::find()
        .select_only()
        .expr(Expr::value(1))
        .filter(file_analysis_reanalysis_job::Column::DeviceId.is_null())
        .filter(file_analysis_reanalysis_job::Column::ExpandedAt.is_null())
        .into_query();
    let device = file_analysis_device_state::Entity::find()
        .filter(file_analysis_device_state::Column::Pending.eq(true))
        .filter(file_analysis_device_state::Column::LeaseToken.is_null())
        .filter(file_analysis_device_state::Column::AvailableAt.lte(now))
        .filter(Expr::exists(completed_backfill))
        .filter(Expr::exists(active_legacy_reanalysis).not())
        .order_by_asc(file_analysis_device_state::Column::AvailableAt)
        .order_by_asc(file_analysis_device_state::Column::DeviceId)
        .lock_with_behavior(LockType::Update, LockBehavior::SkipLocked)
        .one(&transaction)
        .await?;
    let claimed = if let Some(device) = device {
        let device_id = device.device_id;
        let lease_token = Uuid::now_v7();
        let mut device = device.into_active_model();
        device.lease_token = Set(Some(lease_token));
        device.lease_expires_at =
            Set(Some(now + Duration::seconds(ANALYSIS_LEASE_SECONDS)));
        device.updated_at = Set(now);
        device.update(&transaction).await?;
        Some(ClaimedAnalysisDevice {
            device_id,
            lease_token,
        })
    } else {
        None
    };
    transaction.commit().await?;
    Ok(claimed)
}

pub(super) async fn claim_pending_analysis_files(
    file_db: &DatabaseConnection,
    device: &ClaimedAnalysisDevice,
    limit: u64,
) -> Result<ClaimedAnalysisBatch, DbErr> {
    let transaction = file_db.begin().await?;
    let now = Utc::now().fixed_offset();
    let lease_expires_at = now + Duration::seconds(ANALYSIS_LEASE_SECONDS);
    let renewal = file_analysis_device_state::Entity::update_many()
        .col_expr(
            file_analysis_device_state::Column::LeaseExpiresAt,
            Expr::value(lease_expires_at),
        )
        .col_expr(
            file_analysis_device_state::Column::UpdatedAt,
            Expr::value(now),
        )
        .filter(
            file_analysis_device_state::Column::DeviceId.eq(device.device_id),
        )
        .filter(file_analysis_device_state::Column::Pending.eq(true))
        .filter(
            file_analysis_device_state::Column::LeaseToken
                .eq(device.lease_token),
        )
        .filter(file_analysis_device_state::Column::LeaseExpiresAt.gt(now))
        .exec(&transaction)
        .await?;
    if renewal.rows_affected == 0 {
        transaction.commit().await?;
        return Ok(ClaimedAnalysisBatch {
            lease_token: device.lease_token,
            files: Vec::new(),
        });
    }

    let candidates = file_analysis_state::Entity::find()
        .filter(file_analysis_state::Column::DeviceId.eq(device.device_id))
        .filter(file_analysis_state::Column::Pending.eq(true))
        .filter(file_analysis_state::Column::LeaseToken.is_null())
        .filter(file_analysis_state::Column::AvailableAt.lte(now))
        .order_by_asc(file_analysis_state::Column::AvailableAt)
        .order_by_asc(file_analysis_state::Column::FileEntryId)
        .limit(limit)
        .lock_with_behavior(LockType::Update, LockBehavior::SkipLocked)
        .all(&transaction)
        .await?;
    let file_entry_ids = candidates
        .iter()
        .map(|state| state.file_entry_id)
        .collect::<Vec<_>>();
    if file_entry_ids.is_empty() {
        transaction.commit().await?;
        return Ok(ClaimedAnalysisBatch {
            lease_token: device.lease_token,
            files: Vec::new(),
        });
    }

    file_analysis_state::Entity::update_many()
        .col_expr(
            file_analysis_state::Column::LeaseToken,
            Expr::value(Some(device.lease_token)),
        )
        .col_expr(
            file_analysis_state::Column::LeaseExpiresAt,
            Expr::value(Some(lease_expires_at)),
        )
        .col_expr(
            file_analysis_state::Column::AttemptCount,
            Expr::col(file_analysis_state::Column::AttemptCount).add(1),
        )
        .col_expr(
            file_analysis_state::Column::LastAttemptAt,
            Expr::value(Some(now)),
        )
        .col_expr(file_analysis_state::Column::UpdatedAt, Expr::value(now))
        .filter(
            file_analysis_state::Column::FileEntryId
                .is_in(file_entry_ids.iter().copied()),
        )
        .exec(&transaction)
        .await?;
    let files = file_entry::Entity::find()
        .select_only()
        .tbl_col_as(
            (file_entry::Entity, file_entry::Column::Id),
            "file_entry_id",
        )
        .column(file_entry::Column::DeviceId)
        .column(file_entry::Column::Name)
        .column(file_entry::Column::AbsolutePath)
        .column(file_entry::Column::Extension)
        .tbl_col_as(
            (file_entry::Entity, file_entry::Column::CreatedAt),
            "file_entry_created_at",
        )
        .column(file_analysis_state::Column::SourceRevision)
        .column(file_analysis_state::Column::RequiredGeneration)
        .join(
            JoinType::InnerJoin,
            file_entry::Relation::FileAnalysisState.def(),
        )
        .filter(file_entry::Column::DeviceId.eq(device.device_id))
        .filter(file_entry::Column::Kind.eq(FileEntryKind::File))
        .filter(file_entry::Column::Id.is_in(file_entry_ids))
        .filter(file_analysis_state::Column::LeaseToken.eq(device.lease_token))
        .order_by_asc(file_entry::Column::Id)
        .into_model::<ClaimedAnalysisFile>()
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
            file_analysis_state::Column::RetryExhausted,
            Expr::value(false),
        )
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
            file_analysis_state::Column::RetryExhausted,
            Expr::value(false),
        )
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
    let now = Utc::now().fixed_offset();
    let error = truncate_last_error(error);
    file_analysis_state::Entity::update_many()
        .col_expr(
            file_analysis_state::Column::Pending,
            Expr::col(file_analysis_state::Column::AttemptCount)
                .lt(DEVICE_FILE_ANALYSIS_MAX_ATTEMPTS),
        )
        .col_expr(
            file_analysis_state::Column::RetryExhausted,
            Expr::col(file_analysis_state::Column::AttemptCount)
                .gte(DEVICE_FILE_ANALYSIS_MAX_ATTEMPTS),
        )
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
            retry_available_at_expr(now),
        )
        .col_expr(file_analysis_state::Column::LastError, Expr::value(error))
        .col_expr(file_analysis_state::Column::UpdatedAt, Expr::value(now))
        .filter(file_analysis_state::Column::LeaseToken.eq(lease_token))
        .exec(file_db)
        .await
        .map(|result| result.rows_affected)
}

pub(super) async fn release_analysis_device_claim(
    file_db: &DatabaseConnection,
    claim: &ClaimedAnalysisDevice,
) -> Result<u64, DbErr> {
    let now = Utc::now().fixed_offset();
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
            Expr::value(now),
        )
        .col_expr(
            file_analysis_device_state::Column::UpdatedAt,
            Expr::value(now),
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
    let now = Utc::now().fixed_offset();
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
            Expr::value(now + Duration::seconds(1)),
        )
        .col_expr(
            file_analysis_device_state::Column::UpdatedAt,
            Expr::value(now),
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
    let transaction = file_db.begin().await?;
    let Some(device) =
        file_analysis_device_state::Entity::find_by_id(claim.device_id)
            .filter(
                file_analysis_device_state::Column::LeaseToken
                    .eq(claim.lease_token),
            )
            .lock_exclusive()
            .one(&transaction)
            .await?
    else {
        transaction.commit().await?;
        return Ok(None);
    };

    let next_available_at = Expr::case(
        file_analysis_state::Column::LeaseToken.is_null(),
        Expr::col(file_analysis_state::Column::AvailableAt),
    )
    .finally(Func::greatest([
        Expr::col(file_analysis_state::Column::AvailableAt),
        Expr::col(file_analysis_state::Column::LeaseExpiresAt),
    ]));
    let remaining = file_analysis_state::Entity::find()
        .select_only()
        .expr_as(Func::min(next_available_at), "next_available_at")
        .filter(file_analysis_state::Column::DeviceId.eq(claim.device_id))
        .filter(file_analysis_state::Column::Pending.eq(true))
        .into_model::<RemainingAnalysisState>()
        .one(&transaction)
        .await?
        .ok_or_else(|| {
            DbErr::Custom(
                "file analysis availability aggregate returned no row"
                    .to_string(),
            )
        })?;
    let active_job = file_analysis_reanalysis_job::Entity::find()
        .filter(
            file_analysis_reanalysis_job::Column::DeviceId.eq(claim.device_id),
        )
        .filter(file_analysis_reanalysis_job::Column::ExpandedAt.is_null())
        .one(&transaction)
        .await?
        .is_some();
    let now = Utc::now().fixed_offset();
    let pending = remaining.next_available_at.is_some() || active_job;
    let mut device = device.into_active_model();
    device.pending = Set(pending);
    device.lease_token = Set(None);
    device.lease_expires_at = Set(None);
    device.available_at = Set(if active_job {
        now
    } else {
        remaining.next_available_at.unwrap_or(now)
    });
    device.updated_at = Set(now);
    device.update(&transaction).await?;
    transaction.commit().await?;
    Ok(Some(pending))
}

async fn load_reanalysis_scopes(
    transaction: &DatabaseTransaction,
    device_id: Option<Uuid>,
    target_rule_revision: i64,
) -> Result<Vec<ReanalysisDeviceScope>, DbErr> {
    let device_id_alias = Alias::new("device_id");
    let scheduled_file_count_alias = Alias::new("scheduled_file_count");
    let scope_alias = Alias::new("scope");
    let upper_file_alias = Alias::new("upper_file");

    let active_job = file_analysis_reanalysis_job::Entity::find()
        .select_only()
        .expr(Expr::value(1))
        .filter(file_analysis_reanalysis_job::Column::ExpandedAt.is_null())
        .filter(
            file_analysis_reanalysis_job::Column::TargetRuleRevision
                .eq(target_rule_revision),
        )
        .filter(
            Condition::any()
                .add(file_analysis_reanalysis_job::Column::DeviceId.is_null())
                .add(
                    Expr::col((
                        file_analysis_reanalysis_job::Entity,
                        file_analysis_reanalysis_job::Column::DeviceId,
                    ))
                    .eq(Expr::col((
                        file_analysis_state::Entity,
                        file_analysis_state::Column::DeviceId,
                    ))),
                ),
        )
        .into_query();

    let mut scope_query = Query::select();
    scope_query
        .expr_as(
            Expr::col((
                file_analysis_state::Entity,
                file_analysis_state::Column::DeviceId,
            )),
            device_id_alias.clone(),
        )
        .expr_as(
            Func::count(Expr::col((
                file_analysis_state::Entity,
                file_analysis_state::Column::DeviceId,
            ))),
            scheduled_file_count_alias.clone(),
        )
        .from(file_analysis_state::Entity)
        // Keep this as a boolean expression instead of binding `false` so a
        // generic prepared plan can use `file_analysis_state_device_analyzed_idx`.
        .and_where(
            Expr::col((
                file_analysis_state::Entity,
                file_analysis_state::Column::Pending,
            ))
            .not(),
        )
        .and_where(Expr::exists(active_job).not())
        .group_by_col((
            file_analysis_state::Entity,
            file_analysis_state::Column::DeviceId,
        ));
    if let Some(device_id) = device_id {
        scope_query.and_where(
            Expr::col((
                file_analysis_state::Entity,
                file_analysis_state::Column::DeviceId,
            ))
            .eq(device_id),
        );
    }

    // Count eligible states from the covering partial index, then capture the
    // current file boundary separately. Expansion keeps later files outside
    // the job and upgrades only states that are no longer pending.
    let upper_file_query = Query::select()
        .column((file_entry::Entity, file_entry::Column::Id))
        .from(file_entry::Entity)
        .and_where(
            Expr::col((file_entry::Entity, file_entry::Column::DeviceId))
                .eq(Expr::col((scope_alias.clone(), device_id_alias.clone()))),
        )
        .and_where(
            Expr::col((file_entry::Entity, file_entry::Column::Kind))
                .eq(FileEntryKind::File.to_value()),
        )
        .order_by((file_entry::Entity, file_entry::Column::Id), Order::Desc)
        .limit(1)
        .to_owned();
    let query = Query::select()
        .column((scope_alias.clone(), device_id_alias))
        .expr_as(
            Expr::col((upper_file_alias.clone(), file_entry::Column::Id)),
            Alias::new("upper_file_entry_id"),
        )
        .column((scope_alias.clone(), scheduled_file_count_alias))
        .from_subquery(scope_query.to_owned(), scope_alias)
        .join_lateral(
            JoinType::InnerJoin,
            upper_file_query,
            upper_file_alias,
            Expr::value(true),
        )
        .to_owned();

    ReanalysisDeviceScope::find_by_statement(
        transaction.get_database_backend().build(&query),
    )
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

fn retry_available_at_expr(now: DateTime<FixedOffset>) -> SimpleExpr {
    let mut available_at = Expr::case(
        Expr::col(file_analysis_state::Column::AttemptCount)
            .gte(DEVICE_FILE_ANALYSIS_MAX_ATTEMPTS),
        now,
    );
    for attempt_count in 1..DEVICE_FILE_ANALYSIS_MAX_ATTEMPTS {
        let exponent = u32::try_from(std::cmp::min(attempt_count - 1, 8))
            .expect("non-negative retry exponent");
        let delay = Duration::seconds(std::cmp::min(2_i64.pow(exponent), 300));
        available_at = available_at.case(
            Expr::col(file_analysis_state::Column::AttemptCount)
                .eq(attempt_count),
            now + delay,
        );
    }
    available_at.finally(now + Duration::seconds(1)).into()
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
