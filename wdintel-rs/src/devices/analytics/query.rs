use super::types::{
    ActiveTagRule, DeviceAnalyticsFileLink, DeviceAnalyticsSummary,
};
use crate::entities::{
    analytics_tag, analytics_tag_rule_set_state, analytics_tag_test_file,
    device_file_tag,
};
use crate::file_registry::entities::{
    file_entry, sea_orm_active_enums::FileEntryKind,
};
use chrono::{DateTime, FixedOffset, Utc};
use sea_orm::sea_query::{Expr, LockBehavior, LockType};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, ConnectionTrait,
    DatabaseConnection, DatabaseTransaction, DbErr, EntityTrait,
    FromQueryResult, IntoActiveModel, JoinType, QueryFilter, QueryOrder,
    QuerySelect, QueryTrait, RelationTrait, Select, Set,
};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use uuid::Uuid;

const LINK_INSERT_CHUNK_SIZE: usize = 1_000;
const LINK_DELETE_CHUNK_SIZE: usize = 1_000;

pub(super) struct FileTagAssignment {
    pub file_entry_id: Uuid,
    pub device_id: Uuid,
    pub file_entry_created_at: DateTime<FixedOffset>,
    pub tag_id: Uuid,
}

#[derive(Debug, Default, Eq, PartialEq)]
pub(super) struct FileTagDelta {
    pub inserted: usize,
    pub deleted: usize,
    pub unchanged: usize,
}

pub(super) async fn list_tags<C>(
    main_db: &C,
) -> Result<Vec<analytics_tag::Model>, DbErr>
where
    C: ConnectionTrait,
{
    analytics_tag::Entity::find().all(main_db).await
}

pub(super) async fn find_tag<C>(
    main_db: &C,
    tag_id: Uuid,
) -> Result<Option<analytics_tag::Model>, DbErr>
where
    C: ConnectionTrait,
{
    analytics_tag::Entity::find_by_id(tag_id).one(main_db).await
}

pub(super) async fn list_tag_test_files<C>(
    main_db: &C,
    tag_id: Uuid,
) -> Result<Vec<analytics_tag_test_file::Model>, DbErr>
where
    C: ConnectionTrait,
{
    analytics_tag_test_file::Entity::find()
        .filter(analytics_tag_test_file::Column::TagId.eq(tag_id))
        .order_by_asc(analytics_tag_test_file::Column::Position)
        .all(main_db)
        .await
}

