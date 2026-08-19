use super::types::{
    DeviceAnalyticsFileLink, DeviceAnalyticsProgress, DeviceAnalyticsSummary,
    RuleExpression, TagRuleDefinition,
};
use crate::file_registry::entities::{
    analytics_tag, analytics_tag_test_file, device_file_tag,
    file_analysis_definition, file_analysis_run, file_analysis_run_item,
    file_entry, file_revision,
    sea_orm_active_enums::{
        FileEntryKind, SourceFileStateKind as DbSourceFileStateKind,
    },
};
use chrono::{DateTime, FixedOffset, Utc};
use sea_orm::{
    AccessMode, ActiveModelTrait, ColumnTrait, Condition, ConnectionTrait,
    DatabaseConnection, DatabaseTransaction, DbErr, EntityTrait,
    FromQueryResult, IntoActiveModel, IsolationLevel, JoinType, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect, QueryTrait, RelationTrait, Set,
    TransactionTrait,
};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

#[derive(Debug, Eq, PartialEq)]
pub(super) struct PreparedRuleTestFile {
    pub name: String,
    pub absolute_path: String,
    pub extension: Option<String>,
    pub expected_match: bool,
}

pub(super) async fn list_tags<C>(
    file_db: &C,
) -> Result<Vec<analytics_tag::Model>, DbErr>
where
    C: ConnectionTrait,
{
    analytics_tag::Entity::find().all(file_db).await
}

pub(super) async fn find_tag<C>(
    file_db: &C,
    tag_id: Uuid,
) -> Result<Option<analytics_tag::Model>, DbErr>
where
    C: ConnectionTrait,
{
    analytics_tag::Entity::find_by_id(tag_id).one(file_db).await
}

pub(super) async fn list_tag_test_files<C>(
    file_db: &C,
    tag_id: Uuid,
) -> Result<Vec<analytics_tag_test_file::Model>, DbErr>
where
    C: ConnectionTrait,
{
    analytics_tag_test_file::Entity::find()
        .filter(analytics_tag_test_file::Column::TagId.eq(tag_id))
        .order_by_asc(analytics_tag_test_file::Column::Position)
        .all(file_db)
        .await
}

pub(super) async fn replace_tag_test_files(
    transaction: &DatabaseTransaction,
    tag_id: Uuid,
    files: &[PreparedRuleTestFile],
) -> Result<(), DbErr> {
    analytics_tag_test_file::Entity::delete_many()
        .filter(analytics_tag_test_file::Column::TagId.eq(tag_id))
        .exec(transaction)
        .await?;

    if files.is_empty() {
        return Ok(());
    }

    let now = Utc::now().fixed_offset();
    let files = files.iter().enumerate().map(|(position, file)| {
        analytics_tag_test_file::ActiveModel {
            id: Set(Uuid::now_v7()),
            tag_id: Set(tag_id),
            position: Set(position as i32),
            name: Set(file.name.clone()),
            absolute_path: Set(file.absolute_path.clone()),
            extension: Set(file.extension.clone()),
            expected_match: Set(file.expected_match),
            created_at: Set(now),
            updated_at: Set(now),
        }
    });
    analytics_tag_test_file::Entity::insert_many(files)
        .exec(transaction)
        .await?;
    Ok(())
}

pub(super) async fn lock_tag(
    transaction: &DatabaseTransaction,
    tag_id: Uuid,
) -> Result<Option<analytics_tag::Model>, DbErr> {
    analytics_tag::Entity::find_by_id(tag_id)
        .lock_exclusive()
        .one(transaction)
        .await
}

