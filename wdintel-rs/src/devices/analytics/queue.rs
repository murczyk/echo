use super::{
    query,
    rules::{self, CompiledTagRules},
    types::{FileAnalysisInput, TagRuleDefinition},
};
use crate::file_registry::entities::{
    file_analysis_definition, file_analysis_run, file_analysis_run_item,
    file_device_source_state, file_metadata_revision,
};
use anyhow::{Context, Result};
use chrono::{DateTime, FixedOffset, Utc};
use sea_orm::{
    sea_query::{Expr, LockBehavior, LockType, OnConflict},
    ActiveModelTrait,
    ActiveValue::Set,
    ColumnTrait, Condition, ConnectionTrait, DatabaseConnection,
    DatabaseTransaction, DbBackend, DbErr, EntityTrait, ExprTrait,
    FromQueryResult, IntoActiveModel, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect, Statement, TransactionTrait,
};
use serde::Serialize;
use uuid::Uuid;

pub(super) const ANALYZER_VERSION: i32 = 1;
pub(super) const DSL_VERSION: i32 = 1;
// Stable application-owned PostgreSQL advisory-lock key. The value has no
// business meaning; uniqueness and stability across Echo instances are what
// serialize semantic tag mutation with definition snapshot publication.
const DEFINITION_PUBLICATION_ADVISORY_LOCK_KEY: i64 =
    i64::from_be_bytes(*b"FILEADEF");

#[derive(Clone, Debug)]
pub(super) struct RuleSnapshot {
    pub definitions: Vec<TagRuleDefinition>,
}

impl RuleSnapshot {
    pub fn compile(&self) -> Result<CompiledTagRules> {
        rules::compile_tag_rules(self.definitions.clone())
            .map_err(|error| anyhow::anyhow!(error.message))
    }
}

#[derive(Clone, Debug, FromQueryResult)]
pub(super) struct ClaimedAnalysisFile {
    pub run_id: Uuid,
    pub run_sequence: i64,
    pub definition_id: Uuid,
    pub file_id: Uuid,
    pub metadata_revision: i64,
    pub name: String,
    pub absolute_path: String,
    pub extension: Option<String>,
    pub lease_token: Uuid,
}

impl ClaimedAnalysisFile {
    pub fn input(&self) -> FileAnalysisInput<'_> {
        FileAnalysisInput {
            name: &self.name,
            absolute_path: &self.absolute_path,
            extension: self.extension.as_deref(),
        }
    }
}

#[derive(Debug)]
pub(super) struct CompletedAnalysisFile {
    pub run_id: Uuid,
    pub file_id: Uuid,
    pub metadata_revision: i64,
    pub matched_tag_ids: Vec<Uuid>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct PreparationResult {
    pub did_work: bool,
    pub inserted_count: u64,
    pub completed_run_duration_secs: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct CompletionResult {
    pub completed_count: u64,
    pub published_count: u64,
    pub result_write_duration_secs: f64,
    pub current_publish_duration_secs: f64,
    pub run_completion_duration_secs: Option<f64>,
}
#[derive(Debug)]
pub(super) struct ReanalyzeAllResult {
    pub definition_id: Uuid,
    pub created_run_count: u64,
}

pub(super) async fn lock_definition_publication<C>(db: &C) -> Result<(), DbErr>
where
    C: ConnectionTrait,
{
    db.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "select pg_advisory_xact_lock($1)",
        [DEFINITION_PUBLICATION_ADVISORY_LOCK_KEY.into()],
    ))
    .await?;
    Ok(())
}

pub(super) async fn publish_definition_if_changed(
    transaction: &DatabaseTransaction,
) -> Result<file_analysis_definition::Model, DbErr> {
    lock_definition_publication(transaction).await?;
    let definitions = rules::canonicalize_tag_rules(
        query::load_active_rule_definitions(transaction).await?,
    )
    .map_err(|error| DbErr::Custom(error.message))?;
    let rules_json = serde_json::to_value(&definitions)
        .map_err(|error| DbErr::Custom(error.to_string()))?;
    if let Some(current) = file_analysis_definition::Entity::find()
        .order_by_desc(file_analysis_definition::Column::DefinitionSequence)
        .one(transaction)
        .await?
    {
        if current.analyzer_version == ANALYZER_VERSION
            && current.dsl_version == DSL_VERSION
            && current.rules == rules_json
        {
            return Ok(current);
        }
    }
    file_analysis_definition::ActiveModel {
        id: Set(Uuid::now_v7()),
        definition_sequence: sea_orm::ActiveValue::NotSet,
        analyzer_version: Set(ANALYZER_VERSION),
        dsl_version: Set(DSL_VERSION),
        rules: Set(rules_json),
        created_at: sea_orm::ActiveValue::NotSet,
    }
    .insert(transaction)
    .await
}

pub(super) async fn ensure_current_definition<C>(
    db: &C,
) -> Result<file_analysis_definition::Model, DbErr>
where
    C: ConnectionTrait,
{
    if let Some(current) = file_analysis_definition::Entity::find()
        .order_by_desc(file_analysis_definition::Column::DefinitionSequence)
        .one(db)
        .await?
    {
        return Ok(current);
    }
    Err(DbErr::Custom(
        "file analysis definition has not been initialized".to_owned(),
    ))
}

pub(crate) async fn initialize_definition(
    db: &DatabaseConnection,
) -> Result<file_analysis_definition::Model, DbErr> {
    let transaction = db.begin().await?;
    let definition = publish_definition_if_changed(&transaction).await?;
    transaction.commit().await?;
    verify_runtime_state(db).await?;
    Ok(definition)
}

