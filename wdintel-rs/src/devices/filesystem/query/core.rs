use super::super::ltree;
use super::model;
use crate::devices::filesystem::{
    map_database_error, DirectoryScope, EntryQueryScope, EntrySortKey,
    FileEntryKind, FileSearchFilters, FilesystemError, KeysetPage, PathSyntax,
    TreeEntry,
};
use crate::file_registry::entities::file_entry;
use crate::h;
use sea_orm::sea_query::{extension::postgres::PgExpr, Expr, LikeExpr};
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, EntityTrait, QueryFilter,
    QueryOrder, QuerySelect, Select,
};
use uuid::Uuid;

pub(in crate::devices::filesystem) async fn find_directory_scope(
    db: &impl ConnectionTrait,
    device_id: Uuid,
    entry_id: Uuid,
) -> Result<DirectoryScope, FilesystemError> {
    let entry = directory_scope_query(device_id, entry_id)
        .one(db)
        .await
        .map_err(|error| {
            map_database_error(anyhow::Error::new(error).context(h!()))
        })?
        .ok_or(FilesystemError::NotFound)?;
    let root_context = if entry.parent_id.is_some() {
        Some(resolve_root_context(db, device_id, &entry.hierarchy_path).await?)
    } else {
        None
    };

    model::map_directory_scope(entry, root_context)
}

pub(super) fn directory_scope_query(
    device_id: Uuid,
    entry_id: Uuid,
) -> Select<file_entry::Entity> {
    file_entry::Entity::find()
        .filter(file_entry::Column::DeviceId.eq(device_id))
        .filter(file_entry::Column::Id.eq(entry_id))
        .filter(
            file_entry::Column::Kind.eq(FileEntryKind::Directory.as_db_str()),
        )
}

async fn resolve_root_context(
    db: &impl ConnectionTrait,
    device_id: Uuid,
    target_hierarchy_path: &str,
) -> Result<(Uuid, PathSyntax), FilesystemError> {
    let root = root_context_query(device_id, target_hierarchy_path)
        .into_tuple::<(Uuid, Option<String>)>()
        .one(db)
        .await
        .map_err(|error| {
            map_database_error(anyhow::Error::new(error).context(h!()))
        })?
        .ok_or(FilesystemError::Invariant(
            "directory_scope_root_context_missing",
        ))?;
    let path_syntax = root
        .1
        .as_deref()
        .ok_or(FilesystemError::Invariant(
            "directory_scope_root_path_syntax_missing",
        ))
        .and_then(PathSyntax::try_from)?;

    Ok((root.0, path_syntax))
}

pub(super) fn root_context_query(
    device_id: Uuid,
    target_hierarchy_path: &str,
) -> Select<file_entry::Entity> {
    file_entry::Entity::find()
        .select_only()
        .column(file_entry::Column::Id)
        .column(file_entry::Column::PathSyntax)
        .filter(file_entry::Column::DeviceId.eq(device_id))
        .filter(file_entry::Column::ParentId.is_null())
        .filter(
            file_entry::Column::Kind.eq(FileEntryKind::Directory.as_db_str()),
        )
        .filter(ltree::ancestor_expr(target_hierarchy_path))
}

pub(in crate::devices::filesystem) fn apply_entry_scope(
    query: Select<file_entry::Entity>,
    scope: &EntryQueryScope<'_>,
) -> Select<file_entry::Entity> {
    let query =
        query.filter(file_entry::Column::DeviceId.eq(scope.device_id()));

    match scope {
        EntryQueryScope::Browse(directory) => query
            .filter(file_entry::Column::ParentId.is_not_null())
            .filter(file_entry::Column::ParentId.eq(directory.entry_id())),
        EntryQueryScope::Search { directory, filters } => {
            apply_search_filters(apply_search_scope(query, directory), filters)
        }
    }
}

pub(super) fn apply_search_scope(
    query: Select<file_entry::Entity>,
    directory: &DirectoryScope,
) -> Select<file_entry::Entity> {
    query
        .filter(file_entry::Column::ParentId.is_not_null())
        .filter(ltree::descendant_expr(directory.hierarchy_path()))
        .filter(file_entry::Column::Id.ne(directory.entry_id()))
}

