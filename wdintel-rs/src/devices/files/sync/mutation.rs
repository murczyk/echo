use super::super::{
    ltree::child_hierarchy_path, map_transaction_body_error,
    normalize_file_metadata, parse_source_path, DomainFileEntryKind,
    DomainSourceFileStateKind, FilesystemError, NormalizedSourceFileState,
    PreparedFileMutation,
};
use super::hierarchy::{
    resolve_new_file_hierarchies, root_entry_id, ResolvedNewFileHierarchy,
};
use crate::devices::analytics::{rules, types::FileAnalysisInput};
use crate::file_registry::entities::{
    file_device_source_state, file_entry, file_sync_item,
    sea_orm_active_enums::FileSyncItemOutcome as DbItemOutcome,
};
use crate::h;
use crate::telemetry::{FileAnalysisDbOperation, Metrics};
use chrono::{DateTime, FixedOffset, NaiveDateTime, Utc};
use sea_orm::sea_query::{Expr, LockType, OnConflict, SimpleExpr};
use sea_orm::{
    ActiveEnum, ActiveModelTrait, ActiveValue::Set, ColumnTrait,
    ConnectionTrait, DatabaseTransaction, DbBackend, EntityTrait, ExprTrait,
    IntoActiveModel, QueryFilter, QueryOrder, QuerySelect, Statement,
};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    time::Instant,
};
use uuid::Uuid;