#[derive(Debug, FromQueryResult)]
struct RuntimeStateVerification {
    definition_count: i64,
    invariant_violation_count: i64,
    invariant_violations: serde_json::Value,
    unsupported_nonterminal_run_count: i64,
    required_constraint_count: i64,
    required_trigger_count: i64,
    required_index_count: i64,
    legacy_table_count: i64,
    legacy_function_count: i64,
    legacy_trigger_count: i64,
}

// This startup-only audit spans application data invariants and PostgreSQL
// catalogs (constraints, triggers, indexes, and removed objects), for which
// SeaORM has no entity-level representation.
async fn verify_runtime_state(db: &DatabaseConnection) -> Result<(), DbErr> {
    let verification = RuntimeStateVerification::find_by_statement(
        Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"
                with revision_watermarks as materialized (
                    select
                        device_id,
                        max(source_sequence) as last_source_sequence
                    from file_metadata_revision
                    group by device_id
                ),
                source_state_mismatches as materialized (
                    select coalesce(revision.device_id, source.id) as device_id
                    from revision_watermarks as revision
                    full join file_device_source_state as source
                      on source.id = revision.device_id
                    where coalesce(revision.last_source_sequence, 0)
                        <> coalesce(source.last_source_sequence, -1)
                ),
                violations as materialized (
                    select
                        (
                            select count(*)
                            from source_state_mismatches
                        )::bigint as source_state,
                        (
                            select count(*)
                            from file_metadata_revision as revision
                            left join file_metadata_revision as input
                              on input.id = revision.id
                             and input.revision =
                                revision.analysis_input_revision
                            where input.id is null
                        )::bigint as metadata_input_pointer,
                        (
                            select count(*)
                            from file_entry as file
                            left join file_metadata_revision as revision
                              on revision.id = file.id
                             and revision.revision = file.revision
                            where file.kind = 'file'
                              and (
                                revision.id is null
                                or file.analysis_input_revision
                                    is distinct from
                                    revision.analysis_input_revision
                              )
                        )::bigint as current_input_pointer,
                        (
                            select count(*)
                            from file_analysis_run as run
                            join file_sync_session as session
                              on session.id = run.sync_id
                            where run.sync_id is not null
                              and session.status::text not in (
                                'completed',
                                'completed_with_errors',
                                'expired'
                              )
                        )::bigint as nonterminal_sync_run,
                        (
                            select count(*)
                            from file_analysis_run as run
                            where run.sync_id is not null
                              and not exists (
                                select 1
                                from file_metadata_revision as revision
                                where revision.sync_id = run.sync_id
                                  and revision.revision =
                                    revision.analysis_input_revision
                              )
                        )::bigint as empty_sync_run,
                        (
                            select count(*)
                            from file_analysis_run as run
                            where run.prepared_at is not null
                              and run.item_count <> (
                                select count(*)
                                from file_analysis_run_item as item
                                where item.id = run.id
                              )
                        )::bigint as prepared_item_set,
                        (
                            select count(*)
                            from file_analysis_run_item as item
                            join file_analysis_run as run
                              on run.id = item.id
                            join file_analysis_definition as definition
                              on definition.id = run.definition_id
                            where (
                                (item.completed_at is null)
                                <> (item.result_tag_ids is null)
                              )
                               or (
                                item.result_tag_ids is not null
                                and item.result_tag_ids <> (
                                    select coalesce(
                                        array_agg(
                                            canonical.tag_id
                                            order by canonical.tag_id
                                        ),
                                        '{}'::uuid[]
                                    )
                                    from (
                                        select distinct result.tag_id
                                        from unnest(item.result_tag_ids)
                                            as result(tag_id)
                                    ) as canonical
                                )
                              )
                               or exists (
                                select 1
                                from unnest(item.result_tag_ids)
                                    as result(tag_id)
                                where not exists (
                                    select 1
                                    from jsonb_array_elements(
                                        definition.rules
                                    ) as rule(value)
                                    where rule.value ->> 'tag_id'
                                        = result.tag_id::text
                                )
                              )
                        )::bigint as completed_item,
                        (
                            select count(*)
                            from file_analysis_run as run
                            where run.completed_at is not null
                              and (
                                run.prepared_at is null
                                or run.completed_count <> run.item_count
                              )
                        )::bigint as completed_run_count,
                        (
                            select count(*)
                            from file_analysis_run as run
                            where run.completed_at is not null
                              and exists (
                                select 1
                                from file_analysis_run_item as item
                                where item.id = run.id
                                  and item.completed_at is null
                              )
                        )::bigint as completed_run_item,
                        (
                            select count(*)
                            from file_entry as file
                            left join file_analysis_run_item as item
                              on item.id = file.current_analysis_run_id
                             and item.file_id = file.id
                            left join file_metadata_revision as target
                              on target.id = item.file_id
                             and target.revision =
                                item.metadata_revision
                            where file.current_analysis_run_id is not null
                              and (
                                item.completed_at is null
                                or target.analysis_input_revision
                                    is distinct from
                                    file.analysis_input_revision
                              )
                        )::bigint as current_result_pointer,
                        (
                            select count(*)
                            from device_file_tag as link
                            join file_entry as file
                              on file.id = link.file_entry_id
                            left join file_analysis_run_item as item
                              on item.id = file.current_analysis_run_id
                             and item.file_id = file.id
                            where file.current_analysis_run_id is null
                               or item.id is null
                               or link.device_id <> file.device_id
                               or not (
                                    link.tag_id = any(
                                        coalesce(
                                            item.result_tag_ids,
                                            '{}'::uuid[]
                                        )
                                    )
                               )
                        )::bigint as current_tag_projection
                )
                select
                    (select count(*) from file_analysis_definition)
                        as definition_count,
                    (
                        select
                            source_state
                            + metadata_input_pointer
                            + current_input_pointer
                            + nonterminal_sync_run
                            + empty_sync_run
                            + prepared_item_set
                            + completed_item
                            + completed_run_count
                            + completed_run_item
                            + current_result_pointer
                            + current_tag_projection
                        from violations
                    ) as invariant_violation_count,
                    (
                        select to_jsonb(violations)
                        from violations
                    ) as invariant_violations,
                    (
                        select count(*)
                        from file_analysis_run as run
                        join file_analysis_definition as definition
                          on definition.id = run.definition_id
                        where run.completed_at is null
                          and (
                            definition.analyzer_version <> $1
                            or definition.dsl_version <> $2
                          )
                    ) as unsupported_nonterminal_run_count,
                    (
                        select count(*)
                        from pg_constraint as catalog_constraint
                        join pg_class as relation
                          on relation.oid = catalog_constraint.conrelid
                        join pg_namespace as namespace
                          on namespace.oid = relation.relnamespace
                        where namespace.nspname = 'public'
                          and catalog_constraint.conname in (
                            'file_metadata_revision_source_sequence_key',
                            'file_metadata_revision_input_fk',
                            'file_entry_analysis_input_fk',
                            'file_entry_current_analysis_fk'
                          )
                          and catalog_constraint.convalidated
                    ) as required_constraint_count,
                    (
                        select count(*)
                        from pg_trigger as catalog_trigger
                        join pg_class as relation
                          on relation.oid = catalog_trigger.tgrelid
                        join pg_namespace as namespace
                          on namespace.oid = relation.relnamespace
                        where namespace.nspname = 'public'
                          and catalog_trigger.tgname in (
                            'file_analysis_definition_immutable_trg',
                            'file_analysis_run_mutation_guard_trg',
                            'file_analysis_run_item_mutation_guard_trg',
                            'analytics_tag_referenced_delete_guard_trg',
                            'file_entry_current_analysis_guard_trg'
                          )
                          and not catalog_trigger.tgisinternal
                          and catalog_trigger.tgenabled <> 'D'
                    ) as required_trigger_count,
                    (
                        select count(*)
                        from pg_class as catalog_index
                        join pg_namespace as namespace
                          on namespace.oid = catalog_index.relnamespace
                        join pg_index as metadata
                          on metadata.indexrelid = catalog_index.oid
                        where namespace.nspname = 'public'
                          and catalog_index.relname in (
                            'file_metadata_revision_device_file_source_idx',
                            'file_metadata_revision_sync_file_idx',
                            'file_analysis_run_sync_uidx',
                            'file_analysis_run_device_sequence_idx',
                            'file_analysis_run_preparing_idx',
                            'file_analysis_run_running_idx',
                            'file_analysis_run_item_pending_idx',
                            'file_analysis_run_item_file_idx'
                          )
                          and catalog_index.relkind = 'i'
                          and metadata.indisvalid
                          and metadata.indisready
                    ) as required_index_count,
                    (
                        select count(*)
                        from unnest(array[
                            to_regclass('public.file_analysis_control'),
                            to_regclass('public.file_analysis_device_state'),
                            to_regclass('public.file_analysis_state'),
                            to_regclass('public.file_analysis_reanalysis_job'),
                            to_regclass(
                                'public.analytics_tag_rule_set_state'
                            )
                        ]) as legacy_table
                        where legacy_table is not null
                    ) as legacy_table_count,
                    (
                        select count(*)
                        from pg_proc as catalog_function
                        join pg_namespace as namespace
                          on namespace.oid = catalog_function.pronamespace
                        where namespace.nspname = 'public'
                          and catalog_function.proname in (
                            'file_analysis_enqueue_file_entry',
                            'file_analysis_enqueue_reanalysis_device',
                            'file_analysis_enqueue_updated_device_states',
                            'file_analysis_enqueue_inserted_device_states'
                          )
                    ) as legacy_function_count,
                    (
                        select count(*)
                        from pg_trigger as catalog_trigger
                        join pg_class as relation
                          on relation.oid = catalog_trigger.tgrelid
                        join pg_namespace as namespace
                          on namespace.oid = relation.relnamespace
                        where namespace.nspname = 'public'
                          and catalog_trigger.tgname in (
                            'file_analysis_enqueue_insert_trg',
                            'file_analysis_enqueue_update_trg',
                            'file_analysis_enqueue_reanalysis_device_trg',
                            'file_analysis_enqueue_device_state_update_trg',
                            'file_analysis_enqueue_device_state_insert_trg'
                          )
                          and not catalog_trigger.tgisinternal
                    ) as legacy_trigger_count
            "#,
            [ANALYZER_VERSION.into(), DSL_VERSION.into()],
        ),
    )
    .one(db)
    .await?
    .ok_or_else(|| {
        DbErr::Custom(
            "file analysis runtime verification returned no row".to_owned(),
        )
    })?;

    if verification.definition_count == 0
        || verification.invariant_violation_count != 0
        || verification.unsupported_nonterminal_run_count != 0
        || verification.required_constraint_count != 4
        || verification.required_trigger_count != 5
        || verification.required_index_count != 8
        || verification.legacy_table_count != 0
        || verification.legacy_function_count != 0
        || verification.legacy_trigger_count != 0
    {
        return Err(DbErr::Custom(format!(
            "file analysis runtime verification failed: definitions={}, invariant_violations={} ({}), unsupported_nonterminal_runs={}, required_constraints={}/4, required_triggers={}/5, required_indexes={}/8, legacy_tables={}, legacy_functions={}, legacy_triggers={}",
            verification.definition_count,
            verification.invariant_violation_count,
            verification.invariant_violations,
            verification.unsupported_nonterminal_run_count,
            verification.required_constraint_count,
            verification.required_trigger_count,
            verification.required_index_count,
            verification.legacy_table_count,
            verification.legacy_function_count,
            verification.legacy_trigger_count,
        )));
    }
    Ok(())
}