pub(super) fn apply_search_filters(
    mut query: Select<file_entry::Entity>,
    filters: &FileSearchFilters,
) -> Select<file_entry::Entity> {
    if !filters.kinds().is_empty() {
        query = query.filter(
            file_entry::Column::Kind.is_in(
                filters
                    .kinds()
                    .iter()
                    .map(|kind| kind.as_db_str())
                    .collect::<Vec<_>>(),
            ),
        );
    }
    if let Some(name_query) = filters.name_query() {
        query = query.filter(
            Expr::col((file_entry::Entity, file_entry::Column::Name))
                .ilike(LikeExpr::new(literal_name_pattern(name_query))),
        );
    }
    if filters.requires_file_metadata() {
        query = query.filter(
            file_entry::Column::Kind.eq(FileEntryKind::File.as_db_str()),
        );
    }
    if !filters.mime_types().is_empty() {
        query = query.filter(
            file_entry::Column::MimeType.is_in(filters.mime_types().to_vec()),
        );
    }
    if !filters.extensions().is_empty() {
        query = query.filter(
            file_entry::Column::Extension.is_in(filters.extensions().to_vec()),
        );
    }
    if let Some(modified_from) = filters.file_metadata_modified_from() {
        query = query.filter(
            file_entry::Column::FileMetadataModifiedAt.gte(modified_from),
        );
    }
    if let Some(modified_to) = filters.file_metadata_modified_to() {
        query = query.filter(
            file_entry::Column::FileMetadataModifiedAt.lte(modified_to),
        );
    }
    query
}

pub(super) fn literal_name_pattern(name_query: &str) -> String {
    let mut pattern = String::with_capacity(
        name_query.len().saturating_mul(2).saturating_add(2),
    );
    pattern.push('%');
    for character in name_query.chars() {
        if matches!(character, '\\' | '%' | '_') {
            pattern.push('\\');
        }
        pattern.push(character);
    }
    pattern.push('%');
    pattern
}

pub(super) fn apply_root_order(
    query: Select<file_entry::Entity>,
) -> Select<file_entry::Entity> {
    query
        .order_by_asc(file_entry::Column::PathSyntax)
        .order_by_asc(file_entry::Column::NameKey)
        .order_by_asc(file_entry::Column::Id)
}

pub(in crate::devices::filesystem) fn apply_entry_order(
    query: Select<file_entry::Entity>,
) -> Select<file_entry::Entity> {
    query
        .order_by_asc(file_entry::Column::Kind)
        .order_by_asc(file_entry::Column::NameKey)
        .order_by_asc(file_entry::Column::Id)
}

pub(in crate::devices::filesystem) fn entry_strict_after_condition(
    after: &EntrySortKey,
) -> Condition {
    Condition::all().add(
        Expr::tuple([
            Expr::col((file_entry::Entity, file_entry::Column::Kind)).into(),
            Expr::col((file_entry::Entity, file_entry::Column::NameKey)).into(),
            Expr::col((file_entry::Entity, file_entry::Column::Id)).into(),
        ])
        .gt(Expr::tuple([
            Expr::val(after.kind().as_db_str()).into(),
            Expr::val(after.name_key().to_vec()).into(),
            Expr::val(after.entry_id()).into(),
        ])),
    )
}

pub(super) fn finalize_page<T, K>(
    mut rows: Vec<T>,
    limit: u64,
    sort_key: impl Fn(&T) -> K,
) -> KeysetPage<T, K> {
    let limit = usize::try_from(limit)
        .expect("validated keyset page limit must fit usize");
    if rows.len() <= limit {
        return KeysetPage {
            entries: rows,
            next: None,
        };
    }

    rows.truncate(limit);
    let next = rows.last().map(sort_key);
    KeysetPage {
        entries: rows,
        next,
    }
}

pub(in crate::devices::filesystem) async fn resolve_cursor_entry_sort_key(
    db: &impl ConnectionTrait,
    boundary_entry_id: Uuid,
    scope: &EntryQueryScope<'_>,
) -> Result<EntrySortKey, FilesystemError> {
    let entry = apply_entry_scope(file_entry::Entity::find(), scope)
        .filter(file_entry::Column::Id.eq(boundary_entry_id))
        .one(db)
        .await
        .map_err(|error| {
            map_database_error(anyhow::Error::new(error).context(h!()))
        })?
        .ok_or_else(FilesystemError::invalid_cursor)?;
    let entry = model::map_tree_model(entry)?;

    Ok(entry_sort_key(&entry))
}

pub(super) fn entry_sort_key(entry: &TreeEntry) -> EntrySortKey {
    match entry {
        TreeEntry::Directory(directory) => EntrySortKey::new(
            FileEntryKind::Directory,
            directory.name_key.clone(),
            directory.entry_id,
        ),
        TreeEntry::File(file) => EntrySortKey::new(
            FileEntryKind::File,
            file.name_key.clone(),
            file.file_id,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, PartialEq, Eq)]
    struct Row(u8);

    #[test]
    fn page_finalizer_uses_returned_boundary_only_when_more_rows_exist() {
        let page = finalize_page(vec![Row(1), Row(2), Row(3)], 2, |row| row.0);
        assert_eq!(page.entries, vec![Row(1), Row(2)]);
        assert_eq!(page.next, Some(2));

        let page = finalize_page(vec![Row(1), Row(2)], 2, |row| row.0);
        assert_eq!(page.entries, vec![Row(1), Row(2)]);
        assert_eq!(page.next, None);
    }
}
