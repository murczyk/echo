use super::{core, model};
use crate::devices::filesystem::{
    DirectoryScope, EntryQueryScope, EntrySortKey, FilesystemError, KeysetPage,
    KeysetPageRequest, TreeEntry,
};
use crate::file_registry::entities::file_entry;
use crate::h;
use crate::types::ShortContext;
use sea_orm::{DatabaseConnection, EntityTrait, QueryFilter, QuerySelect};

pub(in crate::devices::filesystem) async fn list_children(
    db: &DatabaseConnection,
    scope: &DirectoryScope,
    page: KeysetPageRequest<EntrySortKey>,
) -> Result<KeysetPage<TreeEntry, EntrySortKey>, FilesystemError> {
    let scope = EntryQueryScope::Browse(scope);
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

    Ok(core::finalize_page(
        entries,
        page.limit(),
        core::entry_sort_key,
    ))
}