pub(in crate::devices) async fn ensure_sync_run(
    transaction: &DatabaseTransaction,
    sync_id: Uuid,
    device_id: Uuid,
) -> Result<Option<Uuid>, DbErr> {
    if let Some(run_id) = file_analysis_run::Entity::find()
        .select_only()
        .column(file_analysis_run::Column::Id)
        .filter(file_analysis_run::Column::SyncId.eq(sync_id))
        .into_tuple::<Uuid>()
        .one(transaction)
        .await?
    {
        return Ok(Some(run_id));
    }
    let has_new_input = file_metadata_revision::Entity::find()
        .select_only()
        .column(file_metadata_revision::Column::Id)
        .filter(file_metadata_revision::Column::SyncId.eq(sync_id))
        .filter(
            Expr::col(file_metadata_revision::Column::Revision)
                .equals(file_metadata_revision::Column::AnalysisInputRevision),
        )
        .limit(1)
        .into_tuple::<Uuid>()
        .one(transaction)
        .await?
        .is_some();
    if !has_new_input {
        return Ok(None);
    }
    let definition = ensure_current_definition(transaction).await?;
    let run =
        insert_run(transaction, device_id, Some(sync_id), None, definition.id)
            .await?;
    Ok(Some(run.id))
}

pub(super) async fn create_manual_run(
    db: &DatabaseConnection,
    device_id: Uuid,
) -> Result<file_analysis_run::Model, DbErr> {
    let transaction = db.begin().await?;
    ensure_source_state(&transaction, device_id).await?;
    let target_source_sequence =
        file_device_source_state::Entity::find_by_id(device_id)
            .lock(LockType::Update)
            .one(&transaction)
            .await?
            .ok_or_else(|| {
                DbErr::RecordNotFound("file_device_source_state".into())
            })?
            .last_source_sequence;
    let definition = ensure_current_definition(&transaction).await?;
    let run = insert_run(
        &transaction,
        device_id,
        None,
        Some(target_source_sequence),
        definition.id,
    )
    .await?;
    transaction.commit().await?;
    Ok(run)
}