pub(super) async fn create_tag(
    file_db: &DatabaseConnection,
    tag_id: Uuid,
    name: String,
) -> Result<analytics_tag::Model, DbErr> {
    let now = Utc::now().fixed_offset();
    analytics_tag::ActiveModel {
        id: Set(tag_id),
        name: Set(name),
        rule_expression: Set(None),
        archived_at: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(file_db)
    .await
}

pub(super) async fn update_tag_name(
    file_db: &DatabaseConnection,
    tag: analytics_tag::Model,
    name: String,
) -> Result<analytics_tag::Model, DbErr> {
    let mut tag = tag.into_active_model();
    tag.name = Set(name);
    tag.updated_at = Set(Utc::now().fixed_offset());
    tag.update(file_db).await
}

pub(super) async fn save_tag_rule(
    transaction: &DatabaseTransaction,
    tag: analytics_tag::Model,
    rule_expression: Option<serde_json::Value>,
) -> Result<analytics_tag::Model, DbErr> {
    let mut tag = tag.into_active_model();
    tag.rule_expression = Set(rule_expression);
    tag.updated_at = Set(Utc::now().fixed_offset());
    tag.update(transaction).await
}

pub(super) async fn archive_tag(
    transaction: &DatabaseTransaction,
    tag: analytics_tag::Model,
) -> Result<analytics_tag::Model, DbErr> {
    device_file_tag::Entity::delete_many()
        .filter(device_file_tag::Column::TagId.eq(tag.id))
        .exec(transaction)
        .await?;
    let mut tag = tag.into_active_model();
    let now = Utc::now().fixed_offset();
    tag.archived_at = Set(Some(now));
    tag.updated_at = Set(now);
    tag.update(transaction).await
}

pub(super) async fn restore_tag(
    transaction: &DatabaseTransaction,
    tag: analytics_tag::Model,
) -> Result<analytics_tag::Model, DbErr> {
    let mut tag = tag.into_active_model();
    tag.archived_at = Set(None);
    tag.updated_at = Set(Utc::now().fixed_offset());
    tag.update(transaction).await
}

pub(in crate::devices) async fn list_active_tags<C>(
    file_db: &C,
) -> Result<Vec<analytics_tag::Model>, DbErr>
where
    C: ConnectionTrait,
{
    analytics_tag::Entity::find()
        .filter(analytics_tag::Column::ArchivedAt.is_null())
        .all(file_db)
        .await
}

pub(super) async fn load_active_rule_definitions<C>(
    file_db: &C,
) -> Result<Vec<TagRuleDefinition>, DbErr>
where
    C: ConnectionTrait,
{
    let tags = analytics_tag::Entity::find()
        .filter(analytics_tag::Column::ArchivedAt.is_null())
        .filter(analytics_tag::Column::RuleExpression.is_not_null())
        .order_by_asc(analytics_tag::Column::Id)
        .all(file_db)
        .await?;
    tags.into_iter()
        .map(|tag| {
            let expression = tag.rule_expression.ok_or_else(|| {
                DbErr::Custom("active rule expression is missing".to_owned())
            })?;
            let rule_expression =
                serde_json::from_value::<RuleExpression>(expression)
                    .map_err(|error| DbErr::Custom(error.to_string()))?;
            Ok(TagRuleDefinition {
                tag_id: tag.id,
                rule_expression,
            })
        })
        .collect()
}

pub(in crate::devices) async fn load_active_tags_for_files<C>(
    file_db: &C,
    file_entry_ids: &[Uuid],
) -> Result<BTreeMap<Uuid, Vec<analytics_tag::Model>>, DbErr>
where
    C: ConnectionTrait,
{
    if file_entry_ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let rows = device_file_tag::Entity::find()
        .find_also_related(analytics_tag::Entity)
        .filter(
            device_file_tag::Column::FileEntryId
                .is_in(file_entry_ids.iter().copied()),
        )
        .filter(analytics_tag::Column::ArchivedAt.is_null())
        .all(file_db)
        .await?;
    let mut tags_by_file = BTreeMap::<Uuid, Vec<analytics_tag::Model>>::new();
    for (link, tag) in rows {
        if let Some(tag) = tag {
            tags_by_file
                .entry(link.file_entry_id)
                .or_default()
                .push(tag);
        }
    }
    for tags in tags_by_file.values_mut() {
        tags.sort_by(|left, right| {
            left.name
                .cmp(&right.name)
                .then_with(|| left.id.cmp(&right.id))
        });
        tags.dedup_by_key(|tag| tag.id);
    }
    Ok(tags_by_file)
}

pub(in crate::devices) async fn load_active_tag_memberships<C>(
    file_db: &C,
    file_entry_ids: &[Uuid],
) -> Result<BTreeMap<Uuid, BTreeSet<Uuid>>, DbErr>
where
    C: ConnectionTrait,
{
    Ok(load_active_tags_for_files(file_db, file_entry_ids)
        .await?
        .into_iter()
        .map(|(file_id, tags)| {
            (file_id, tags.into_iter().map(|tag| tag.id).collect())
        })
        .collect())
}

pub(in crate::devices) async fn find_active_tag_ids<C>(
    file_db: &C,
    tag_ids: &[Uuid],
) -> Result<BTreeSet<Uuid>, DbErr>
where
    C: ConnectionTrait,
{
    if tag_ids.is_empty() {
        return Ok(BTreeSet::new());
    }
    analytics_tag::Entity::find()
        .select_only()
        .column(analytics_tag::Column::Id)
        .filter(analytics_tag::Column::Id.is_in(tag_ids.iter().copied()))
        .filter(analytics_tag::Column::ArchivedAt.is_null())
        .into_tuple::<Uuid>()
        .all(file_db)
        .await
        .map(|ids| ids.into_iter().collect())
}

#[derive(Debug, FromQueryResult)]
struct SummaryRow {
    tag_id: Uuid,
    tag_name: String,
    file_count: i64,
    latest_file_entry_created_at: DateTime<FixedOffset>,
}

pub(super) async fn device_summary(
    file_db: &DatabaseConnection,
    device_id: Uuid,
) -> Result<DeviceAnalyticsProgress, DbErr> {
    let transaction = file_db
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(AccessMode::ReadOnly),
        )
        .await?;
    let total_file_count = file_entry::Entity::find()
        .filter(file_entry::Column::DeviceId.eq(device_id))
        .filter(file_entry::Column::Kind.eq(FileEntryKind::File))
        .count(&transaction)
        .await?;
    let analyzed_file_count = file_entry::Entity::find()
        .filter(file_entry::Column::DeviceId.eq(device_id))
        .filter(file_entry::Column::Kind.eq(FileEntryKind::File))
        .filter(file_entry::Column::CurrentAnalysisRunId.is_not_null())
        .count(&transaction)
        .await?;
    let items = device_summary_items(&transaction, device_id).await?;
    transaction.commit().await?;
    Ok(DeviceAnalyticsProgress {
        total_file_count,
        analyzed_file_count,
        items,
    })
}