// SeaORM cannot express a data-modifying CTE whose returned rows feed the
// immutable revision and sync-item writes. Keep that atomic set-based boundary.
const APPLY_SYNC_ITEMS_SQL: &str = r#"
    with accepted_input as materialized (
        select *
        from jsonb_to_recordset($1::jsonb) as accepted(
            sync_id uuid,
            batch_index integer,
            item_index integer,
            candidate_file_id uuid,
            device_id uuid,
            root_id uuid,
            parent_id uuid,
            name text,
            absolute_path text,
            hierarchy_path text,
            mime_type text,
            extension text,
            file_metadata_created_at timestamp without time zone,
            file_metadata_modified_at timestamp without time zone,
            created_at timestamp without time zone,
            updated_at timestamp without time zone,
            source_file_state text,
            source_file_state_settled_at timestamp with time zone,
            source_file_state_settled_by text,
            source_sequence bigint,
            analysis_input_revision bigint
        )
    ),
    mutated_files as (
        insert into file_entry as current (
            id,
            device_id,
            parent_id,
            kind,
            name,
            absolute_path,
            hierarchy_path,
            mime_type,
            extension,
            file_metadata_created_at,
            file_metadata_modified_at,
            created_at,
            updated_at,
            content_path,
            revision,
            sync_id,
            analysis_input_revision,
            current_analysis_run_id,
            source_file_state,
            source_file_state_settled_at,
            source_file_state_settled_by
        )
        select
            accepted.candidate_file_id,
            accepted.device_id,
            accepted.parent_id,
            'file'::public.file_entry_kind,
            accepted.name,
            accepted.absolute_path,
            accepted.hierarchy_path::public.ltree,
            accepted.mime_type,
            accepted.extension,
            accepted.file_metadata_created_at,
            accepted.file_metadata_modified_at,
            accepted.created_at,
            accepted.updated_at,
            null,
            1,
            accepted.sync_id,
            accepted.analysis_input_revision,
            null,
            accepted.source_file_state::public.source_file_state_kind,
            accepted.source_file_state_settled_at,
            accepted.source_file_state_settled_by
        from accepted_input as accepted
        on conflict (device_id, absolute_path)
            where kind = 'file'::public.file_entry_kind
        do update
        set name = excluded.name,
            absolute_path = excluded.absolute_path,
            mime_type = excluded.mime_type,
            extension = excluded.extension,
            file_metadata_created_at = excluded.file_metadata_created_at,
            file_metadata_modified_at = excluded.file_metadata_modified_at,
            updated_at = greatest(
                excluded.updated_at,
                current.updated_at + interval '1 microsecond'
            ),
            revision = current.revision + 1,
            sync_id = excluded.sync_id,
            analysis_input_revision = excluded.analysis_input_revision,
            current_analysis_run_id = case
                when excluded.analysis_input_revision = current.revision + 1
                    then null
                else current.current_analysis_run_id
            end,
            source_file_state = excluded.source_file_state,
            source_file_state_settled_at =
                excluded.source_file_state_settled_at,
            source_file_state_settled_by =
                excluded.source_file_state_settled_by,
            content_path = null
        where current.revision < 9223372036854775807
        returning
            current.id,
            current.device_id,
            current.name,
            current.absolute_path,
            current.mime_type,
            current.extension,
            current.file_metadata_created_at,
            current.file_metadata_modified_at,
            current.updated_at,
            current.revision,
            current.sync_id,
            current.analysis_input_revision,
            current.source_file_state,
            current.source_file_state_settled_at,
            current.source_file_state_settled_by
    ),
    mutation_results as materialized (
        select
            accepted.sync_id,
            accepted.batch_index,
            accepted.item_index,
            accepted.root_id,
            mutated.id as file_id,
            mutated.device_id,
            mutated.name,
            mutated.absolute_path,
            mutated.mime_type,
            mutated.extension,
            mutated.file_metadata_created_at,
            mutated.file_metadata_modified_at,
            mutated.updated_at,
            mutated.revision,
            mutated.analysis_input_revision,
            mutated.source_file_state,
            mutated.source_file_state_settled_at,
            mutated.source_file_state_settled_by,
            accepted.source_sequence,
            case
                when mutated.id = accepted.candidate_file_id then 'created'
                else 'updated'
            end as outcome,
            (mutated.revision = mutated.analysis_input_revision)
                as analysis_required
        from mutated_files as mutated
        join accepted_input as accepted
          on accepted.device_id = mutated.device_id
         and accepted.absolute_path = mutated.absolute_path
    ),
    marked_stale_uploads as (
        update file_content_upload as upload
        set status = 'stale'::public.file_content_upload_status,
            next_cleanup_at = greatest(clock_timestamp(), upload.created_at)
        from mutation_results as result
        where upload.device_id = result.device_id
          and upload.file_id = result.file_id
          and upload.revision < result.revision
          and upload.status = 'open'::public.file_content_upload_status
        returning upload.id
    ),
    cleared_current_tags as (
        delete from device_file_tag as link
        using mutation_results as result
        where result.analysis_required
          and link.file_entry_id = result.file_id
        returning link.id
    ),
    inserted_revisions as (
        insert into file_revision (
            id,
            revision,
            device_id,
            sync_id,
            source_sequence,
            analysis_input_revision,
            name,
            absolute_path,
            mime_type,
            extension,
            file_metadata_created_at,
            file_metadata_modified_at,
            source_file_state,
            source_file_state_settled_at,
            source_file_state_settled_by,
            created_at
        )
        select
            result.file_id,
            result.revision,
            result.device_id,
            result.sync_id,
            result.source_sequence,
            result.analysis_input_revision,
            result.name,
            result.absolute_path,
            result.mime_type,
            result.extension,
            result.file_metadata_created_at at time zone 'UTC',
            result.file_metadata_modified_at at time zone 'UTC',
            result.source_file_state,
            result.source_file_state_settled_at,
            result.source_file_state_settled_by,
            result.updated_at at time zone 'UTC'
        from mutation_results as result
        returning id, revision
    ),
    accepted_items as (
        update file_sync_item as item
        set outcome = result.outcome::public.file_sync_item_outcome,
            file_id = result.file_id,
            revision = result.revision,
            root_id = result.root_id
        from mutation_results as result
        where item.id = result.sync_id
          and item.batch_index = result.batch_index
          and item.item_index = result.item_index
          and item.outcome is null
        returning item.id
    ),
    rejected_input as materialized (
        select *
        from jsonb_to_recordset($2::jsonb) as rejected(
            sync_id uuid,
            batch_index integer,
            item_index integer
        )
    ),
    rejected_items as (
        update file_sync_item as item
        set outcome = 'rejected'::public.file_sync_item_outcome,
            error_code = 'duplicate_path_in_session',
            error_message =
                'the normalized path already has an accepted result in this session'
        from rejected_input as rejected
        where item.id = rejected.sync_id
          and item.batch_index = rejected.batch_index
          and item.item_index = rejected.item_index
          and item.outcome is null
        returning item.id
    )
    select
        (select count(*) from accepted_input) as expected_mutated_count,
        (select count(*) from mutation_results) as mutated_count,
        (select count(*) from inserted_revisions) as revision_count,
        (select count(*) from marked_stale_uploads) as stale_upload_count,
        (select count(*) from accepted_items) as accepted_count,
        (select count(*) from rejected_input) as expected_rejected_count,
        (select count(*) from rejected_items) as rejected_count