pub(super) async fn create_manual_runs_all(
    db: &DatabaseConnection,
) -> Result<ReanalyzeAllResult, DbErr> {
    let transaction = db.begin().await?;
    let definition = ensure_current_definition(&transaction).await?;
    let source_states = file_device_source_state::Entity::find()
        .filter(file_device_source_state::Column::LastSourceSequence.gt(0))
        .order_by_asc(file_device_source_state::Column::Id)
        .lock(LockType::Update)
        .all(&transaction)
        .await?;
    for source_state in &source_states {
        insert_run(
            &transaction,
            source_state.id,
            None,
            Some(source_state.last_source_sequence),
            definition.id,
        )
        .await?;
    }
    let created_run_count = source_states.len() as u64;
    transaction.commit().await?;
    Ok(ReanalyzeAllResult {
        definition_id: definition.id,
        created_run_count,
    })
}

async fn ensure_source_state(
    transaction: &DatabaseTransaction,
    device_id: Uuid,
) -> Result<(), DbErr> {
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
    .await?;
    Ok(())
}

async fn insert_run(
    transaction: &DatabaseTransaction,
    device_id: Uuid,
    sync_id: Option<Uuid>,
    target_source_sequence: Option<i64>,
    definition_id: Uuid,
) -> Result<file_analysis_run::Model, DbErr> {
    file_analysis_run::ActiveModel {
        id: Set(Uuid::now_v7()),
        run_sequence: sea_orm::ActiveValue::NotSet,
        device_id: Set(device_id),
        sync_id: Set(sync_id),
        target_source_sequence: Set(target_source_sequence),
        definition_id: Set(definition_id),
        item_count: Set(0),
        completed_count: Set(0),
        created_at: sea_orm::ActiveValue::NotSet,
        prepared_at: Set(None),
        completed_at: Set(None),
    }
    .insert(transaction)
    .await
}

pub(super) async fn load_rule_snapshot<C>(
    db: &C,
    definition_id: Uuid,
) -> Result<RuleSnapshot, DbErr>
where
    C: ConnectionTrait,
{
    let definition =
        file_analysis_definition::Entity::find_by_id(definition_id)
            .one(db)
            .await?
            .ok_or_else(|| {
                DbErr::RecordNotFound("file_analysis_definition".into())
            })?;
    if definition.analyzer_version != ANALYZER_VERSION
        || definition.dsl_version != DSL_VERSION
    {
        return Err(DbErr::Custom(format!(
            "unsupported file analysis definition versions: analyzer={}, dsl={}",
            definition.analyzer_version, definition.dsl_version
        )));
    }
    let definitions =
        serde_json::from_value::<Vec<TagRuleDefinition>>(definition.rules)
            .map_err(|error| DbErr::Custom(error.to_string()))?;
    let definitions = rules::canonicalize_tag_rules(definitions)
        .map_err(|error| DbErr::Custom(error.message))?;
    Ok(RuleSnapshot { definitions })
}

