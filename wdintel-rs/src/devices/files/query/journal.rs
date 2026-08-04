use super::{core, model};
use crate::devices::files::{
    map_database_error, DomainFileEntryKind, FileJournalEntry,
    FileJournalSortKey, FilesystemError, KeysetPage, KeysetPageRequest,
};
use crate::file_registry::entities::file_entry;
use crate::h;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, EntityTrait, QueryFilter,
    QueryOrder, QuerySelect, Select,
};
use uuid::Uuid;

pub(in crate::devices::files) async fn list_file_journal(
    db: &impl ConnectionTrait,
    device_id: Uuid,
    page: KeysetPageRequest<FileJournalSortKey>,
) -> Result<KeysetPage<FileJournalEntry, FileJournalSortKey>, FilesystemError> {
    let entries = file_journal_query(device_id, page.after())
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

pub(in crate::devices::files) async fn resolve_file_journal_cursor(
    db: &impl ConnectionTrait,
    device_id: Uuid,
    boundary_file_id: Uuid,
) -> Result<FileJournalSortKey, FilesystemError> {
    let entry = file_journal_scope_query(device_id)
        .filter(file_entry::Column::Id.eq(boundary_file_id))
        .one(db)
        .await
        .map_err(|error| {
            map_database_error(anyhow::Error::new(error).context(h!()))
        })?
        .ok_or_else(FilesystemError::invalid_cursor)?;

    Ok(FileJournalSortKey::new(entry.updated_at, entry.id))
}

pub(super) fn file_journal_query(
    device_id: Uuid,
    after: Option<&FileJournalSortKey>,
) -> Select<file_entry::Entity> {
    let mut query = file_journal_scope_query(device_id)
        .order_by_desc(file_entry::Column::UpdatedAt)
        .order_by_desc(file_entry::Column::Id);
    if let Some(after) = after {
        query = query.filter(file_journal_strict_after_condition(after));
    }
    query
}

fn file_journal_scope_query(device_id: Uuid) -> Select<file_entry::Entity> {
    file_entry::Entity::find()
        .filter(file_entry::Column::DeviceId.eq(device_id))
        .filter(file_entry::Column::Kind.eq(DomainFileEntryKind::File))
}

fn file_journal_strict_after_condition(
    after: &FileJournalSortKey,
) -> Condition {
    Condition::all().add(
        Expr::tuple([
            Expr::col((file_entry::Entity, file_entry::Column::UpdatedAt))
                .into(),
            Expr::col((file_entry::Entity, file_entry::Column::Id)).into(),
        ])
        .lt(Expr::tuple([
            Expr::val(after.synchronized_at()).into(),
            Expr::val(after.file_id()).into(),
        ])),
    )
}

fn file_journal_sort_key(entry: &FileJournalEntry) -> FileJournalSortKey {
    FileJournalSortKey::new(entry.synchronized_at, entry.file_id)
}