pub(super) async fn replace_tag_test_files(
    transaction: &DatabaseTransaction,
    tag_id: Uuid,
    files: &[super::types::RuleTestFile],
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

pub(super) async fn lock_rule_set_revision(
    transaction: &DatabaseTransaction,
) -> Result<i64, DbErr> {
    analytics_tag_rule_set_state::Entity::find_by_id(true)
        .lock_shared()
        .one(transaction)
        .await?
        .map(|state| state.revision)
        .ok_or_else(|| {
            DbErr::RecordNotFound(
                "analytics_tag_rule_set_state singleton is missing".to_string(),
            )
        })
}

pub(super) async fn bump_rule_set_revision(
    transaction: &DatabaseTransaction,
) -> Result<i64, DbErr> {
    let state = analytics_tag_rule_set_state::Entity::find_by_id(true)
        .lock_exclusive()
        .one(transaction)
        .await?
        .ok_or_else(|| {
            DbErr::RecordNotFound(
                "analytics_tag_rule_set_state singleton is missing".to_string(),
            )
        })?;
    let revision = state.revision.checked_add(1).ok_or_else(|| {
        DbErr::Custom("analytics tag rule revision overflow".to_string())
    })?;
    let mut state = state.into_active_model();
    state.revision = Set(revision);
    state.update(transaction).await?;
    Ok(revision)
}

pub(super) async fn lock_tag_for_rule_set_mutation(
    transaction: &DatabaseTransaction,
    tag_id: Uuid,
) -> Result<Option<analytics_tag::Model>, DbErr> {
    // Writers take the revision lock before the tag lock. Workers hold the
    // revision lock while applying cached rules, so this order prevents stale
    // assignments without introducing a lock-order cycle.
    bump_rule_set_revision(transaction).await?;
    lock_tag(transaction, tag_id).await
}

pub(super) async fn create_tag(
    main_db: &DatabaseConnection,
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
    .insert(main_db)
    .await
}

pub(super) async fn update_tag_name(
    main_db: &DatabaseConnection,
    tag: analytics_tag::Model,
    name: String,
) -> Result<analytics_tag::Model, DbErr> {
    let mut tag = tag.into_active_model();
    tag.name = Set(name);
    tag.updated_at = Set(Utc::now().fixed_offset());
    tag.update(main_db).await
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
    main_db: &C,
) -> Result<Vec<analytics_tag::Model>, DbErr>
where
    C: ConnectionTrait,
{
    analytics_tag::Entity::find()
        .filter(analytics_tag::Column::ArchivedAt.is_null())
        .all(main_db)
        .await
}

pub(super) async fn load_active_tag_rules(
    transaction: &DatabaseTransaction,
) -> Result<Vec<ActiveTagRule>, DbErr> {
    analytics_tag::Entity::find()
        .filter(analytics_tag::Column::ArchivedAt.is_null())
        .filter(analytics_tag::Column::RuleExpression.is_not_null())
        .order_by_asc(analytics_tag::Column::Id)
        .lock_shared()
        .all(transaction)
        .await
        .map(|tags| {
            tags.into_iter()
                .filter_map(|tag| {
                    tag.rule_expression.map(|rule_expression| ActiveTagRule {
                        tag_id: tag.id,
                        rule_expression,
                    })
                })
                .collect()
        })
}

pub(super) fn pending_files_query(limit: u64) -> Select<file_entry::Entity> {
    file_entry::Entity::find()
        // Generic plans can use the pending-file partial index only when its
        // predicate is visible as SQL literals rather than bound values.
        .filter(Expr::cust(
            r#""file_entry"."kind" = 'file' AND "file_entry"."analyzed" = FALSE"#,
        ))
        .order_by_asc(file_entry::Column::CreatedAt)
        .order_by_asc(file_entry::Column::Id)
        .limit(limit)
        .lock_with_behavior(LockType::Update, LockBehavior::SkipLocked)
}

pub(super) async fn lock_pending_files(
    transaction: &DatabaseTransaction,
    limit: u64,
) -> Result<Vec<file_entry::Model>, DbErr> {
    pending_files_query(limit).all(transaction).await
}

pub(super) async fn reconcile_file_tags(
    transaction: &DatabaseTransaction,
    file_entry_ids: &[Uuid],
    assignments: &[FileTagAssignment],
) -> Result<FileTagDelta, DbErr> {
    if file_entry_ids.is_empty() {
        if assignments.is_empty() {
            return Ok(FileTagDelta::default());
        }
        return Err(DbErr::Custom(
            "file tag assignments require file entry ids".to_string(),
        ));
    }

    let existing_links = device_file_tag::Entity::find()
        .filter(
            device_file_tag::Column::FileEntryId
                .is_in(file_entry_ids.iter().copied()),
        )
        .all(transaction)
        .await?;
    let mut desired_by_key = HashMap::with_capacity(assignments.len());
    for assignment in assignments {
        let key = (assignment.file_entry_id, assignment.tag_id);
        if desired_by_key.insert(key, assignment).is_some() {
            return Err(DbErr::Custom(format!(
                "duplicate file tag assignment for {} and {}",
                assignment.file_entry_id, assignment.tag_id
            )));
        }
    }

    let mut delete_ids = Vec::new();
    let mut insert_assignments = Vec::new();
    let mut unchanged = 0;
    for link in existing_links {
        let key = (link.file_entry_id, link.tag_id);
        match desired_by_key.remove(&key) {
            Some(assignment)
                if link.device_id == assignment.device_id
                    && link.file_entry_created_at
                        == assignment.file_entry_created_at =>
            {
                unchanged += 1;
            }
            Some(assignment) => {
                delete_ids.push(link.id);
                insert_assignments.push(assignment);
            }
            None => delete_ids.push(link.id),
        }
    }
    insert_assignments.extend(desired_by_key.into_values());
    insert_assignments.sort_unstable_by_key(|assignment| {
        (assignment.file_entry_id, assignment.tag_id)
    });

    let mut deleted = 0;
    for chunk in delete_ids.chunks(LINK_DELETE_CHUNK_SIZE) {
        deleted += device_file_tag::Entity::delete_many()
            .filter(device_file_tag::Column::Id.is_in(chunk.iter().copied()))
            .exec(transaction)
            .await?
            .rows_affected as usize;
    }

    let now = Utc::now().fixed_offset();
    for chunk in insert_assignments.chunks(LINK_INSERT_CHUNK_SIZE) {
        let links =
            chunk.iter().map(|assignment| device_file_tag::ActiveModel {
                id: Set(Uuid::now_v7()),
                file_entry_id: Set(assignment.file_entry_id),
                device_id: Set(assignment.device_id),
                file_entry_created_at: Set(assignment.file_entry_created_at),
                tag_id: Set(assignment.tag_id),
                created_at: Set(now),
                updated_at: Set(now),
            });
        device_file_tag::Entity::insert_many(links)
            .exec(transaction)
            .await?;
    }

    Ok(FileTagDelta {
        inserted: insert_assignments.len(),
        deleted,
        unchanged,
    })
}

pub(super) async fn mark_files_analyzed(
    transaction: &DatabaseTransaction,
    file_entry_ids: &[Uuid],
) -> Result<u64, DbErr> {
    if file_entry_ids.is_empty() {
        return Ok(0);
    }
    file_entry::Entity::update_many()
        .col_expr(file_entry::Column::Analyzed, Expr::value(true))
        .filter(file_entry::Column::Id.is_in(file_entry_ids.iter().copied()))
        .filter(file_entry::Column::Analyzed.eq(false))
        .exec(transaction)
        .await
        .map(|result| result.rows_affected)
}

pub(super) async fn schedule_reanalysis(
    file_db: &DatabaseConnection,
    device_id: Option<Uuid>,
) -> Result<u64, DbErr> {
    file_entry::Entity::update_many()
        .col_expr(file_entry::Column::Analyzed, Expr::value(false))
        .filter(file_entry::Column::Kind.eq(FileEntryKind::File))
        .filter(file_entry::Column::Analyzed.eq(true))
        .apply_if(device_id, |query, device_id| {
            query.filter(file_entry::Column::DeviceId.eq(device_id))
        })
        .exec(file_db)
        .await
        .map(|result| result.rows_affected)
}

pub(in crate::devices) async fn load_active_tags_for_files<C>(
    main_db: &C,
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
        .all(main_db)
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
    main_db: &C,
    file_entry_ids: &[Uuid],
) -> Result<BTreeMap<Uuid, BTreeSet<Uuid>>, DbErr>
where
    C: ConnectionTrait,
{
    Ok(load_active_tags_for_files(main_db, file_entry_ids)
        .await?
        .into_iter()
        .map(|(file_id, tags)| {
            (file_id, tags.into_iter().map(|tag| tag.id).collect())
        })
        .collect())
}

pub(in crate::devices) async fn find_active_tag_ids<C>(
    main_db: &C,
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
        .all(main_db)
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
    main_db: &DatabaseConnection,
    device_id: Uuid,
) -> Result<Vec<DeviceAnalyticsSummary>, DbErr> {
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
        .all(main_db)
        .await
        .map(|rows| {
            rows.into_iter()
                .map(|row| DeviceAnalyticsSummary {
                    tag_id: row.tag_id,
                    tag_name: row.tag_name,
                    file_count: row.file_count.max(0) as u64,
                    latest_file_entry_created_at: row
                        .latest_file_entry_created_at,
                })
                .collect()
        })
}

pub(super) async fn find_active_tag<C>(
    main_db: &C,
    tag_id: Uuid,
) -> Result<Option<analytics_tag::Model>, DbErr>
where
    C: ConnectionTrait,
{
    analytics_tag::Entity::find_by_id(tag_id)
        .filter(analytics_tag::Column::ArchivedAt.is_null())
        .one(main_db)
        .await
}

pub(super) async fn resolve_file_link_cursor(
    main_db: &DatabaseConnection,
    device_id: Uuid,
    tag_id: Uuid,
    file_entry_id: Uuid,
) -> Result<Option<DeviceAnalyticsFileLink>, DbErr> {
    device_file_tag::Entity::find()
        .filter(device_file_tag::Column::DeviceId.eq(device_id))
        .filter(device_file_tag::Column::TagId.eq(tag_id))
        .filter(device_file_tag::Column::FileEntryId.eq(file_entry_id))
        .one(main_db)
        .await
        .map(|link| {
            link.map(|link| DeviceAnalyticsFileLink {
                file_entry_id: link.file_entry_id,
                file_entry_created_at: link.file_entry_created_at,
            })
        })
}

pub(super) async fn list_file_links(
    main_db: &DatabaseConnection,
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
        .all(main_db)
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

pub(super) fn file_created_at_with_timezone(
    created_at: chrono::NaiveDateTime,
) -> DateTime<FixedOffset> {
    DateTime::<Utc>::from_naive_utc_and_offset(created_at, Utc).fixed_offset()
}