async fn device_summary_items<C>(
    file_db: &C,
    device_id: Uuid,
) -> Result<Vec<DeviceAnalyticsSummary>, DbErr>
where
    C: ConnectionTrait,
{
    analytics_tag::Entity::find()
        .select_only()
        .column_as(analytics_tag::Column::Id, "tag_id")
        .column_as(analytics_tag::Column::Name, "tag_name")
        .column_as(device_file_tag::Column::Id.count(), "file_count")
        .column_as(
            device_file_tag::Column::FileEntryCreatedAt.max(),
            "latest_file_entry_created_at",
        )
        .join(
            JoinType::InnerJoin,
            analytics_tag::Relation::DeviceFileTag.def(),
        )
        .filter(analytics_tag::Column::ArchivedAt.is_null())
        .filter(device_file_tag::Column::DeviceId.eq(device_id))
        .group_by(analytics_tag::Column::Id)
        .group_by(analytics_tag::Column::Name)
        .into_model::<SummaryRow>()
        .all(file_db)
        .await
        .map(|rows| {
            rows.into_iter()
                .map(|row| DeviceAnalyticsSummary {
                    tag_id: row.tag_id,
                    tag_name: row.tag_name,
                    file_count: row.file_count.try_into().unwrap_or_default(),
                    latest_file_entry_created_at: row
                        .latest_file_entry_created_at,
                })
                .collect()
        })
}