"#;

fn accepted_item_outcome_expr() -> SimpleExpr {
    Expr::col(file_sync_item::Column::Outcome).is_in([
        SimpleExpr::Constant(DbItemOutcome::Created.to_value().into()),
        SimpleExpr::Constant(DbItemOutcome::Updated.to_value().into()),
    ])
}

#[derive(Serialize)]
struct AcceptedMutation {
    sync_id: Uuid,
    batch_index: i32,
    item_index: i32,
    candidate_file_id: Uuid,
    device_id: Uuid,
    root_id: Uuid,
    parent_id: Uuid,
    name: String,
    absolute_path: String,
    hierarchy_path: String,
    mime_type: Option<String>,
    extension: Option<String>,
    file_metadata_created_at: Option<NaiveDateTime>,
    file_metadata_modified_at: Option<NaiveDateTime>,
    created_at: NaiveDateTime,
    updated_at: NaiveDateTime,
    source_file_state: Option<&'static str>,
    source_file_state_settled_at: Option<DateTime<FixedOffset>>,
    source_file_state_settled_by: Option<String>,
    source_sequence: i64,
    analysis_input_revision: i64,
}

#[derive(Serialize)]
struct RejectedMutation {
    sync_id: Uuid,
    batch_index: i32,
    item_index: i32,
}
struct PreparedAcceptedItem {
    item: file_sync_item::Model,
    mutation: PreparedFileMutation,
    current: Option<file_entry::Model>,
}

pub(super) async fn apply_sync_items(
    transaction: &DatabaseTransaction,
    device_id: Uuid,
    items: Vec<file_sync_item::Model>,
    metrics: Option<&Metrics>,
) -> Result<u64, FilesystemError> {
    let Some(first) = items.first() else {
        return Ok(0);
    };
    let sync_id = first.id;
    let batch_index = first.batch_index;
    if items
        .iter()
        .any(|item| item.id != sync_id || item.batch_index != batch_index)
    {
        return Err(FilesystemError::Invariant("sync_item_batch_mismatch"));
    }

    lock_source_state(transaction, device_id).await?;

    let mut absolute_paths = items
        .iter()
        .map(|item| item.absolute_path.clone())
        .collect::<Vec<_>>();
    absolute_paths.sort_unstable();
    absolute_paths.dedup();
    let mut current_files =
        load_current_files(transaction, device_id, &absolute_paths).await?;
    let accepted_paths = file_sync_item::Entity::find()
        .select_only()
        .column(file_sync_item::Column::AbsolutePath)
        .filter(file_sync_item::Column::Id.eq(sync_id))
        .filter(
            file_sync_item::Column::AbsolutePath.is_in(absolute_paths.clone()),
        )
        .filter(accepted_item_outcome_expr())
        .into_tuple::<String>()
        .all(transaction)
        .await
        .map_err(|error| {
            map_transaction_body_error(anyhow::Error::new(error).context(h!()))
        })?;
    let mut accepted_paths = accepted_paths.into_iter().collect::<HashSet<_>>();
    let mut prepared_items = Vec::with_capacity(items.len());
    let mut rejected_items = Vec::new();

    for item in items {
        if item.outcome.is_some() {
            continue;
        }
        if !accepted_paths.insert(item.absolute_path.clone()) {
            rejected_items.push(RejectedMutation {
                sync_id: item.id,
                batch_index: item.batch_index,
                item_index: item.item_index,
            });
            continue;
        }

        let mutation = mutation_from_item(device_id, &item)?;
        let current = current_files.remove(&item.absolute_path);
        prepared_items.push(PreparedAcceptedItem {
            item,
            mutation,
            current,
        });
    }

    let now = Utc::now().naive_utc();
    let new_mutations = prepared_items
        .iter()
        .filter(|item| item.current.is_none())
        .map(|item| &item.mutation)
        .collect::<Vec<_>>();
    let expected_new_hierarchy_count = new_mutations.len();
    let new_hierarchies =
        resolve_new_file_hierarchies(transaction, &new_mutations, now).await?;
    if new_hierarchies.len() != expected_new_hierarchy_count {
        return Err(FilesystemError::Invariant(
            "mutation_hierarchy_result_count_mismatch",
        ));
    }
    drop(new_mutations);

    let mut new_hierarchies = new_hierarchies.into_iter();
    let mut accepted_items = Vec::with_capacity(prepared_items.len());
    for prepared in prepared_items {
        let hierarchy = if prepared.current.is_none() {
            Some(new_hierarchies.next().ok_or(FilesystemError::Invariant(
                "mutation_hierarchy_result_missing",
            ))?)
        } else {
            None
        };
        accepted_items.push(prepare_accepted_mutation(
            &prepared.item,
            &prepared.mutation,
            prepared.current,
            hierarchy,
            now,
        )?);
    }
    if new_hierarchies.next().is_some() {
        return Err(FilesystemError::Invariant(
            "mutation_hierarchy_result_unexpected",
        ));
    }

    persist_sync_items(
        transaction,
        device_id,
        accepted_items,
        rejected_items,
        metrics,
    )
    .await
}