#[derive(Debug, FromQueryResult)]
struct PreparationCandidate {
    file_id: Uuid,
    metadata_revision: i64,
}

pub(super) async fn prepare_next_page(
    db: &DatabaseConnection,
    page_size: u64,
) -> Result<PreparationResult> {
    let transaction = db.begin().await.context("begin analysis preparation")?;
    let Some(run) = file_analysis_run::Entity::find()
        .filter(file_analysis_run::Column::PreparedAt.is_null())
        .order_by_asc(file_analysis_run::Column::RunSequence)
        .lock_with_behavior(LockType::Update, LockBehavior::SkipLocked)
        .one(&transaction)
        .await
        .context("claim analysis run preparation")?
    else {
        transaction
            .commit()
            .await
            .context("commit empty preparation")?;
        return Ok(PreparationResult {
            did_work: false,
            inserted_count: 0,
            completed_run_duration_secs: None,
        });
    };
    let last_file_id = file_analysis_run_item::Entity::find()
        .select_only()
        .column(file_analysis_run_item::Column::FileId)
        .filter(file_analysis_run_item::Column::Id.eq(run.id))
        .order_by_desc(file_analysis_run_item::Column::FileId)
        .into_tuple::<Uuid>()
        .one(&transaction)
        .await
        .context("load analysis preparation cursor")?;
    let cursor = last_file_id.unwrap_or(Uuid::nil());
    let candidates = if let Some(sync_id) = run.sync_id {
        file_metadata_revision::Entity::find()
            .select_only()
            .column_as(file_metadata_revision::Column::Id, "file_id")
            .column_as(
                file_metadata_revision::Column::Revision,
                "metadata_revision",
            )
            .filter(file_metadata_revision::Column::SyncId.eq(sync_id))
            .filter(
                Expr::col(file_metadata_revision::Column::Revision).equals(
                    file_metadata_revision::Column::AnalysisInputRevision,
                ),
            )
            .filter(file_metadata_revision::Column::Id.gt(cursor))
            .order_by_asc(file_metadata_revision::Column::Id)
            .limit(page_size)
            .into_model::<PreparationCandidate>()
            .all(&transaction)
            .await
            .context("load sync analysis targets")?
    } else {
        let target_source_sequence =
            run.target_source_sequence.ok_or_else(|| {
                anyhow::anyhow!(
                    "manual analysis run {} has no watermark",
                    run.id
                )
            })?;
        file_metadata_revision::Entity::find()
            .select_only()
            .column_as(file_metadata_revision::Column::Id, "file_id")
            .column_as(
                file_metadata_revision::Column::Revision,
                "metadata_revision",
            )
            .distinct_on([file_metadata_revision::Column::Id])
            .filter(file_metadata_revision::Column::DeviceId.eq(run.device_id))
            .filter(
                file_metadata_revision::Column::SourceSequence
                    .lte(target_source_sequence),
            )
            .filter(file_metadata_revision::Column::Id.gt(cursor))
            .order_by_asc(file_metadata_revision::Column::Id)
            .order_by_desc(file_metadata_revision::Column::SourceSequence)
            .limit(page_size)
            .into_model::<PreparationCandidate>()
            .all(&transaction)
            .await
            .context("load manual analysis targets")?
    };
    let mut run_active = run.clone().into_active_model();
    let (inserted_count, completed_run_duration_secs) = if candidates.is_empty()
    {
        let now = Utc::now().fixed_offset();
        run_active.prepared_at = Set(Some(now));
        let completed_run_duration_secs =
            if run_active.item_count.as_ref() == &0 {
                run_active.completed_at = Set(Some(now));
                Some(
                    now.signed_duration_since(run.created_at).num_milliseconds()
                        as f64
                        / 1_000.0,
                )
            } else {
                None
            };
        run_active
            .update(&transaction)
            .await
            .context("finalize analysis preparation")?;
        (0, completed_run_duration_secs)
    } else {
        let inserted = file_analysis_run_item::Entity::insert_many(
            candidates.into_iter().map(|candidate| {
                file_analysis_run_item::ActiveModel {
                    id: Set(*run_active.id.as_ref()),
                    file_id: Set(candidate.file_id),
                    metadata_revision: Set(candidate.metadata_revision),
                    lease_token: Set(None),
                    lease_expires_at: Set(None),
                    result_tag_ids: Set(None),
                    completed_at: Set(None),
                }
            }),
        )
        .on_conflict(
            OnConflict::columns([
                file_analysis_run_item::Column::Id,
                file_analysis_run_item::Column::FileId,
            ])
            .do_nothing()
            .to_owned(),
        )
        .exec_without_returning(&transaction)
        .await
        .context("materialize analysis run items")?;
        let item_count = run_active
            .item_count
            .as_ref()
            .checked_add(i64::try_from(inserted)?)
            .ok_or_else(|| anyhow::anyhow!("analysis item count overflow"))?;
        run_active.item_count = Set(item_count);
        run_active
            .update(&transaction)
            .await
            .context("increment analysis item count")?;
        (u64::try_from(inserted)?, None)
    };
    transaction
        .commit()
        .await
        .context("commit analysis preparation")?;
    Ok(PreparationResult {
        did_work: true,
        inserted_count,
        completed_run_duration_secs,
    })
}

