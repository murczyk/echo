use super::super::types::{
    ApplyFileSyncBatchRsp, BatchSummary, FileEntry, FileSyncBatchStatus,
    FileSyncErrorCode, FileSyncFieldError, FileSyncOperation, FileSyncResult,
    FileSyncSessionItemResult, FileSyncSessionItemsRsp, FileSyncSessionMode,
    FileSyncSessionRsp, FileSyncSessionStatus, NormalizedSourceFileState,
    RawSyncDeviceFileItem, SyncCounts, SyncDeviceFilesRsp, SyncSummary,
};
use super::super::{map_transaction_body_error, FilesystemError};
use super::prepare::prepare_items;
use super::{StartSessionResult, DEVICE_FILE_SYNC_SESSION_TTL_SECS};
use crate::config::{
    DEVICE_FILE_PAGE_DEFAULT_LIMIT, DEVICE_FILE_PAGE_MAX_LIMIT,
};
use crate::devices::analytics::{ensure_sync_run, hydrate_active_tags};
use crate::file_registry::entities::{
    file_analysis_run, file_entry, file_metadata_revision, file_sync_batch,
    file_sync_item, file_sync_session,
    sea_orm_active_enums::{
        FileSyncBatchStatus as DbBatchStatus,
        FileSyncItemOutcome as DbItemOutcome,
        FileSyncSessionMode as DbSessionMode,
        FileSyncSessionStatus as DbSessionStatus,
    },
};
use crate::h;
use crate::telemetry::Metrics;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{Duration, Utc};
use sea_orm::sea_query::{Expr, Func, SimpleExpr};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectionTrait,
    DatabaseConnection, DatabaseTransaction, EntityTrait, ExprTrait,
    FromQueryResult, IntoActiveModel, QueryFilter, QueryOrder, QuerySelect,
    TransactionTrait,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

const ACTIVE_SESSION_CODE: &str = "active_session";
const WRONG_NEXT_BATCH_CODE: &str = "wrong_next_batch";
const TERMINAL_SESSION_CODE: &str = "terminal_session";
const COMPLETE_MISMATCH_CODE: &str = "complete_mismatch";
const BATCH_PROCESSING_CODE: &str = "batch_processing";

#[derive(FromQueryResult)]
struct FinalizeBatchCounts {
    received_count: i64,
    accepted_count: i64,
    created_count: i64,
    updated_count: i64,
    rejected_count: i64,
    pending_count: i64,
}

fn item_count_expr() -> SimpleExpr {
    Func::count(Expr::col(file_sync_item::Column::ItemIndex)).into()
}

fn conditional_count_expr(condition: SimpleExpr) -> SimpleExpr {
    let count: SimpleExpr =
        Func::sum(Expr::case(condition, 1_i32).finally(0_i32)).into();
    Func::coalesce([count, Expr::val(0_i64)]).into()
}