async fn load_current_files(
    transaction: &DatabaseTransaction,
    device_id: Uuid,
    absolute_paths: &[String],
) -> Result<HashMap<String, file_entry::Model>, FilesystemError> {
    let files = file_entry::Entity::find()
        .filter(file_entry::Column::DeviceId.eq(device_id))
        .filter(Expr::col(file_entry::Column::Kind).eq(SimpleExpr::Constant(
            DomainFileEntryKind::File.to_value().into(),
        )))
        .filter(file_entry::Column::AbsolutePath.is_in(absolute_paths.to_vec()))
        .order_by_asc(file_entry::Column::Id)
        .lock_exclusive()
        .all(transaction)
        .await
        .map_err(|error| {
            map_transaction_body_error(anyhow::Error::new(error).context(h!()))
        })?;
    let mut files_by_path = HashMap::with_capacity(files.len());
    for file in files {
        let absolute_path =
            file.absolute_path
                .clone()
                .ok_or(FilesystemError::Invariant(
                    "mutation_file_absolute_path_missing",
                ))?;
        if files_by_path.insert(absolute_path, file).is_some() {
            return Err(FilesystemError::Invariant(
                "mutation_file_path_not_unique",
            ));
        }
    }
    Ok(files_by_path)
}

fn mutation_from_item(
    device_id: Uuid,
    item: &file_sync_item::Model,
) -> Result<PreparedFileMutation, FilesystemError> {
    let source_path = parse_source_path(
        item.absolute_path.clone(),
        &format!("files[{}].absolute_path", item.item_index),
    )?;
    let metadata = normalize_file_metadata(
        source_path.file_name(),
        item.mime_type.clone(),
        item.extension.clone(),
        item.file_metadata_created_at,
        item.file_metadata_modified_at,
        &format!("files[{}]", item.item_index),
    )?;
    let source_file_state = match (
        item.source_file_state.clone(),
        item.source_file_state_settled_at,
        item.source_file_state_settled_by.clone(),
    ) {
        (None, None, None) => None,
        (Some(state), Some(settled_at), settled_by) => {
            Some(NormalizedSourceFileState {
                state,
                settled_at,
                settled_by,
            })
        }
        _ => {
            return Err(FilesystemError::Invariant(
                "sync_item_source_state_incomplete",
            ));
        }
    };

    Ok(PreparedFileMutation::new(
        device_id,
        item.id,
        source_path,
        metadata,
        source_file_state,
    ))
}

