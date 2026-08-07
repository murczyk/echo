use crate::file_registry::entities::{
    file_analysis_control, file_analysis_reanalysis_job, file_analysis_state,
    file_entry, sea_orm_active_enums::FileEntryKind,
};
use chrono::{DateTime, FixedOffset, NaiveDateTime, Utc};
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
struct ReanalysisScope {
    upper_file_entry_id: Option<Uuid>,
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

pub(super) async fn expand_next_reanalysis_job(
    file_db: &DatabaseConnection,
    limit: u64,
) -> Result<bool, DbErr> {
    let transaction = file_db.begin().await?;
    let Some(_control) = file_analysis_control::Entity::find_by_id(true)
        .lock_with_behavior(LockType::Update, LockBehavior::SkipLocked)
        .one(&transaction)
        .await?
    else {
        transaction.commit().await?;
        return Ok(false);
    };
    let Some(job) = file_analysis_reanalysis_job::Entity::find()
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
        .all(&transaction)
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
            .exec_without_returning(&transaction)
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
            .exec(&transaction)
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
    job.update(&transaction).await?;
    transaction.commit().await?;
    Ok(true)
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

pub(super) async fn claim_pending_analysis_files(
    file_db: &DatabaseConnection,
    limit: u64,
) -> Result<ClaimedAnalysisBatch, DbErr> {
    let limit = i64::try_from(limit).map_err(|_| {
        DbErr::Custom("analysis batch size is too large".to_string())
    })?;
    let lease_token = Uuid::now_v7();
    let transaction = file_db.begin().await?;
    let files =
        ClaimedAnalysisFile::find_by_statement(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
            with candidates as materialized (
                select file_entry_id
                from file_analysis_state
                where pending
                  and lease_token is null
                  and available_at <= clock_timestamp()
                order by available_at, file_entry_id
                limit $1
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
                limit.into(),
                lease_token.into(),
                ANALYSIS_LEASE_SECONDS.into(),
            ],
        ))
        .all(&transaction)
        .await?;
    transaction.commit().await?;
    Ok(ClaimedAnalysisBatch { lease_token, files })
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

pub(super) async fn release_claim_with_error(
    file_db: &DatabaseConnection,
    lease_token: Uuid,
    error: &str,
) -> Result<u64, DbErr> {
    let error = truncate_last_error(error);
    file_db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
            update file_analysis_state
            set lease_token = null,
                lease_expires_at = null,
                available_at = clock_timestamp() + (
                    least(
                        300,
                        power(
                            2,
                            least(greatest(attempt_count - 1, 0), 8)
                        )::integer
                    )::double precision * interval '1 second'
                ),
                last_error = $2,
                updated_at = clock_timestamp()
            where lease_token = $1
            "#,
            [lease_token.into(), error.into()],
        ))
        .await
        .map(|result| result.rows_affected())
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

    let mut active_job = file_analysis_reanalysis_job::Entity::find()
        .filter(
            file_analysis_reanalysis_job::Column::TargetRuleRevision
                .eq(target_rule_revision),
        )
        .filter(file_analysis_reanalysis_job::Column::ExpandedAt.is_null());
    active_job = match device_id {
        Some(device_id) => active_job.filter(
            file_analysis_reanalysis_job::Column::DeviceId.eq(device_id),
        ),
        None => active_job
            .filter(file_analysis_reanalysis_job::Column::DeviceId.is_null()),
    };
    if active_job.one(&transaction).await?.is_some() {
        transaction.commit().await?;
        return Ok(0);
    }

    let scope_statement = match device_id {
        Some(device_id) => Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
            select
                (
                    select id
                    from file_entry
                    where kind = 'file'
                      and device_id = $1
                    order by id desc
                    limit 1
                ) as upper_file_entry_id,
                count(*)::bigint as scheduled_file_count
            from file_entry as entry
            join file_analysis_state as state
              on state.file_entry_id = entry.id
            where entry.kind = 'file'
              and entry.device_id = $1
              and not state.pending
              and not exists (
                  select 1
                  from file_analysis_reanalysis_job as active_job
                  where active_job.expanded_at is null
                    and active_job.target_rule_revision = $2
                    and active_job.upper_file_entry_id >= entry.id
                    and (
                        active_job.device_id is null
                        or active_job.device_id = entry.device_id
                    )
              )
            "#,
            [device_id.into(), target_rule_revision.into()],
        ),
        None => Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
            select
                (
                    select id
                    from file_entry
                    where kind = 'file'
                    order by id desc
                    limit 1
                ) as upper_file_entry_id,
                count(*)::bigint as scheduled_file_count
            from file_entry as entry
            join file_analysis_state as state
              on state.file_entry_id = entry.id
            where entry.kind = 'file'
              and not state.pending
              and not exists (
                  select 1
                  from file_analysis_reanalysis_job as active_job
                  where active_job.expanded_at is null
                    and active_job.target_rule_revision = $1
                    and active_job.upper_file_entry_id >= entry.id
                    and (
                        active_job.device_id is null
                        or active_job.device_id = entry.device_id
                    )
              )
            "#,
            [target_rule_revision.into()],
        ),
    };
    let scope = ReanalysisScope::find_by_statement(scope_statement)
        .one(&transaction)
        .await?
        .ok_or_else(|| {
            DbErr::Custom(
                "file analysis scope aggregate is missing".to_string(),
            )
        })?;
    if scope.scheduled_file_count == 0 {
        transaction.commit().await?;
        return Ok(0);
    }
    let upper_file_entry_id = scope.upper_file_entry_id.ok_or_else(|| {
        DbErr::Custom("non-empty analysis scope has no upper bound".to_string())
    })?;

    let generation = control.next_generation;
    let next_generation = generation.checked_add(1).ok_or_else(|| {
        DbErr::Custom("file analysis generation overflow".to_string())
    })?;
    let now = Utc::now().fixed_offset();
    let mut control = control.into_active_model();
    control.next_generation = Set(next_generation);
    control.updated_at = Set(now);
    control.update(&transaction).await?;

    file_analysis_reanalysis_job::ActiveModel {
        id: Set(Uuid::now_v7()),
        device_id: Set(device_id),
        target_rule_revision: Set(target_rule_revision),
        generation: Set(generation),
        upper_file_entry_id: Set(upper_file_entry_id),
        cursor_file_entry_id: Set(None),
        scheduled_file_count: Set(scope.scheduled_file_count),
        expanded_file_count: Set(0),
        expanded_at: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(&transaction)
    .await?;

    let scheduled_file_count =
        scope.scheduled_file_count.try_into().map_err(|_| {
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
