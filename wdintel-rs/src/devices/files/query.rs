pub(super) mod ancestors;
mod browse;
pub(super) mod core;
mod counts;
mod journal;
pub(super) mod model;
mod roots;
pub(super) mod search;

pub(super) use model::{map_directory_model, map_root_model};
#[cfg(test)]
pub(super) use search::search_entries as search_entries_on_connection;

use super::{
    map_database_error, Breadcrumb, DirectoryScope, EntryQueryScope,
    EntrySortKey, FileJournalEntry, FileJournalSortKey, FileSearchFilters,
    FilesystemError, KeysetPage, KeysetPageRequest, RootEntry, SearchEntry,
    SubtreeFileCount, TreeEntry,
};
use crate::file_registry::FileRegistryDb;
use crate::h;
use sea_orm::{
    AccessMode, DatabaseTransaction, IsolationLevel, TransactionTrait,
};
use std::collections::BTreeSet;
use uuid::Uuid;

async fn begin_read_snapshot(
    file_registry_db: &FileRegistryDb,
) -> Result<DatabaseTransaction, FilesystemError> {
    file_registry_db
        .connection()
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(AccessMode::ReadOnly),
        )
        .await
        .map_err(|error| {
            map_database_error(anyhow::Error::new(error).context(h!()))
        })
}

async fn commit_read_snapshot(
    transaction: DatabaseTransaction,
) -> Result<(), FilesystemError> {
    transaction.commit().await.map_err(|error| {
        map_database_error(anyhow::Error::new(error).context(h!()))
    })
}

pub(in crate::devices) async fn list_roots(
    file_registry_db: &FileRegistryDb,
    device_id: Uuid,
) -> Result<Vec<RootEntry>, FilesystemError> {
    roots::list_roots(file_registry_db.connection(), device_id).await
}

pub(in crate::devices) async fn count_file_subtrees(
    file_registry_db: &FileRegistryDb,
    device_id: Uuid,
    parent_entry_id: Option<Uuid>,
    directory_entry_ids: &[Uuid],
) -> Result<Vec<SubtreeFileCount>, FilesystemError> {
    let transaction = begin_read_snapshot(file_registry_db).await?;
    let counts = counts::count_file_subtrees(
        &transaction,
        device_id,
        parent_entry_id,
        directory_entry_ids,
    )
    .await?;
    if counts.len() != directory_entry_ids.len() {
        return Err(FilesystemError::NotFound);
    }
    commit_read_snapshot(transaction).await?;
    Ok(counts)
}

pub(in crate::devices) async fn list_file_journal_with_total(
    file_registry_db: &FileRegistryDb,
    device_id: Uuid,
    page: KeysetPageRequest<FileJournalSortKey>,
    tag_filter: Option<&crate::devices::analytics::types::TagFilter>,
) -> Result<
    (KeysetPage<FileJournalEntry, FileJournalSortKey>, u64),
    FilesystemError,
> {
    let transaction = begin_read_snapshot(file_registry_db).await?;
    let total_count =
        journal::count_file_journal(&transaction, device_id, tag_filter)
            .await?;
    let page =
        journal::list_file_journal(&transaction, device_id, page, tag_filter)
            .await?;
    commit_read_snapshot(transaction).await?;
    Ok((page, total_count))
}

pub(in crate::devices) async fn resolve_file_journal_cursor(
    file_registry_db: &FileRegistryDb,
    device_id: Uuid,
    boundary_file_id: Uuid,
) -> Result<FileJournalSortKey, FilesystemError> {
    journal::resolve_file_journal_cursor(
        file_registry_db.connection(),
        device_id,
        boundary_file_id,
    )
    .await
}

pub(in crate::devices) async fn list_children(
    file_registry_db: &FileRegistryDb,
    scope: &DirectoryScope,
    page: KeysetPageRequest<EntrySortKey>,
) -> Result<KeysetPage<TreeEntry, EntrySortKey>, FilesystemError> {
    browse::list_children(file_registry_db.connection(), scope, page).await
}

pub(in crate::devices) async fn find_matching_tree_entry_ids(
    file_registry_db: &FileRegistryDb,
    device_id: Uuid,
    entry_ids: &[Uuid],
    tag_filter: &crate::devices::analytics::types::TagFilter,
) -> Result<BTreeSet<Uuid>, FilesystemError> {
    browse::find_matching_tree_entry_ids(
        file_registry_db.connection(),
        device_id,
        entry_ids,
        tag_filter,
    )
    .await
}

pub(in crate::devices) async fn load_path_components(
    file_registry_db: &FileRegistryDb,
    entries: &[TreeEntry],
) -> Result<Vec<Vec<String>>, FilesystemError> {
    ancestors::load_path_components(file_registry_db.connection(), entries)
        .await
}

pub(in crate::devices) async fn search_entries(
    file_registry_db: &FileRegistryDb,
    scope: &DirectoryScope,
    filters: &FileSearchFilters,
    page: KeysetPageRequest<EntrySortKey>,
) -> Result<KeysetPage<SearchEntry, EntrySortKey>, FilesystemError> {
    search::search_entries(file_registry_db.connection(), scope, filters, page)
        .await
}

pub(in crate::devices) async fn list_breadcrumbs(
    file_registry_db: &FileRegistryDb,
    scope: &DirectoryScope,
) -> Result<Vec<Breadcrumb>, FilesystemError> {
    ancestors::list_breadcrumbs(file_registry_db.connection(), scope).await
}

pub(in crate::devices) async fn find_directory_scope(
    file_registry_db: &FileRegistryDb,
    device_id: Uuid,
    entry_id: Uuid,
) -> Result<DirectoryScope, FilesystemError> {
    core::find_directory_scope(
        file_registry_db.connection(),
        device_id,
        entry_id,
    )
    .await
}

pub(in crate::devices) async fn resolve_cursor_entry_sort_key(
    file_registry_db: &FileRegistryDb,
    boundary_entry_id: Uuid,
    scope: &EntryQueryScope<'_>,
) -> Result<EntrySortKey, FilesystemError> {
    core::resolve_cursor_entry_sort_key(
        file_registry_db.connection(),
        boundary_entry_id,
        scope,
    )
    .await
}