fn prepare_accepted_mutation(
    item: &file_sync_item::Model,
    mutation: &PreparedFileMutation,
    existing: Option<file_entry::Model>,
    hierarchy: Option<ResolvedNewFileHierarchy>,
    now: NaiveDateTime,
) -> Result<AcceptedMutation, FilesystemError> {
    let name = mutation.source_path.file_name().to_string();
    let absolute_path = mutation.source_path.absolute_path.clone();
    let (root_id, parent_id, hierarchy_path, analysis_input_revision) =
        match (existing, hierarchy) {
            (Some(current), None) => {
                let revision = current
                    .revision
                    .ok_or(FilesystemError::Invariant(
                        "mutation_file_revision_missing",
                    ))?
                    .checked_add(1)
                    .ok_or(FilesystemError::Invariant(
                        "file_revision_overflow",
                    ))?;
                let current_absolute_path = current
                    .absolute_path
                    .as_deref()
                    .ok_or(FilesystemError::Invariant(
                        "mutation_file_absolute_path_missing",
                    ))?;
                let current_input = FileAnalysisInput {
                    name: &current.name,
                    absolute_path: current_absolute_path,
                    extension: current.extension.as_deref(),
                };
                let incoming_input = FileAnalysisInput {
                    name: &name,
                    absolute_path: &absolute_path,
                    extension: mutation.metadata.extension.as_deref(),
                };
                let analysis_input_revision = if rules::evaluator_inputs_equal(
                    &current_input,
                    &incoming_input,
                ) {
                    current.analysis_input_revision.ok_or(
                        FilesystemError::Invariant(
                            "analysis_input_revision_missing",
                        ),
                    )?
                } else {
                    revision
                };
                let root_id = root_entry_id(&current.hierarchy_path)?;
                let parent_id = current.parent_id.ok_or(
                    FilesystemError::Invariant("mutation_file_parent_missing"),
                )?;
                (
                    root_id,
                    parent_id,
                    current.hierarchy_path,
                    analysis_input_revision,
                )
            }
            (None, Some(hierarchy)) => (
                hierarchy.root_id,
                hierarchy.parent_id,
                child_hierarchy_path(
                    &hierarchy.parent_hierarchy_path,
                    mutation.candidate_file_id,
                ),
                1,
            ),
            _ => {
                return Err(FilesystemError::Invariant(
                    "mutation_hierarchy_result_mismatch",
                ));
            }
        };
    let source_file_state = source_state_columns(&mutation.source_file_state);

    Ok(AcceptedMutation {
        sync_id: item.id,
        batch_index: item.batch_index,
        item_index: item.item_index,
        candidate_file_id: mutation.candidate_file_id,
        device_id: mutation.device_id,
        root_id,
        parent_id,
        name,
        absolute_path,
        hierarchy_path,
        mime_type: mutation.metadata.mime_type.clone(),
        extension: mutation.metadata.extension.clone(),
        file_metadata_created_at: mutation.metadata.file_metadata_created_at,
        file_metadata_modified_at: mutation.metadata.file_metadata_modified_at,
        created_at: now,
        updated_at: now,
        source_file_state: source_file_state.0,
        source_file_state_settled_at: source_file_state.1,
        source_file_state_settled_by: source_file_state.2,
        source_sequence: 0,
        analysis_input_revision,
    })
}

async fn persist_sync_items(
    transaction: &DatabaseTransaction,
    device_id: Uuid,
    mut accepted_items: Vec<AcceptedMutation>,
    rejected_items: Vec<RejectedMutation>,
    metrics: Option<&Metrics>,
) -> Result<u64, FilesystemError> {
    if accepted_items.is_empty() && rejected_items.is_empty() {
        return Ok(0);
    }
    accepted_items
        .sort_unstable_by_key(|item| (item.batch_index, item.item_index));
    let expected_mutated_count = i64::try_from(accepted_items.len())
        .map_err(|_| FilesystemError::Invariant("sync_item_count_invalid"))?;
    if expected_mutated_count > 0 {
        let allocation_started_at = Instant::now();
        let first_source_sequence = allocate_source_sequence_range(
            transaction,
            device_id,
            expected_mutated_count,
        )
        .await?;
        if let Some(metrics) = metrics {
            metrics.record_file_analysis_db_duration(
                FileAnalysisDbOperation::SourceRangeAllocation,
                allocation_started_at.elapsed(),
            );
        }
        for (offset, item) in accepted_items.iter_mut().enumerate() {
            item.source_sequence = first_source_sequence
                .checked_add(i64::try_from(offset).map_err(|_| {
                    FilesystemError::Invariant("sync_item_count_invalid")
                })?)
                .ok_or(FilesystemError::Invariant(
                    "source_sequence_overflow",
                ))?;
        }
    }
    let expected_rejected_count = i64::try_from(rejected_items.len())
        .map_err(|_| FilesystemError::Invariant("sync_item_count_invalid"))?;
    let accepted_payload =
        serde_json::to_string(&accepted_items).map_err(|error| {
            FilesystemError::Internal(anyhow::Error::new(error).context(h!()))
        })?;
    let rejected_payload =
        serde_json::to_string(&rejected_items).map_err(|error| {
            FilesystemError::Internal(anyhow::Error::new(error).context(h!()))
        })?;
    let counts = transaction
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            APPLY_SYNC_ITEMS_SQL,
            [accepted_payload.into(), rejected_payload.into()],
        ))
        .await
        .map_err(|error| {
            map_transaction_body_error(anyhow::Error::new(error).context(h!()))
        })?
        .ok_or(FilesystemError::Invariant(
            "sync_item_mutation_counts_missing",
        ))?;

    for (column, expected, invariant) in [
        (
            "expected_mutated_count",
            expected_mutated_count,
            "sync_item_input_count_invalid",
        ),
        (
            "mutated_count",
            expected_mutated_count,
            "mutation_file_count_invalid",
        ),
        (
            "revision_count",
            expected_mutated_count,
            "mutation_revision_insert_count_invalid",
        ),
        (
            "accepted_count",
            expected_mutated_count,
            "sync_item_accept_count_invalid",
        ),
        (
            "expected_rejected_count",
            expected_rejected_count,
            "sync_item_reject_input_count_invalid",
        ),
        (
            "rejected_count",
            expected_rejected_count,
            "sync_item_reject_count_invalid",
        ),
    ] {
        let actual: i64 = counts.try_get("", column).map_err(|error| {
            map_transaction_body_error(anyhow::Error::new(error).context(h!()))
        })?;
        if actual != expected {
            return Err(FilesystemError::Invariant(invariant));
        }
    }

    let stale_upload_count: i64 =
        counts.try_get("", "stale_upload_count").map_err(|error| {
            map_transaction_body_error(anyhow::Error::new(error).context(h!()))
        })?;
    u64::try_from(stale_upload_count)
        .map_err(|_| FilesystemError::Invariant("stale_upload_count_invalid"))
}

