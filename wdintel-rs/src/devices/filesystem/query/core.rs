use super::super::ltree;
use super::model;
use crate::devices::filesystem::{
    map_database_error, DirectoryScope, EntryQueryScope, EntrySortKey,
    FileEntryKind, FileSearchFilters, FilesystemError, KeysetPage, PathSyntax,
    RootSortKey, TreeEntry,
};
use crate::file_registry::entities::file_entry;
use crate::h;
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, EntityTrait, QueryFilter,
    QueryOrder, QuerySelect, Select,
};
use uuid::Uuid;

#[allow(dead_code)]
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

#[allow(dead_code)]
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
        query = query.filter(sea_orm::sea_query::Expr::cust_with_values(
            r#""file_entry"."name" ILIKE $1 ESCAPE '\'"#,
            vec![literal_name_pattern(name_query)],
        ));
    }
    if filters.requires_file_metadata() {
        query = query.filter(sea_orm::sea_query::Expr::cust(
            r#""file_entry"."kind" = 'file'"#,
        ));
    }
    if !filters.mime_types().is_empty() {
        query = query
            .filter(sea_orm::sea_query::Expr::cust(
                r#""file_entry"."mime_type" IS NOT NULL"#,
            ))
            .filter(
                file_entry::Column::MimeType
                    .is_in(filters.mime_types().to_vec()),
            );
    }
    if !filters.extensions().is_empty() {
        query = query
            .filter(sea_orm::sea_query::Expr::cust(
                r#""file_entry"."extension" IS NOT NULL"#,
            ))
            .filter(
                file_entry::Column::Extension
                    .is_in(filters.extensions().to_vec()),
            );
    }
    if let Some(modified_from) = filters.file_metadata_modified_from() {
        query = query
            .filter(sea_orm::sea_query::Expr::cust(
                r#""file_entry"."file_metadata_modified_at" IS NOT NULL"#,
            ))
            .filter(
                file_entry::Column::FileMetadataModifiedAt.gte(modified_from),
            );
    }
    if let Some(modified_to) = filters.file_metadata_modified_to() {
        query = query
            .filter(sea_orm::sea_query::Expr::cust(
                r#""file_entry"."file_metadata_modified_at" IS NOT NULL"#,
            ))
            .filter(
                file_entry::Column::FileMetadataModifiedAt.lte(modified_to),
            );
    }
    query
}

#[allow(dead_code)]
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

#[allow(dead_code)]
pub(super) fn apply_root_order(
    query: Select<file_entry::Entity>,
) -> Select<file_entry::Entity> {
    query
        .order_by_asc(file_entry::Column::PathSyntax)
        .order_by_asc(file_entry::Column::NameKey)
        .order_by_asc(file_entry::Column::Id)
}

#[allow(dead_code)]
pub(in crate::devices::filesystem) fn apply_entry_order(
    query: Select<file_entry::Entity>,
) -> Select<file_entry::Entity> {
    query
        .order_by_asc(file_entry::Column::Kind)
        .order_by_asc(file_entry::Column::NameKey)
        .order_by_asc(file_entry::Column::Id)
}

#[allow(dead_code)]
pub(super) fn root_strict_after_condition(after: &RootSortKey) -> Condition {
    Condition::any()
        .add(file_entry::Column::PathSyntax.gt(after.path_syntax().as_db_str()))
        .add(
            Condition::all()
                .add(
                    file_entry::Column::PathSyntax
                        .eq(after.path_syntax().as_db_str()),
                )
                .add(file_entry::Column::NameKey.gt(after.name_key().to_vec())),
        )
        .add(
            Condition::all()
                .add(
                    file_entry::Column::PathSyntax
                        .eq(after.path_syntax().as_db_str()),
                )
                .add(file_entry::Column::NameKey.eq(after.name_key().to_vec()))
                .add(file_entry::Column::Id.gt(after.entry_id())),
        )
}

#[allow(dead_code)]
pub(in crate::devices::filesystem) fn entry_strict_after_condition(
    after: &EntrySortKey,
) -> Condition {
    Condition::all().add(sea_orm::sea_query::Expr::cust_with_values(
        r#"("file_entry"."kind", "file_entry"."name_key", "file_entry"."id") > ($1, $2, $3)"#,
        vec![
            sea_orm::Value::from(after.kind().as_db_str().to_string()),
            sea_orm::Value::from(after.name_key().to_vec()),
            sea_orm::Value::from(after.entry_id()),
        ],
    ))
}

#[allow(dead_code)]
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

