use super::{core, model};
use crate::devices::analytics::types::TagFilter;
use crate::devices::files::{
    map_database_error, FileJournalEntry, FileJournalSortKey, FilesystemError,
    KeysetPage, KeysetPageRequest,
};
use crate::file_registry::entities::file_entry;
use crate::h;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, EntityTrait, ExprTrait,
    PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, Select,
};
use uuid::Uuid;

pub(in crate::devices::files) async fn list_file_journal(
    db: &impl ConnectionTrait,
    device_id: Uuid,
    page: KeysetPageRequest<FileJournalSortKey>,
    tag_filter: Option<&TagFilter>,
) -> Result<KeysetPage<FileJournalEntry, FileJournalSortKey>, FilesystemError> {
    let entries = file_journal_query(device_id, page.after(), tag_filter)
        .limit(page.limit() + 1)
        .all(db)
        .await
        .map_err(|error| {
            map_database_error(anyhow::Error::new(error).context(h!()))
        })?
        .into_iter()
        .map(model::map_file_journal_model)
        .collect::<Result<Vec<_>, _>>()?;

    Ok(core::finalize_page(
        entries,
        page.limit(),
        file_journal_sort_key,
    ))
}

pub(in crate::devices::files) async fn count_file_journal(
    db: &impl ConnectionTrait,
    device_id: Uuid,
    tag_filter: Option<&TagFilter>,
) -> Result<u64, FilesystemError> {
    file_journal_scope_query(device_id, tag_filter)
        .count(db)
        .await
        .map_err(|error| {
            map_database_error(anyhow::Error::new(error).context(h!()))
        })
}

pub(in crate::devices::files) async fn resolve_file_journal_cursor(
    db: &impl ConnectionTrait,
    device_id: Uuid,
    boundary_file_id: Uuid,
) -> Result<FileJournalSortKey, FilesystemError> {
    let entry = file_journal_scope_query(device_id, None)
        .filter(file_entry::Column::Id.eq(boundary_file_id))
        .one(db)
        .await
        .map_err(|error| {
            map_database_error(anyhow::Error::new(error).context(h!()))
        })?
        .ok_or_else(FilesystemError::invalid_cursor)?;

    Ok(FileJournalSortKey::new(entry.updated_at, entry.id))
}

fn file_journal_query(
    device_id: Uuid,
    after: Option<&FileJournalSortKey>,
    tag_filter: Option<&TagFilter>,
) -> Select<file_entry::Entity> {
    let mut query = file_journal_scope_query(device_id, tag_filter)
        .order_by_desc(file_entry::Column::UpdatedAt)
        .order_by_desc(file_entry::Column::Id);
    if let Some(after) = after {
        query = query.filter(file_journal_strict_after_condition(after));
    }
    query
}

fn file_journal_scope_query(
    device_id: Uuid,
    tag_filter: Option<&TagFilter>,
) -> Select<file_entry::Entity> {
    // A literal invariant lets PostgreSQL generic plans prove the predicate of
    // `file_entry_journal_idx`; binding the enum can force a full scan.
    let mut query = file_entry::Entity::find()
        .filter(file_entry::Column::DeviceId.eq(device_id))
        .filter(Expr::cust("file_entry.kind = 'file'"));
    if let Some(tag_filter) = tag_filter {
        query =
            query.filter(core::file_tag_filter(file_entry::Entity, tag_filter));
    }
    query
}

fn file_journal_strict_after_condition(
    after: &FileJournalSortKey,
) -> Condition {
    Condition::all().add(
        Expr::tuple([
            Expr::col((file_entry::Entity, file_entry::Column::UpdatedAt)),
            Expr::col((file_entry::Entity, file_entry::Column::Id)),
        ])
        .lt(Expr::tuple([
            Expr::val(after.synchronized_at()),
            Expr::val(after.file_id()),
        ])),
    )
}

fn file_journal_sort_key(entry: &FileJournalEntry) -> FileJournalSortKey {
    FileJournalSortKey::new(entry.synchronized_at, entry.file_id)
}