pub(super) async fn claim_analysis_batch(
    db: &DatabaseConnection,
    batch_size: u64,
    lease_duration_secs: i64,
) -> Result<Vec<ClaimedAnalysisFile>> {
    let lease_token = Uuid::new_v4();
    // Selection with SKIP LOCKED and the lease UPDATE ... RETURNING must be
    // one statement; splitting them into SeaORM reads and writes would let
    // concurrent workers claim the same item.
    ClaimedAnalysisFile::find_by_statement(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"
            with candidate_run as materialized (
                select run.id, run.run_sequence, run.definition_id
                from file_analysis_run as run
                join file_analysis_definition as definition
                  on definition.id = run.definition_id
                where run.prepared_at is not null
                  and run.completed_at is null
                  and definition.analyzer_version = $1
                  and definition.dsl_version = $2
                  and exists (
                    select 1
                    from file_analysis_run_item as candidate_item
                    where candidate_item.id = run.id
                      and candidate_item.completed_at is null
                      and (
                        candidate_item.lease_token is null
                        or candidate_item.lease_expires_at
                            <= clock_timestamp()
                      )
                  )
                order by run.run_sequence
                for update of run skip locked
                limit 1
            ),
            claimed as materialized (
                select item.id, item.file_id
                from file_analysis_run_item as item
                join candidate_run as run on run.id = item.id
                where item.completed_at is null
                  and (
                    item.lease_token is null
                    or item.lease_expires_at <= clock_timestamp()
                  )
                order by item.file_id
                for update of item skip locked
                limit $3
            ),
            updated as (
                update file_analysis_run_item as item
                set lease_token = $4,
                    lease_expires_at = clock_timestamp()
                        + make_interval(secs => $5)
                from claimed
                where item.id = claimed.id
                  and item.file_id = claimed.file_id
                returning
                    item.id,
                    item.file_id,
                    item.metadata_revision,
                    item.lease_token
            )
            select
                updated.id as run_id,
                run.run_sequence,
                run.definition_id,
                updated.file_id,
                updated.metadata_revision,
                input.name,
                input.absolute_path,
                input.extension,
                updated.lease_token
            from updated
            join candidate_run as run on run.id = updated.id
            join file_metadata_revision as target
              on target.id = updated.file_id
             and target.revision = updated.metadata_revision
            join file_metadata_revision as input
              on input.id = target.id
             and input.revision = target.analysis_input_revision
            order by updated.file_id
        "#,
        [
            ANALYZER_VERSION.into(),
            DSL_VERSION.into(),
            i64::try_from(batch_size)?.into(),
            lease_token.into(),
            lease_duration_secs.into(),
        ],
    ))
    .all(db)
    .await
    .context("claim file analysis items")
}

#[derive(Serialize)]
struct CompletionPayload<'a> {
    run_id: Uuid,
    file_id: Uuid,
    metadata_revision: i64,
    result_tag_ids: &'a [Uuid],
}