#[allow(dead_code)]
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
    use sea_orm::sea_query::{PostgresQueryBuilder, Query};

    use crate::devices::filesystem::{
        DirectoryEntry, PathSyntax, RawFileSearchFilters,
    };
    use chrono::NaiveDate;
    use sea_orm::{DbBackend, QueryTrait};

    fn directory_scope() -> DirectoryScope {
        let timestamp = NaiveDate::from_ymd_opt(2026, 7, 21)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap();
        DirectoryScope::Directory {
            entry: DirectoryEntry {
                entry_id: Uuid::from_u128(2),
                device_id: Uuid::from_u128(1),
                parent_entry_id: Uuid::from_u128(3),
                name: "reports".to_string(),
                name_key: b"reports".to_vec(),
                hierarchy_path:
                    "n00000000000000000000000000000003.n00000000000000000000000000000002"
                        .to_string(),
                created_at: timestamp,
                updated_at: timestamp,
            },
            root_id: Uuid::from_u128(3),
            path_syntax: PathSyntax::Posix,
        }
    }

    #[derive(Debug, PartialEq, Eq)]
    struct Row(u8);

    #[test]
    fn strict_after_conditions_preserve_lexicographic_keysets() {
        let root_sql = Query::select()
            .cond_where(root_strict_after_condition(&RootSortKey::new(
                crate::devices::filesystem::PathSyntax::Posix,
                b"same".to_vec(),
                Uuid::from_u128(1),
            )))
            .to_string(PostgresQueryBuilder);
        let entry_sql = Query::select()
            .cond_where(entry_strict_after_condition(&EntrySortKey::new(
                FileEntryKind::Directory,
                b"same".to_vec(),
                Uuid::from_u128(1),
            )))
            .to_string(PostgresQueryBuilder);

        assert_eq!(root_sql.matches(" OR ").count(), 2);
        assert_eq!(root_sql.matches(" > ").count(), 3);
        assert!(entry_sql.contains(
            r#"("file_entry"."kind", "file_entry"."name_key", "file_entry"."id") > ("#
        ));
        assert!(!entry_sql.contains(" OR "));
    }

    #[test]
    fn page_finalizer_uses_returned_boundary_only_when_more_rows_exist() {
        let page = finalize_page(vec![Row(1), Row(2), Row(3)], 2, |row| row.0);
        assert_eq!(page.entries, vec![Row(1), Row(2)]);
        assert_eq!(page.next, Some(2));

        let page = finalize_page(vec![Row(1), Row(2)], 2, |row| row.0);
        assert_eq!(page.entries, vec![Row(1), Row(2)]);
        assert_eq!(page.next, None);
    }

    #[test]
    fn scoped_queries_bind_navigation_and_filter_values() {
        let directory = directory_scope();
        let filters = FileSearchFilters::try_from(RawFileSearchFilters {
            kinds: vec![FileEntryKind::File],
            name_query: Some(r#"report%_\path"#.to_string()),
            mime_types: vec!["application/json".to_string()],
            extensions: vec!["json".to_string()],
            file_metadata_modified_from: Some(
                NaiveDate::from_ymd_opt(2026, 7, 20)
                    .unwrap()
                    .and_hms_opt(0, 0, 0)
                    .unwrap(),
            ),
            file_metadata_modified_to: Some(
                NaiveDate::from_ymd_opt(2026, 7, 21)
                    .unwrap()
                    .and_hms_opt(0, 0, 0)
                    .unwrap(),
            ),
        })
        .unwrap();
        let search = EntryQueryScope::Search {
            directory: &directory,
            filters: &filters,
        };
        let search_statement =
            apply_entry_scope(file_entry::Entity::find(), &search)
                .build(DbBackend::Postgres);

        assert!(search_statement
            .sql
            .contains(r#""file_entry"."hierarchy_path" <@ $"#));
        assert!(search_statement.sql.contains(r#""parent_id" IS NOT NULL"#));
        assert!(search_statement.sql.contains("ILIKE $"));
        assert!(search_statement.sql.contains("ESCAPE '\\'"));
        assert!(search_statement.sql.contains(r#""mime_type" IN ("#));
        assert!(search_statement.sql.contains(r#""extension" IN ("#));
        assert!(search_statement
            .sql
            .contains(r#""file_metadata_modified_at" >= $"#));
        assert!(search_statement
            .sql
            .contains(r#""file_metadata_modified_at" <= $"#));
        assert!(!search_statement.sql.contains(r#"report%_\path"#));
        assert!(search_statement.values.is_some());

        let browse = EntryQueryScope::Browse(&directory);
        let browse_statement =
            apply_entry_scope(file_entry::Entity::find(), &browse)
                .build(DbBackend::Postgres);
        assert!(browse_statement.sql.contains(r#""parent_id" = $"#));
        assert!(!browse_statement.sql.contains(" <@ "));
        assert!(browse_statement.values.is_some());
    }

    #[test]
    fn directory_scope_lookup_query_binds_device_entry_and_kind() {
        let statement =
            directory_scope_query(Uuid::from_u128(1), Uuid::from_u128(2))
                .build(DbBackend::Postgres);

        assert!(statement.sql.contains(r#""device_id" = $"#));
        assert!(statement.sql.contains(r#""id" = $"#));
        assert!(statement.sql.contains(r#""kind" = $"#));
        assert!(statement.values.is_some());
    }
}