pub(super) async fn find_active_tag<C>(
    file_db: &C,
    tag_id: Uuid,
) -> Result<Option<analytics_tag::Model>, DbErr>
where
    C: ConnectionTrait,
{
    analytics_tag::Entity::find_by_id(tag_id)
        .filter(analytics_tag::Column::ArchivedAt.is_null())
        .one(file_db)
        .await
}

pub(super) async fn resolve_file_link_cursor(
    file_db: &DatabaseConnection,
    device_id: Uuid,
    tag_id: Uuid,
    file_entry_id: Uuid,
) -> Result<Option<DeviceAnalyticsFileLink>, DbErr> {
    device_file_tag::Entity::find()
        .filter(device_file_tag::Column::DeviceId.eq(device_id))
        .filter(device_file_tag::Column::TagId.eq(tag_id))
        .filter(device_file_tag::Column::FileEntryId.eq(file_entry_id))
        .one(file_db)
        .await
        .map(|link| {
            link.map(|link| DeviceAnalyticsFileLink {
                file_entry_id: link.file_entry_id,
                file_entry_created_at: link.file_entry_created_at,
            })
        })
}

pub(super) async fn list_file_links(
    file_db: &DatabaseConnection,
    device_id: Uuid,
    tag_id: Uuid,
    after: Option<&DeviceAnalyticsFileLink>,
    limit: u64,
) -> Result<Vec<DeviceAnalyticsFileLink>, DbErr> {
    device_file_tag::Entity::find()
        .filter(device_file_tag::Column::DeviceId.eq(device_id))
        .filter(device_file_tag::Column::TagId.eq(tag_id))
        .apply_if(after, |query, after| {
            query.filter(
                Condition::any()
                    .add(
                        device_file_tag::Column::FileEntryCreatedAt
                            .lt(after.file_entry_created_at),
                    )
                    .add(
                        Condition::all()
                            .add(
                                device_file_tag::Column::FileEntryCreatedAt
                                    .eq(after.file_entry_created_at),
                            )
                            .add(
                                device_file_tag::Column::FileEntryId
                                    .lt(after.file_entry_id),
                            ),
                    ),
            )
        })
        .order_by_desc(device_file_tag::Column::FileEntryCreatedAt)
        .order_by_desc(device_file_tag::Column::FileEntryId)
        .limit(limit)
        .all(file_db)
        .await
        .map(|links| {
            links
                .into_iter()
                .map(|link| DeviceAnalyticsFileLink {
                    file_entry_id: link.file_entry_id,
                    file_entry_created_at: link.file_entry_created_at,
                })
                .collect()
        })
}

pub(super) async fn load_current_files(
    file_db: &DatabaseConnection,
    device_id: Uuid,
    file_entry_ids: &[Uuid],
) -> Result<BTreeMap<Uuid, file_entry::Model>, DbErr> {
    if file_entry_ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    file_entry::Entity::find()
        .filter(file_entry::Column::Id.is_in(file_entry_ids.iter().copied()))
        .filter(file_entry::Column::DeviceId.eq(device_id))
        .filter(file_entry::Column::Kind.eq(FileEntryKind::File))
        .all(file_db)
        .await
        .map(|files| files.into_iter().map(|file| (file.id, file)).collect())
}

pub(super) async fn find_analysis_run<C>(
    file_db: &C,
    run_id: Uuid,
) -> Result<
    Option<(file_analysis_run::Model, file_analysis_definition::Model)>,
    DbErr,
>
where
    C: ConnectionTrait,
{
    file_analysis_run::Entity::find_by_id(run_id)
        .find_also_related(file_analysis_definition::Entity)
        .one(file_db)
        .await?
        .map(|(run, definition)| {
            definition
                .map(|definition| (run, definition))
                .ok_or_else(|| {
                    DbErr::RecordNotFound("file_analysis_definition".to_owned())
                })
        })
        .transpose()
}