async fn lock_source_state(
    transaction: &DatabaseTransaction,
    device_id: Uuid,
) -> Result<(), FilesystemError> {
    file_device_source_state::Entity::insert(
        file_device_source_state::ActiveModel {
            id: Set(device_id),
            last_source_sequence: Set(0),
        },
    )
    .on_conflict(
        OnConflict::column(file_device_source_state::Column::Id)
            .do_nothing()
            .to_owned(),
    )
    .exec_without_returning(transaction)
    .await
    .map_err(|error| {
        map_transaction_body_error(anyhow::Error::new(error).context(h!()))
    })?;
    file_device_source_state::Entity::find_by_id(device_id)
        .lock(LockType::Update)
        .one(transaction)
        .await
        .map_err(|error| {
            map_transaction_body_error(anyhow::Error::new(error).context(h!()))
        })?
        .ok_or(FilesystemError::Invariant(
            "file_device_source_state_missing",
        ))?;
    Ok(())
}

async fn allocate_source_sequence_range(
    transaction: &DatabaseTransaction,
    device_id: Uuid,
    count: i64,
) -> Result<i64, FilesystemError> {
    // apply_sync_items locks this device's source state before it reads the
    // current file projection. The allocation therefore orders concurrent
    // sync batches together with manual watermark capture.
    let source_state = file_device_source_state::Entity::find_by_id(device_id)
        .lock(LockType::Update)
        .one(transaction)
        .await
        .map_err(|error| {
            map_transaction_body_error(anyhow::Error::new(error).context(h!()))
        })?
        .ok_or(FilesystemError::Invariant(
            "file_device_source_state_missing",
        ))?;
    let first_source_sequence = source_state
        .last_source_sequence
        .checked_add(1)
        .ok_or(FilesystemError::Invariant("source_sequence_overflow"))?;
    let last_source_sequence = source_state
        .last_source_sequence
        .checked_add(count)
        .ok_or(FilesystemError::Invariant("source_sequence_overflow"))?;
    let mut source_state = source_state.into_active_model();
    source_state.last_source_sequence = Set(last_source_sequence);
    source_state.update(transaction).await.map_err(|error| {
        map_transaction_body_error(anyhow::Error::new(error).context(h!()))
    })?;
    Ok(first_source_sequence)
}

fn source_state_columns(
    source_file_state: &Option<NormalizedSourceFileState>,
) -> (
    Option<&'static str>,
    Option<DateTime<FixedOffset>>,
    Option<String>,
) {
    match source_file_state {
        Some(source_file_state) => (
            Some(match source_file_state.state {
                DomainSourceFileStateKind::Scanned => "scanned",
                DomainSourceFileStateKind::Downloaded => "downloaded",
                DomainSourceFileStateKind::Changed => "changed",
            }),
            Some(source_file_state.settled_at),
            source_file_state.settled_by.clone(),
        ),
        None => (None, None, None),
    }
}