pub(super) async fn complete_analysis_batch(
    db: &DatabaseConnection,
    lease_token: Uuid,
    completed: &[CompletedAnalysisFile],
) -> Result<CompletionResult> {
    if completed.is_empty() {
        return Ok(CompletionResult {
            completed_count: 0,
            published_count: 0,
            result_write_duration_secs: 0.0,
            current_publish_duration_secs: 0.0,
            run_completion_duration_secs: None,
        });
    }
    let payload = completed
        .iter()
        .map(|item| CompletionPayload {
            run_id: item.run_id,
            file_id: item.file_id,
            metadata_revision: item.metadata_revision,
            result_tag_ids: &item.matched_tag_ids,
        })
        .collect::<Vec<_>>();
    let payload = serde_json::to_string(&payload)?;
    // The immutable result write, current projection reconciliation, and run
    // counters must commit as one data-modifying CTE under the exact lease.
    // SeaORM's entity APIs cannot connect those returned row sets atomically.
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"
                with input as materialized (
                    select
                        value->>'run_id' as run_id_text,
                        value->>'file_id' as file_id_text,
                        (value->>'metadata_revision')::bigint
                            as metadata_revision,
                        coalesce(
                            array(
                                select jsonb_array_elements_text(
                                    value->'result_tag_ids'
                                )::uuid
                            ),
                            array[]::uuid[]
                        ) as result_tag_ids
                    from jsonb_array_elements($1::jsonb) as value
                ),
                typed_input as materialized (
                    select
                        run_id_text::uuid as run_id,
                        file_id_text::uuid as file_id,
                        metadata_revision,
                        result_tag_ids
                    from input
                ),
                operation_started as materialized (
                    select clock_timestamp() as started_at
                ),
                locked_items as materialized (
                    select
                        item.id as run_id,
                        item.file_id,
                        item.metadata_revision,
                        payload.result_tag_ids
                    from file_analysis_run_item as item
                    join typed_input as payload
                      on payload.run_id = item.id
                     and payload.file_id = item.file_id
                     and payload.metadata_revision = item.metadata_revision
                    where item.lease_token = $2
                      and item.completed_at is null
                    order by item.id, item.file_id
                    for update of item
                ),
                completed_items as (
                    update file_analysis_run_item as item
                    set result_tag_ids = locked.result_tag_ids,
                        completed_at = clock_timestamp(),
                        lease_token = null,
                        lease_expires_at = null
                    from locked_items as locked
                    cross join operation_started
                    where item.id = locked.run_id
                      and item.file_id = locked.file_id
                      and item.lease_token = $2
                      and item.completed_at is null
                    returning
                        item.id as run_id,
                        item.file_id,
                        item.metadata_revision,
                        item.result_tag_ids
                ),
                result_write_finished as materialized (
                    select
                        clock_timestamp() as finished_at,
                        (
                            select started_at
                            from operation_started
                        ) as started_at,
                        count(*)::bigint as completed_count
                    from completed_items
                ),
                locked_files as materialized (
                    select file.id
                    from file_entry as file
                    join completed_items as item on item.file_id = file.id
                    cross join result_write_finished
                    order by file.id
                    for update of file
                ),
                published_files as (
                    update file_entry as file
                    set current_analysis_run_id = item.run_id
                    from completed_items as item
                    join locked_files on locked_files.id = item.file_id
                    join file_analysis_run as new_run
                      on new_run.id = item.run_id
                    join file_metadata_revision as target
                      on target.id = item.file_id
                     and target.revision = item.metadata_revision
                    where file.id = item.file_id
                      and file.analysis_input_revision =
                          target.analysis_input_revision
                      and (
                        file.current_analysis_run_id is null
                        or (
                            select current_run.run_sequence
                            from file_analysis_run as current_run
                            where current_run.id =
                                file.current_analysis_run_id
                        ) <= new_run.run_sequence
                      )
                    returning
                        file.id as file_id,
                        file.device_id,
                        file.created_at,
                        item.result_tag_ids
                ),
                active_result_tags as materialized (
                    select
                        published.file_id,
                        tag.id as tag_id
                    from published_files as published
                    cross join lateral unnest(
                        published.result_tag_ids
                    ) as result_tag_id
                    join analytics_tag as tag
                      on tag.id = result_tag_id
                     and tag.archived_at is null
                    order by tag.id
                    for key share of tag
                ),
                deleted_links as (
                    delete from device_file_tag as link
                    using published_files as published
                    where link.file_entry_id = published.file_id
                      and not exists (
                        select 1
                        from active_result_tags as active
                        where active.file_id = published.file_id
                          and active.tag_id = link.tag_id
                      )
                    returning link.id
                ),
                inserted_links as (
                    insert into device_file_tag (
                        id,
                        file_entry_id,
                        device_id,
                        file_entry_created_at,
                        tag_id,
                        created_at,
                        updated_at
                    )
                    select
                        uuid_generate_v7(),
                        published.file_id,
                        published.device_id,
                        published.created_at,
                        active.tag_id,
                        clock_timestamp(),
                        clock_timestamp()
                    from published_files as published
                    join active_result_tags as active
                      on active.file_id = published.file_id
                    on conflict (file_entry_id, tag_id) do nothing
                    returning id
                ),
                current_publish_counts as materialized (
                    select
                        (select count(*) from published_files)::bigint
                            as published_count,
                        (select count(*) from deleted_links)::bigint
                            as deleted_link_count,
                        (select count(*) from inserted_links)::bigint
                            as inserted_link_count
                ),
                current_publish_finished as materialized (
                    select
                        result.finished_at as started_at,
                        clock_timestamp() as finished_at,
                        publish.published_count,
                        publish.deleted_link_count,
                        publish.inserted_link_count
                    from current_publish_counts as publish
                    cross join result_write_finished as result
                ),
                completed_by_run as materialized (
                    select run_id as id, count(*)::bigint as completed_count
                    from completed_items
                    group by run_id
                ),
                updated_runs as (
                    update file_analysis_run as run
                    set completed_count =
                            run.completed_count + delta.completed_count,
                        completed_at = case
                            when run.completed_count + delta.completed_count
                                = run.item_count
                                then clock_timestamp()
                            else run.completed_at
                        end
                    from completed_by_run as delta
                    where run.id = delta.id
                    returning run.id, run.created_at, run.completed_at
                )
                select
                    (select count(*) from typed_input) as expected_count,
                    (
                        select completed_count
                        from result_write_finished
                    ) as completed_count,
                    (
                        select published_count
                        from current_publish_finished
                    ) as published_count,
                    (
                        select extract(
                            epoch from finished_at - started_at
                        )::double precision
                        from result_write_finished
                    ) as result_write_duration_secs,
                    (
                        select extract(
                            epoch from finished_at - started_at
                        )::double precision
                        from current_publish_finished
                    ) as current_publish_duration_secs,
                    (
                        select extract(
                            epoch from completed_at - created_at
                        )::double precision
                        from updated_runs
                        where completed_at is not null
                        limit 1
                    ) as run_completion_duration_secs,
                    (
                        select deleted_link_count
                        from current_publish_finished
                    ) as deleted_link_count,
                    (
                        select inserted_link_count
                        from current_publish_finished
                    ) as inserted_link_count,
                    (select count(*) from updated_runs) as updated_run_count
            "#,
            [payload.into(), lease_token.into()],
        ))
        .await
        .context("commit file analysis results")?
        .ok_or_else(|| {
            anyhow::anyhow!("file analysis completion counts missing")
        })?;
    let expected_count: i64 = row.try_get("", "expected_count")?;
    let completed_count: i64 = row.try_get("", "completed_count")?;
    let published_count: i64 = row.try_get("", "published_count")?;
    let result_write_duration_secs: f64 =
        row.try_get("", "result_write_duration_secs")?;
    let current_publish_duration_secs: f64 =
        row.try_get("", "current_publish_duration_secs")?;
    let run_completion_duration_secs: Option<f64> =
        row.try_get("", "run_completion_duration_secs")?;
    if expected_count != completed_count {
        return Err(anyhow::anyhow!(
            "file analysis lease lost for {} of {} items",
            expected_count - completed_count,
            expected_count
        ));
    }
    Ok(CompletionResult {
        completed_count: u64::try_from(completed_count)?,
        published_count: u64::try_from(published_count)?,
        result_write_duration_secs,
        current_publish_duration_secs,
        run_completion_duration_secs,
    })
}

