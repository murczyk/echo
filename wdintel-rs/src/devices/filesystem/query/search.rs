use super::{ancestors, core, model};
use crate::devices::filesystem::{
    DirectoryScope, EntryQueryScope, EntrySortKey, FileSearchFilters,
    FilesystemError, KeysetPage, KeysetPageRequest, SearchEntry,
};
use crate::file_registry::entities::file_entry;
use crate::h;
use crate::types::ShortContext;
use sea_orm::{DatabaseConnection, EntityTrait, QueryFilter, QuerySelect};

pub(in crate::devices::filesystem) async fn search_entries(
    db: &DatabaseConnection,
    scope: &DirectoryScope,
    filters: &FileSearchFilters,
    page: KeysetPageRequest<EntrySortKey>,
) -> Result<KeysetPage<SearchEntry, EntrySortKey>, FilesystemError> {
    let scope = EntryQueryScope::Search {
        directory: scope,
        filters,
    };
    let mut query = core::apply_entry_scope(file_entry::Entity::find(), &scope);
    query = core::apply_entry_order(query);
    if let Some(after) = page.after() {
        query = query.filter(core::entry_strict_after_condition(after));
    }

    let entries = query
        .limit(page.limit() + 1)
        .all(db)
        .await
        .c(h!())
        .map_err(FilesystemError::Internal)?
        .into_iter()
        .map(model::map_tree_model)
        .collect::<Result<Vec<_>, _>>()?;
    let page = core::finalize_page(entries, page.limit(), core::entry_sort_key);
    let path_components =
        ancestors::load_path_components(db, &page.entries).await?;

    Ok(KeysetPage {
        entries: page
            .entries
            .into_iter()
            .zip(path_components)
            .map(|(entry, path_components)| SearchEntry {
                entry,
                path_components,
            })
            .collect(),
        next: page.next,
    })
}