#[derive(Debug)]
pub(super) enum SyncServiceError {
    Filesystem(FilesystemError),
    Conflict { code: &'static str, message: String },
}

impl From<FilesystemError> for SyncServiceError {
    fn from(error: FilesystemError) -> Self {
        Self::Filesystem(error)
    }
}

pub(super) async fn automatic(
    file_db: &DatabaseConnection,
    device_id: Uuid,
    files: Vec<RawSyncDeviceFileItem>,
    metrics: Option<&Metrics>,
) -> Result<SyncDeviceFilesRsp, SyncServiceError> {
    let transaction = begin_transaction(file_db).await?;
    if find_open_session(&transaction, device_id).await?.is_some() {
        return Err(conflict(
            ACTIVE_SESSION_CODE,
            "another sync session is active for this device",
        ));
    }
    let sync_id = Uuid::now_v7();
    let now = Utc::now().fixed_offset();
    match insert_session(
        &transaction,
        sync_id,
        device_id,
        DbSessionMode::Automatic,
        None,
        now,
    )
    .await
    {
        Ok(()) => {}
        Err(SyncServiceError::Filesystem(error))
            if is_unique_violation(&error) =>
        {
            return Err(conflict(
                ACTIVE_SESSION_CODE,
                "another sync session is active for this device",
            ));
        }
        Err(error) => return Err(error),
    }
    let batch =
        insert_batch_and_items(&transaction, sync_id, 0, files, now).await?;
    process_pending_items(&transaction, device_id, sync_id, 0, metrics).await?;
    let batch = finalize_batch(&transaction, batch).await?;
    let sync =
        finalize_automatic_session(&transaction, sync_id, &batch).await?;
    let analysis_run_id = ensure_sync_run(&transaction, sync_id, device_id)
        .await
        .map_err(map_database)?;
    transaction.commit().await.map_err(map_infrastructure)?;

    let results = load_results(file_db, sync_id, Some(0), None, None).await?;
    let results = hydrate_results(file_db, results)
        .await?
        .into_iter()
        .map(into_immediate_result)
        .collect();
    Ok(SyncDeviceFilesRsp {
        sync: map_session(sync, analysis_run_id),
        results,
    })
}

pub(super) async fn start_explicit(
    file_db: &DatabaseConnection,
    device_id: Uuid,
) -> Result<StartSessionResult, SyncServiceError> {
    let transaction = begin_transaction(file_db).await?;
    if let Some(existing) = find_open_session(&transaction, device_id).await? {
        if existing.mode != DbSessionMode::Explicit {
            return Err(conflict(
                ACTIVE_SESSION_CODE,
                "an automatic sync is active for this device",
            ));
        }
        transaction.commit().await.map_err(map_infrastructure)?;
        return Ok(StartSessionResult {
            response: FileSyncSessionRsp {
                sync: map_session(existing, None),
            },
            created: false,
        });
    }

    let now = Utc::now().fixed_offset();
    let sync_id = Uuid::now_v7();
    let expires_at = now + Duration::seconds(DEVICE_FILE_SYNC_SESSION_TTL_SECS);
    match insert_session(
        &transaction,
        sync_id,
        device_id,
        DbSessionMode::Explicit,
        Some(expires_at),
        now,
    )
    .await
    {
        Ok(()) => {}
        Err(SyncServiceError::Filesystem(error))
            if is_unique_violation(&error) =>
        {
            transaction.rollback().await.map_err(map_database)?;
            let existing = find_open_session(file_db, device_id)
                .await?
                .ok_or_else(|| {
                    conflict(
                        ACTIVE_SESSION_CODE,
                        "another sync session claimed this device",
                    )
                })?;
            if existing.mode != DbSessionMode::Explicit {
                return Err(conflict(
                    ACTIVE_SESSION_CODE,
                    "an automatic sync is active for this device",
                ));
            }
            return Ok(StartSessionResult {
                response: FileSyncSessionRsp {
                    sync: map_session(existing, None),
                },
                created: false,
            });
        }
        Err(error) => return Err(error),
    }
    transaction.commit().await.map_err(map_infrastructure)?;
    let session = load_session(file_db, sync_id).await?;
    Ok(StartSessionResult {
        response: FileSyncSessionRsp {
            sync: map_session(session, None),
        },
        created: true,
    })
}

pub(super) async fn status(
    file_db: &DatabaseConnection,
    sync_id: Uuid,
) -> Result<FileSyncSessionRsp, SyncServiceError> {
    let session = load_session(file_db, sync_id).await?;
    let analysis_run_id = load_analysis_run_id(file_db, sync_id).await?;
    Ok(FileSyncSessionRsp {
        sync: map_session(session, analysis_run_id),
    })
}

pub(super) async fn apply_batch(
    file_db: &DatabaseConnection,
    sync_id: Uuid,
    batch_index: i32,
    files: Vec<RawSyncDeviceFileItem>,
    metrics: Option<&Metrics>,
) -> Result<ApplyFileSyncBatchRsp, SyncServiceError> {
    let transaction = begin_transaction(file_db).await?;
    let session = lock_session(&transaction, sync_id).await?;
    ensure_open_explicit(&session)?;
    if file_sync_batch::Entity::find_by_id((sync_id, batch_index))
        .one(&transaction)
        .await
        .map_err(map_database)?
        .is_none()
    {
        super::super::validation::validate_sync_batch_size(files.len())?;
        if batch_index != session.next_batch_index {
            return Err(conflict(
                WRONG_NEXT_BATCH_CODE,
                format!(
                    "expected batch {}, received {batch_index}",
                    session.next_batch_index
                ),
            ));
        }
        insert_batch_and_items(
            &transaction,
            sync_id,
            batch_index,
            files,
            Utc::now().fixed_offset(),
        )
        .await?;
    }
    transaction.commit().await.map_err(map_infrastructure)?;

    process_explicit_items(file_db, sync_id, batch_index, metrics).await?;
    let (sync, batch) =
        finalize_explicit_batch(file_db, sync_id, batch_index).await?;

    let results =
        load_results(file_db, sync_id, Some(batch_index), None, None).await?;
    let results = hydrate_results(file_db, results)
        .await?
        .into_iter()
        .map(into_immediate_result)
        .collect();
    Ok(ApplyFileSyncBatchRsp {
        sync: map_session(sync, None),
        batch: map_batch(batch),
        results,
    })
}

pub(super) async fn complete(
    file_db: &DatabaseConnection,
    sync_id: Uuid,
    expected_batch_count: i32,
) -> Result<FileSyncSessionRsp, SyncServiceError> {
    let transaction = begin_transaction(file_db).await?;
    let session = lock_session(&transaction, sync_id).await?;
    if session.status != DbSessionStatus::Open {
        if matches!(
            session.status,
            DbSessionStatus::Completed | DbSessionStatus::CompletedWithErrors
        ) && session.next_batch_index == expected_batch_count
        {
            let analysis_run_id =
                ensure_sync_run(&transaction, sync_id, session.device_id)
                    .await
                    .map_err(map_database)?;
            transaction.commit().await.map_err(map_infrastructure)?;
            return Ok(FileSyncSessionRsp {
                sync: map_session(session, analysis_run_id),
            });
        }
        return Err(conflict(
            if matches!(
                session.status,
                DbSessionStatus::Completed
                    | DbSessionStatus::CompletedWithErrors
            ) {
                COMPLETE_MISMATCH_CODE
            } else {
                TERMINAL_SESSION_CODE
            },
            "the session cannot be completed with this batch count",
        ));
    }
    if session.mode != DbSessionMode::Explicit {
        return Err(conflict(
            TERMINAL_SESSION_CODE,
            "automatic sessions cannot be completed explicitly",
        ));
    }
    if session.next_batch_index != expected_batch_count {
        return Err(conflict(
            COMPLETE_MISMATCH_CODE,
            format!(
                "expected {} finalized batches, received {expected_batch_count}",
                session.next_batch_index
            ),
        ));
    }
    let processing = file_sync_batch::Entity::find()
        .filter(file_sync_batch::Column::Id.eq(sync_id))
        .filter(file_sync_batch::Column::Status.eq(DbBatchStatus::Processing))
        .one(&transaction)
        .await
        .map_err(map_database)?
        .is_some();
    if processing {
        return Err(conflict(
            BATCH_PROCESSING_CODE,
            "the session has a processing batch",
        ));
    }

    let now = Utc::now().fixed_offset();
    let mut session = session.into_active_model();
    session.status = Set(if session.rejected_count.as_ref() == &0 {
        DbSessionStatus::Completed
    } else {
        DbSessionStatus::CompletedWithErrors
    });
    session.updated_at = Set(now);
    session.completed_at = Set(Some(now));
    session.expires_at = Set(None);
    let session = session.update(&transaction).await.map_err(map_database)?;
    let analysis_run_id =
        ensure_sync_run(&transaction, sync_id, session.device_id)
            .await
            .map_err(map_database)?;
    transaction.commit().await.map_err(map_infrastructure)?;
    Ok(FileSyncSessionRsp {
        sync: map_session(session, analysis_run_id),
    })
}

pub(super) async fn items(
    file_db: &DatabaseConnection,
    sync_id: Uuid,
    outcome: Option<DbItemOutcome>,
    limit: Option<u64>,
    cursor: Option<&str>,
) -> Result<FileSyncSessionItemsRsp, SyncServiceError> {
    let session = load_session(file_db, sync_id).await?;
    let analysis_run_id = load_analysis_run_id(file_db, sync_id).await?;
    let limit = limit.unwrap_or(DEVICE_FILE_PAGE_DEFAULT_LIMIT);
    if !(1..=DEVICE_FILE_PAGE_MAX_LIMIT).contains(&limit) {
        return Err(SyncServiceError::Filesystem(FilesystemError::Validation(
            vec![super::super::FilesystemFieldError {
                path: "limit".to_string(),
                message: format!(
                    "must be between 1 and {DEVICE_FILE_PAGE_MAX_LIMIT}"
                ),
            }],
        )));
    }
    let boundary = cursor.map(decode_cursor).transpose()?;
    let mut results =
        load_results(file_db, sync_id, None, outcome, boundary).await?;
    let has_more = results.len() > limit as usize;
    results.truncate(limit as usize);
    let next_cursor = has_more
        .then(|| results.last().map(result_cursor))
        .flatten()
        .map(encode_cursor);
    let results = hydrate_results(file_db, results).await?;
    Ok(FileSyncSessionItemsRsp {
        sync: map_session(session, analysis_run_id),
        results,
        next_cursor,
    })
}

async fn process_explicit_items(
    file_db: &DatabaseConnection,
    sync_id: Uuid,
    batch_index: i32,
    metrics: Option<&Metrics>,
) -> Result<(), SyncServiceError> {
    let transaction = begin_transaction(file_db).await?;
    let session = lock_session(&transaction, sync_id).await?;
    ensure_open_explicit(&session)?;
    let batch = load_batch(&transaction, sync_id, batch_index).await?;
    if batch.status == DbBatchStatus::Processing {
        process_pending_items(
            &transaction,
            session.device_id,
            sync_id,
            batch_index,
            metrics,
        )
        .await?;
    }
    transaction.commit().await.map_err(map_infrastructure)
}

async fn process_pending_items(
    transaction: &DatabaseTransaction,
    device_id: Uuid,
    sync_id: Uuid,
    batch_index: i32,
    metrics: Option<&Metrics>,
) -> Result<(), SyncServiceError> {
    let pending = file_sync_item::Entity::find()
        .filter(file_sync_item::Column::Id.eq(sync_id))
        .filter(file_sync_item::Column::BatchIndex.eq(batch_index))
        .filter(file_sync_item::Column::Outcome.is_null())
        .order_by_asc(file_sync_item::Column::ItemIndex)
        .lock_exclusive()
        .all(transaction)
        .await
        .map_err(map_database)?;
    super::mutation::apply_sync_items(transaction, device_id, pending, metrics)
        .await?;
    Ok(())
}

async fn insert_session<C: ConnectionTrait>(
    db: &C,
    sync_id: Uuid,
    device_id: Uuid,
    mode: DbSessionMode,
    expires_at: Option<chrono::DateTime<chrono::FixedOffset>>,
    now: chrono::DateTime<chrono::FixedOffset>,
) -> Result<(), SyncServiceError> {
    file_sync_session::ActiveModel {
        id: Set(sync_id),
        device_id: Set(device_id),
        mode: Set(mode),
        status: Set(DbSessionStatus::Open),
        next_batch_index: Set(0),
        received_count: Set(0),
        accepted_count: Set(0),
        created_count: Set(0),
        updated_count: Set(0),
        rejected_count: Set(0),
        created_at: Set(now),
        updated_at: Set(now),
        completed_at: Set(None),
        expires_at: Set(expires_at),
    }
    .insert(db)
    .await
    .map_err(map_database)?;
    Ok(())
}

async fn insert_batch_and_items(
    transaction: &DatabaseTransaction,
    sync_id: Uuid,
    batch_index: i32,
    files: Vec<RawSyncDeviceFileItem>,
    now: chrono::DateTime<chrono::FixedOffset>,
) -> Result<file_sync_batch::Model, SyncServiceError> {
    let batch = file_sync_batch::ActiveModel {
        id: Set(sync_id),
        batch_index: Set(batch_index),
        status: Set(DbBatchStatus::Processing),
        received_count: Set(0),
        accepted_count: Set(0),
        created_count: Set(0),
        updated_count: Set(0),
        rejected_count: Set(0),
        created_at: Set(now),
        applied_at: Set(None),
    }
    .insert(transaction)
    .await
    .map_err(map_database)?;
    let items = prepare_items(sync_id, batch_index, files, now)?;
    if !items.is_empty() {
        file_sync_item::Entity::insert_many(items)
            .exec(transaction)
            .await
            .map_err(map_database)?;
    }
    Ok(batch)
}

async fn finalize_explicit_batch(
    file_db: &DatabaseConnection,
    sync_id: Uuid,
    batch_index: i32,
) -> Result<(file_sync_session::Model, file_sync_batch::Model), SyncServiceError>
{
    let transaction = begin_transaction(file_db).await?;
    let session = lock_session(&transaction, sync_id).await?;
    ensure_open_explicit(&session)?;
    let batch = file_sync_batch::Entity::find_by_id((sync_id, batch_index))
        .lock_exclusive()
        .one(&transaction)
        .await
        .map_err(map_database)?
        .ok_or_else(|| {
            SyncServiceError::Filesystem(FilesystemError::NotFound)
        })?;
    if batch.status != DbBatchStatus::Processing {
        transaction.commit().await.map_err(map_infrastructure)?;
        return Ok((session, batch));
    }
    if session.next_batch_index != batch_index {
        return Err(conflict(
            WRONG_NEXT_BATCH_CODE,
            "the processing batch is no longer the next batch",
        ));
    }

    let batch = finalize_batch(&transaction, batch).await?;
    let mut session = session.into_active_model();
    session.next_batch_index = Set(batch_index + 1);
    session.received_count =
        Set(session.received_count.as_ref() + batch.received_count);
    session.accepted_count =
        Set(session.accepted_count.as_ref() + batch.accepted_count);
    session.created_count =
        Set(session.created_count.as_ref() + batch.created_count);
    session.updated_count =
        Set(session.updated_count.as_ref() + batch.updated_count);
    session.rejected_count =
        Set(session.rejected_count.as_ref() + batch.rejected_count);
    session.updated_at = Set(Utc::now().fixed_offset());
    let session = session.update(&transaction).await.map_err(map_database)?;
    transaction.commit().await.map_err(map_infrastructure)?;
    Ok((session, batch))
}

async fn finalize_batch(
    transaction: &DatabaseTransaction,
    batch: file_sync_batch::Model,
) -> Result<file_sync_batch::Model, SyncServiceError> {
    if batch.status != DbBatchStatus::Processing {
        return Err(
            FilesystemError::Invariant("sync_batch_not_processing").into()
        );
    }
    let counts = file_sync_item::Entity::find()
        .select_only()
        .column_as(item_count_expr(), "received_count")
        .column_as(
            conditional_count_expr(
                file_sync_item::Column::Outcome
                    .is_in([DbItemOutcome::Created, DbItemOutcome::Updated]),
            ),
            "accepted_count",
        )
        .column_as(
            conditional_count_expr(
                file_sync_item::Column::Outcome.eq(DbItemOutcome::Created),
            ),
            "created_count",
        )
        .column_as(
            conditional_count_expr(
                file_sync_item::Column::Outcome.eq(DbItemOutcome::Updated),
            ),
            "updated_count",
        )
        .column_as(
            conditional_count_expr(
                file_sync_item::Column::Outcome.eq(DbItemOutcome::Rejected),
            ),
            "rejected_count",
        )
        .column_as(
            conditional_count_expr(file_sync_item::Column::Outcome.is_null()),
            "pending_count",
        )
        .filter(file_sync_item::Column::Id.eq(batch.id))
        .filter(file_sync_item::Column::BatchIndex.eq(batch.batch_index))
        .into_model::<FinalizeBatchCounts>()
        .one(transaction)
        .await
        .map_err(map_database)?
        .ok_or(FilesystemError::Invariant("sync_batch_counts_missing"))?;
    if counts.pending_count != 0 {
        return Err(conflict(
            BATCH_PROCESSING_CODE,
            "the batch still has pending items",
        ));
    }

    let mut batch = batch.into_active_model();
    batch.status = Set(if counts.rejected_count == 0 {
        DbBatchStatus::Applied
    } else {
        DbBatchStatus::AppliedWithErrors
    });
    batch.received_count = Set(counts.received_count);
    batch.accepted_count = Set(counts.accepted_count);
    batch.created_count = Set(counts.created_count);
    batch.updated_count = Set(counts.updated_count);
    batch.rejected_count = Set(counts.rejected_count);
    batch.applied_at = Set(Some(Utc::now().fixed_offset()));
    batch.update(transaction).await.map_err(map_database)
}

async fn finalize_automatic_session(
    transaction: &DatabaseTransaction,
    sync_id: Uuid,
    batch: &file_sync_batch::Model,
) -> Result<file_sync_session::Model, SyncServiceError> {
    if batch.id != sync_id || batch.batch_index != 0 {
        return Err(FilesystemError::Invariant(
            "automatic_sync_batch_mismatch",
        )
        .into());
    }
    let now = Utc::now().fixed_offset();
    let mut session = lock_session(transaction, sync_id)
        .await?
        .into_active_model();
    session.next_batch_index = Set(1);
    session.received_count = Set(batch.received_count);
    session.accepted_count = Set(batch.accepted_count);
    session.created_count = Set(batch.created_count);
    session.updated_count = Set(batch.updated_count);
    session.rejected_count = Set(batch.rejected_count);
    session.status = Set(if batch.rejected_count == 0 {
        DbSessionStatus::Completed
    } else {
        DbSessionStatus::CompletedWithErrors
    });
    session.updated_at = Set(now);
    session.completed_at = Set(Some(now));
    session.update(transaction).await.map_err(map_database)
}

async fn load_results<C: ConnectionTrait>(
    db: &C,
    sync_id: Uuid,
    batch_index: Option<i32>,
    outcome: Option<DbItemOutcome>,
    boundary: Option<ResultCursor>,
) -> Result<Vec<RawResult>, SyncServiceError> {
    let mut query = file_sync_item::Entity::find()
        .filter(file_sync_item::Column::Id.eq(sync_id))
        .filter(file_sync_item::Column::Outcome.is_not_null());
    if let Some(batch_index) = batch_index {
        query =
            query.filter(file_sync_item::Column::BatchIndex.eq(batch_index));
    }
    if let Some(outcome) = outcome {
        query = query.filter(file_sync_item::Column::Outcome.eq(outcome));
    }
    if let Some(boundary) = boundary {
        query = query.filter(
            file_sync_item::Column::BatchIndex
                .gt(boundary.batch_index)
                .or(file_sync_item::Column::BatchIndex
                    .eq(boundary.batch_index)
                    .and(
                        file_sync_item::Column::ItemIndex
                            .gt(boundary.item_index),
                    )),
        );
    }
    let mut query = query
        .order_by_asc(file_sync_item::Column::BatchIndex)
        .order_by_asc(file_sync_item::Column::ItemIndex);
    if batch_index.is_none() {
        query = query.limit(DEVICE_FILE_PAGE_MAX_LIMIT + 1);
    }
    let items = query.all(db).await.map_err(map_database)?;
    Ok(items.into_iter().map(RawResult).collect())
}

struct RawResult(file_sync_item::Model);

async fn hydrate_results(
    file_db: &DatabaseConnection,
    results: Vec<RawResult>,
) -> Result<Vec<FileSyncSessionItemResult>, SyncServiceError> {
    let mut file_ids = results
        .iter()
        .filter_map(|result| result.0.file_id)
        .collect::<Vec<_>>();
    file_ids.sort_unstable();
    file_ids.dedup();
    let files = if file_ids.is_empty() {
        Vec::new()
    } else {
        file_entry::Entity::find()
            .filter(file_entry::Column::Id.is_in(file_ids.clone()))
            .all(file_db)
            .await
            .map_err(map_database)?
    };
    let files = files
        .into_iter()
        .map(|file| (file.id, file))
        .collect::<BTreeMap<_, _>>();
    let mut revision_keys = results
        .iter()
        .filter_map(|result| result.0.file_id.zip(result.0.revision))
        .collect::<Vec<_>>();
    revision_keys.sort_unstable();
    revision_keys.dedup();
    let revisions = if revision_keys.is_empty() {
        Vec::new()
    } else {
        file_metadata_revision::Entity::find()
            .filter(
                Expr::tuple([
                    Expr::col(file_metadata_revision::Column::Id),
                    Expr::col(file_metadata_revision::Column::Revision),
                ])
                .in_tuples(revision_keys),
            )
            .order_by_asc(file_metadata_revision::Column::Id)
            .order_by_asc(file_metadata_revision::Column::Revision)
            .all(file_db)
            .await
            .map_err(map_database)?
    };
    let revisions = revisions
        .into_iter()
        .map(|revision| ((revision.id, revision.revision), revision))
        .collect::<BTreeMap<_, _>>();
    let mut tags =
        hydrate_active_tags(file_db, &file_ids)
            .await
            .map_err(|error| {
                SyncServiceError::Filesystem(FilesystemError::Internal(
                    anyhow::Error::new(error).context(h!()),
                ))
            })?;

    results
        .into_iter()
        .map(|result| match result.0.outcome {
            Some(DbItemOutcome::Created | DbItemOutcome::Updated) => {
                let item = result.0;
                let file_id =
                    item.file_id.ok_or(FilesystemError::Invariant(
                        "accepted_sync_item_file_missing",
                    ))?;
                let revision_number =
                    item.revision.ok_or(FilesystemError::Invariant(
                        "accepted_sync_item_revision_missing",
                    ))?;
                let root_id =
                    item.root_id.ok_or(FilesystemError::Invariant(
                        "accepted_sync_item_root_missing",
                    ))?;
                let current = files.get(&file_id).ok_or(
                    FilesystemError::Invariant("accepted_sync_file_missing"),
                )?;
                let revision = revisions
                    .get(&(file_id, revision_number))
                    .ok_or(FilesystemError::Invariant(
                        "accepted_sync_revision_missing",
                    ))?;
                let file = file_from_revision(current, revision)?;
                let path_components = super::super::parse_source_path(
                    revision.absolute_path.clone(),
                    "absolute_path",
                )?
                .components;
                let operation = if item.outcome == Some(DbItemOutcome::Created)
                {
                    FileSyncOperation::Created
                } else {
                    FileSyncOperation::Updated
                };
                Ok(FileSyncSessionItemResult::SessionItemAccepted {
                    batch_index: item.batch_index as u64,
                    item_index: item.item_index as u64,
                    operation,
                    file_id: file_id.hyphenated().to_string(),
                    revision: revision_number,
                    file: super::super::bl::map_file(
                        file,
                        root_id,
                        path_components,
                        tags.remove(&file_id).unwrap_or_default(),
                    ),
                })
            }
            Some(DbItemOutcome::Rejected) => {
                let item = result.0;
                let field_errors = serde_json::from_value::<
                    Vec<FileSyncFieldError>,
                >(item.field_errors)
                .map_err(|error| {
                    SyncServiceError::Filesystem(FilesystemError::Internal(
                        anyhow::Error::new(error).context(h!()),
                    ))
                })?;
                Ok(FileSyncSessionItemResult::SessionItemRejected {
                    batch_index: item.batch_index as u64,
                    item_index: item.item_index as u64,
                    code: match item.error_code.as_deref() {
                        Some("validation") => FileSyncErrorCode::Validation,
                        Some("duplicate_path_in_session") => {
                            FileSyncErrorCode::DuplicatePathInSession
                        }
                        _ => {
                            return Err(SyncServiceError::Filesystem(
                                FilesystemError::Invariant(
                                    "unknown_sync_item_error_code",
                                ),
                            ));
                        }
                    },
                    message: item.error_message.ok_or(
                        FilesystemError::Invariant(
                            "rejected_sync_item_message_missing",
                        ),
                    )?,
                    field_errors,
                })
            }
            None => Err(SyncServiceError::Filesystem(
                FilesystemError::Invariant("pending_sync_item_in_results"),
            )),
        })
        .collect()
}

fn into_immediate_result(result: FileSyncSessionItemResult) -> FileSyncResult {
    match result {
        FileSyncSessionItemResult::SessionItemAccepted {
            item_index,
            operation,
            file_id,
            revision,
            file,
            ..
        } => FileSyncResult::Accepted {
            index: item_index,
            operation,
            file_id,
            revision,
            file,
        },
        FileSyncSessionItemResult::SessionItemRejected {
            item_index,
            code,
            message,
            field_errors,
            ..
        } => FileSyncResult::Rejected {
            index: item_index,
            code,
            message,
            field_errors,
        },
    }
}

fn file_from_revision(
    current: &file_entry::Model,
    revision: &file_metadata_revision::Model,
) -> Result<FileEntry, SyncServiceError> {
    let parent_entry_id = current
        .parent_id
        .ok_or(FilesystemError::Invariant("file_parent_missing"))?;
    let source_file_state = match (
        revision.source_file_state.clone(),
        revision.source_file_state_settled_at,
        revision.source_file_state_settled_by.clone(),
    ) {
        (None, None, None) => None,
        (Some(state), Some(settled_at), Some(settled_by)) => {
            Some(NormalizedSourceFileState {
                state,
                settled_at,
                settled_by,
            })
        }
        _ => {
            return Err(SyncServiceError::Filesystem(
                FilesystemError::Invariant(
                    "file_revision_source_state_incomplete",
                ),
            ));
        }
    };
    Ok(FileEntry {
        file_id: revision.id,
        device_id: revision.device_id,
        parent_entry_id,
        name: revision.name.clone(),
        absolute_path: revision.absolute_path.clone(),
        hierarchy_path: current.hierarchy_path.clone(),
        has_content: current.content_path.is_some(),
        mime_type: revision.mime_type.clone(),
        extension: revision.extension.clone(),
        file_metadata_created_at: revision
            .file_metadata_created_at
            .map(|value| value.with_timezone(&Utc).naive_utc()),
        file_metadata_modified_at: revision
            .file_metadata_modified_at
            .map(|value| value.with_timezone(&Utc).naive_utc()),
        created_at: current.created_at,
        updated_at: revision.created_at.with_timezone(&Utc).naive_utc(),
        revision: revision.revision,
        sync_id: revision.sync_id,
        source_file_state,
    })
}

async fn load_session<C: ConnectionTrait>(
    db: &C,
    sync_id: Uuid,
) -> Result<file_sync_session::Model, SyncServiceError> {
    file_sync_session::Entity::find_by_id(sync_id)
        .one(db)
        .await
        .map_err(map_database)?
        .ok_or_else(|| SyncServiceError::Filesystem(FilesystemError::NotFound))
}

async fn load_analysis_run_id<C: ConnectionTrait>(
    db: &C,
    sync_id: Uuid,
) -> Result<Option<Uuid>, SyncServiceError> {
    file_analysis_run::Entity::find()
        .select_only()
        .column(file_analysis_run::Column::Id)
        .filter(file_analysis_run::Column::SyncId.eq(sync_id))
        .into_tuple::<Uuid>()
        .one(db)
        .await
        .map_err(map_database)
}

async fn lock_session(
    transaction: &DatabaseTransaction,
    sync_id: Uuid,
) -> Result<file_sync_session::Model, SyncServiceError> {
    file_sync_session::Entity::find_by_id(sync_id)
        .lock_exclusive()
        .one(transaction)
        .await
        .map_err(map_database)?
        .ok_or_else(|| SyncServiceError::Filesystem(FilesystemError::NotFound))
}

async fn find_open_session<C: ConnectionTrait>(
    db: &C,
    device_id: Uuid,
) -> Result<Option<file_sync_session::Model>, SyncServiceError> {
    file_sync_session::Entity::find()
        .filter(file_sync_session::Column::DeviceId.eq(device_id))
        .filter(file_sync_session::Column::Status.eq(DbSessionStatus::Open))
        .one(db)
        .await
        .map_err(map_database)
}

async fn load_batch<C: ConnectionTrait>(
    db: &C,
    sync_id: Uuid,
    batch_index: i32,
) -> Result<file_sync_batch::Model, SyncServiceError> {
    file_sync_batch::Entity::find_by_id((sync_id, batch_index))
        .one(db)
        .await
        .map_err(map_database)?
        .ok_or_else(|| SyncServiceError::Filesystem(FilesystemError::NotFound))
}

fn ensure_open_explicit(
    session: &file_sync_session::Model,
) -> Result<(), SyncServiceError> {
    if session.mode != DbSessionMode::Explicit
        || session.status != DbSessionStatus::Open
    {
        return Err(conflict(
            TERMINAL_SESSION_CODE,
            "the session is not an open explicit session",
        ));
    }
    Ok(())
}

fn map_session(
    session: file_sync_session::Model,
    analysis_run_id: Option<Uuid>,
) -> SyncSummary {
    SyncSummary {
        sync_id: session.id.hyphenated().to_string(),
        device_id: session.device_id.hyphenated().to_string(),
        mode: match session.mode {
            DbSessionMode::Automatic => FileSyncSessionMode::Automatic,
            DbSessionMode::Explicit => FileSyncSessionMode::Explicit,
        },
        status: match session.status {
            DbSessionStatus::Open => FileSyncSessionStatus::SyncOpen,
            DbSessionStatus::Completed => FileSyncSessionStatus::Completed,
            DbSessionStatus::CompletedWithErrors => {
                FileSyncSessionStatus::CompletedWithErrors
            }
            DbSessionStatus::Expired => FileSyncSessionStatus::Expired,
        },
        analysis_run_id: analysis_run_id.map(|id| id.to_string()),
        next_batch_index: session.next_batch_index as u64,
        counts: SyncCounts {
            received: session.received_count as u64,
            accepted: session.accepted_count as u64,
            created: session.created_count as u64,
            updated: session.updated_count as u64,
            rejected: session.rejected_count as u64,
        },
        created_at: format_timestamp(session.created_at),
        updated_at: format_timestamp(session.updated_at),
        completed_at: session.completed_at.map(format_timestamp),
        expires_at: session.expires_at.map(format_timestamp),
    }
}

fn map_batch(batch: file_sync_batch::Model) -> BatchSummary {
    BatchSummary {
        sync_id: batch.id.hyphenated().to_string(),
        batch_index: batch.batch_index as u64,
        status: match batch.status {
            DbBatchStatus::Processing => FileSyncBatchStatus::Processing,
            DbBatchStatus::Applied => FileSyncBatchStatus::Applied,
            DbBatchStatus::AppliedWithErrors => {
                FileSyncBatchStatus::AppliedWithErrors
            }
        },
        counts: SyncCounts {
            received: batch.received_count as u64,
            accepted: batch.accepted_count as u64,
            created: batch.created_count as u64,
            updated: batch.updated_count as u64,
            rejected: batch.rejected_count as u64,
        },
        created_at: format_timestamp(batch.created_at),
        applied_at: batch.applied_at.map(format_timestamp),
    }
}

fn format_timestamp(value: chrono::DateTime<chrono::FixedOffset>) -> String {
    value
        .with_timezone(&Utc)
        .to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true)
}