pub(super) async fn list_analysis_runs<C>(
    file_db: &C,
    device_id: Uuid,
    before_run_sequence: Option<i64>,
    limit: u64,
) -> Result<
    Vec<(file_analysis_run::Model, file_analysis_definition::Model)>,
    DbErr,
>
where
    C: ConnectionTrait,
{
    let mut query = file_analysis_run::Entity::find()
        .find_also_related(file_analysis_definition::Entity)
        .filter(file_analysis_run::Column::DeviceId.eq(device_id))
        .order_by_desc(file_analysis_run::Column::RunSequence)
        .limit(limit);
    if let Some(before_run_sequence) = before_run_sequence {
        query = query.filter(
            file_analysis_run::Column::RunSequence.lt(before_run_sequence),
        );
    }
    query
        .all(file_db)
        .await?
        .into_iter()
        .map(|(run, definition)| {
            definition
                .map(|definition| (run, definition))
                .ok_or_else(|| {
                    DbErr::RecordNotFound("file_analysis_definition".to_owned())
                })
        })
        .collect()
}

#[derive(Debug)]
pub(super) struct AnalysisRunFileRow {
    pub file_id: Uuid,
    pub metadata_revision: i64,
    pub analysis_input_revision: i64,
    pub state: String,
    pub name: String,
    pub absolute_path: String,
    pub extension: Option<String>,
    pub mime_type: Option<String>,
    pub file_metadata_created_at: Option<DateTime<FixedOffset>>,
    pub file_metadata_modified_at: Option<DateTime<FixedOffset>>,
    pub source_file_state: Option<String>,
    pub tag_ids: Option<Vec<Uuid>>,
}

pub(super) async fn list_analysis_run_files<C>(
    file_db: &C,
    run_id: Uuid,
    after_file_id: Option<Uuid>,
    limit: u64,
) -> Result<Vec<AnalysisRunFileRow>, DbErr>
where
    C: ConnectionTrait,
{
    let now = Utc::now().fixed_offset();
    file_analysis_run_item::Entity::find()
        .find_also_related(file_revision::Entity)
        .filter(file_analysis_run_item::Column::Id.eq(run_id))
        .filter(
            file_analysis_run_item::Column::FileId
                .gt(after_file_id.unwrap_or(Uuid::nil())),
        )
        .order_by_asc(file_analysis_run_item::Column::FileId)
        .limit(limit)
        .all(file_db)
        .await?
        .into_iter()
        .map(|(item, metadata)| {
            let metadata = metadata.ok_or_else(|| {
                DbErr::RecordNotFound("file_revision".to_owned())
            })?;
            let state = if item.completed_at.is_some() {
                "completed"
            } else if item.lease_token.is_some()
                && item
                    .lease_expires_at
                    .is_some_and(|lease_expires_at| lease_expires_at > now)
            {
                "processing"
            } else {
                "pending"
            };
            let source_file_state =
                metadata.source_file_state.map(|source_file_state| {
                    match source_file_state {
                        DbSourceFileStateKind::Scanned => "scanned",
                        DbSourceFileStateKind::Downloaded => "downloaded",
                        DbSourceFileStateKind::Changed => "changed",
                    }
                    .to_owned()
                });
            Ok(AnalysisRunFileRow {
                file_id: item.file_id,
                metadata_revision: item.metadata_revision,
                analysis_input_revision: metadata.analysis_input_revision,
                state: state.to_owned(),
                name: metadata.name,
                absolute_path: metadata.absolute_path,
                extension: metadata.extension,
                mime_type: metadata.mime_type,
                file_metadata_created_at: metadata.file_metadata_created_at,
                file_metadata_modified_at: metadata.file_metadata_modified_at,
                source_file_state,
                tag_ids: item.result_tag_ids,
            })
        })
        .collect()
}