pub(super) async fn release_analysis_batch(
    db: &DatabaseConnection,
    lease_token: Uuid,
) -> Result<u64, DbErr> {
    let result = file_analysis_run_item::Entity::update_many()
        .col_expr(
            file_analysis_run_item::Column::LeaseToken,
            Expr::value(Option::<Uuid>::None),
        )
        .col_expr(
            file_analysis_run_item::Column::LeaseExpiresAt,
            Expr::value(Option::<chrono::DateTime<chrono::FixedOffset>>::None),
        )
        .filter(file_analysis_run_item::Column::LeaseToken.eq(lease_token))
        .filter(file_analysis_run_item::Column::CompletedAt.is_null())
        .exec(db)
        .await?;
    Ok(result.rows_affected)
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct OperationalSnapshot {
    pub sync_runs: u64,
    pub manual_runs: u64,
    pub preparing_runs: u64,
    pub running_runs: u64,
    pub completed_runs: u64,
    pub active_leases: u64,
    pub expired_leases: u64,
    pub oldest_preparing_age_secs: f64,
    pub oldest_running_age_secs: f64,
    pub unsupported_nonterminal_runs: u64,
}

pub(super) async fn load_operational_snapshot(
    db: &DatabaseConnection,
) -> Result<OperationalSnapshot, DbErr> {
    let sync_runs = file_analysis_run::Entity::find()
        .filter(file_analysis_run::Column::SyncId.is_not_null())
        .count(db)
        .await?;
    let manual_runs = file_analysis_run::Entity::find()
        .filter(file_analysis_run::Column::SyncId.is_null())
        .count(db)
        .await?;
    let preparing_runs = file_analysis_run::Entity::find()
        .filter(file_analysis_run::Column::PreparedAt.is_null())
        .count(db)
        .await?;
    let running_runs = file_analysis_run::Entity::find()
        .filter(file_analysis_run::Column::PreparedAt.is_not_null())
        .filter(file_analysis_run::Column::CompletedAt.is_null())
        .count(db)
        .await?;
    let completed_runs = file_analysis_run::Entity::find()
        .filter(file_analysis_run::Column::CompletedAt.is_not_null())
        .count(db)
        .await?;

    let now = Utc::now().fixed_offset();
    let active_leases = file_analysis_run_item::Entity::find()
        .filter(file_analysis_run_item::Column::CompletedAt.is_null())
        .filter(file_analysis_run_item::Column::LeaseToken.is_not_null())
        .filter(file_analysis_run_item::Column::LeaseExpiresAt.gt(now))
        .count(db)
        .await?;
    let expired_leases = file_analysis_run_item::Entity::find()
        .filter(file_analysis_run_item::Column::CompletedAt.is_null())
        .filter(file_analysis_run_item::Column::LeaseToken.is_not_null())
        .filter(file_analysis_run_item::Column::LeaseExpiresAt.lte(now))
        .count(db)
        .await?;

    let oldest_preparing_created_at = file_analysis_run::Entity::find()
        .select_only()
        .column(file_analysis_run::Column::CreatedAt)
        .filter(file_analysis_run::Column::PreparedAt.is_null())
        .order_by_asc(file_analysis_run::Column::CreatedAt)
        .into_tuple::<DateTime<FixedOffset>>()
        .one(db)
        .await?;
    let oldest_running_created_at = file_analysis_run::Entity::find()
        .select_only()
        .column(file_analysis_run::Column::CreatedAt)
        .filter(file_analysis_run::Column::PreparedAt.is_not_null())
        .filter(file_analysis_run::Column::CompletedAt.is_null())
        .order_by_asc(file_analysis_run::Column::CreatedAt)
        .into_tuple::<DateTime<FixedOffset>>()
        .one(db)
        .await?;
    let age_secs = |created_at: Option<DateTime<FixedOffset>>| {
        created_at.map_or(0.0, |created_at| {
            std::cmp::max(
                now.signed_duration_since(created_at).num_milliseconds(),
                0,
            ) as f64
                / 1_000.0
        })
    };

    let unsupported_definition_ids = file_analysis_definition::Entity::find()
        .select_only()
        .column(file_analysis_definition::Column::Id)
        .filter(
            Condition::any()
                .add(
                    file_analysis_definition::Column::AnalyzerVersion
                        .ne(ANALYZER_VERSION),
                )
                .add(
                    file_analysis_definition::Column::DslVersion
                        .ne(DSL_VERSION),
                ),
        )
        .into_tuple::<Uuid>()
        .all(db)
        .await?;
    let unsupported_nonterminal_runs = if unsupported_definition_ids.is_empty()
    {
        0
    } else {
        file_analysis_run::Entity::find()
            .filter(file_analysis_run::Column::CompletedAt.is_null())
            .filter(
                file_analysis_run::Column::DefinitionId
                    .is_in(unsupported_definition_ids),
            )
            .count(db)
            .await?
    };

    Ok(OperationalSnapshot {
        sync_runs,
        manual_runs,
        preparing_runs,
        running_runs,
        completed_runs,
        active_leases,
        expired_leases,
        oldest_preparing_age_secs: age_secs(oldest_preparing_created_at),
        oldest_running_age_secs: age_secs(oldest_running_created_at),
        unsupported_nonterminal_runs,
    })
}

pub(super) fn run_status(run: &file_analysis_run::Model) -> &'static str {
    if run.completed_at.is_some() {
        "completed"
    } else if run.prepared_at.is_some() {
        "running"
    } else {
        "preparing"
    }
}