async fn begin_transaction(
    file_db: &DatabaseConnection,
) -> Result<DatabaseTransaction, SyncServiceError> {
    file_db.begin().await.map_err(map_database)
}

fn map_database(error: sea_orm::DbErr) -> SyncServiceError {
    SyncServiceError::Filesystem(map_transaction_body_error(
        anyhow::Error::new(error).context(h!()),
    ))
}

fn map_infrastructure(error: sea_orm::DbErr) -> SyncServiceError {
    SyncServiceError::Filesystem(FilesystemError::CommitUncertain(
        anyhow::Error::new(error).context(h!()),
    ))
}

fn conflict(
    code: &'static str,
    message: impl Into<String>,
) -> SyncServiceError {
    SyncServiceError::Conflict {
        code,
        message: message.into(),
    }
}

fn is_unique_violation(error: &FilesystemError) -> bool {
    match error {
        FilesystemError::Internal(error)
        | FilesystemError::Dependency(error)
        | FilesystemError::CommitUncertain(error) => {
            error.chain().any(|source| {
                source
                    .downcast_ref::<sqlx::Error>()
                    .and_then(|error| error.as_database_error())
                    .and_then(|error| error.code())
                    .as_deref()
                    == Some("23505")
            })
        }
        _ => false,
    }
}

#[derive(Clone, Copy, Serialize, Deserialize)]
struct ResultCursor {
    batch_index: i32,
    item_index: i32,
}

fn result_cursor(result: &RawResult) -> ResultCursor {
    ResultCursor {
        batch_index: result.0.batch_index,
        item_index: result.0.item_index,
    }
}

fn encode_cursor(cursor: ResultCursor) -> String {
    URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&cursor)
            .expect("file sync result cursor serializes"),
    )
}

fn decode_cursor(cursor: &str) -> Result<ResultCursor, SyncServiceError> {
    let bytes = URL_SAFE_NO_PAD.decode(cursor).map_err(|_| {
        SyncServiceError::Filesystem(FilesystemError::invalid_cursor())
    })?;
    serde_json::from_slice(&bytes).map_err(|_| {
        SyncServiceError::Filesystem(FilesystemError::invalid_cursor())
    })
}
