use super::{super::ltree, model};
use crate::devices::filesystem::{
    Breadcrumb, DirectoryScope, FileEntryKind, FilesystemError, RootEntry,
    TreeEntry,
};
use crate::file_registry::entities::file_entry;
use crate::h;
use crate::types::ShortContext;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, Condition, DatabaseConnection, EntityTrait, QueryFilter,
    QueryOrder, Select,
};
use std::collections::HashMap;
use uuid::Uuid;

pub(in crate::devices::filesystem) async fn list_breadcrumbs(
    db: &DatabaseConnection,
    scope: &DirectoryScope,
) -> Result<Vec<Breadcrumb>, FilesystemError> {
    let rows = file_entry::Entity::find()
        .filter(file_entry::Column::DeviceId.eq(scope.device_id()))
        .filter(
            file_entry::Column::Kind.eq(FileEntryKind::Directory.as_db_str()),
        )
        .filter(ltree::ancestor_expr(scope.hierarchy_path()))
        .order_by_asc(Expr::cust(r#"nlevel("file_entry"."hierarchy_path")"#))
        .all(db)
        .await
        .c(h!())
        .map_err(FilesystemError::Internal)?;

    map_breadcrumb_chain(scope, rows)
}

pub(super) async fn load_path_components(
    db: &DatabaseConnection,
    entries: &[TreeEntry],
) -> Result<Vec<Vec<String>>, FilesystemError> {
    let Some(first_entry) = entries.first() else {
        return Ok(Vec::new());
    };
    let device_id = tree_entry_device_id(first_entry);
    if entries
        .iter()
        .any(|entry| tree_entry_device_id(entry) != device_id)
    {
        return Err(FilesystemError::Invariant("path_context_device_mismatch"));
    }
    let hierarchy_paths = entries
        .iter()
        .map(tree_entry_hierarchy_path)
        .collect::<Vec<_>>();
    let rows = path_context_query(device_id, &hierarchy_paths)
        .all(db)
        .await
        .c(h!())
        .map_err(FilesystemError::Internal)?;

    map_path_components(entries, rows)
}

fn path_context_query(
    device_id: Uuid,
    hierarchy_paths: &[&str],
) -> Select<file_entry::Entity> {
    let path_conditions = hierarchy_paths.iter().fold(
        Condition::any(),
        |conditions, hierarchy_path| {
            conditions.add(ltree::ancestor_expr(hierarchy_path))
        },
    );

    file_entry::Entity::find()
        .filter(file_entry::Column::DeviceId.eq(device_id))
        .filter(path_conditions)
        .order_by_asc(Expr::cust(r#"nlevel("file_entry"."hierarchy_path")"#))
        .order_by_asc(file_entry::Column::Id)
}

pub(super) fn map_path_components(
    entries: &[TreeEntry],
    rows: Vec<file_entry::Model>,
) -> Result<Vec<Vec<String>>, FilesystemError> {
    let Some(first_entry) = entries.first() else {
        return Ok(Vec::new());
    };
    let device_id = tree_entry_device_id(first_entry);
    if entries
        .iter()
        .any(|entry| tree_entry_device_id(entry) != device_id)
    {
        return Err(FilesystemError::Invariant("path_context_device_mismatch"));
    }

    let mut context_by_id = HashMap::with_capacity(rows.len());
    for row in rows {
        let context = if row.parent_id.is_none() {
            PathContextEntry::Root(model::map_root_model(row)?)
        } else {
            PathContextEntry::Tree(model::map_tree_model(row)?)
        };
        context_by_id.insert(context.entry_id(), context);
    }

    entries
        .iter()
        .map(|entry| {
            map_entry_path_components(entry, device_id, &context_by_id)
        })
        .collect()
}

fn map_entry_path_components(
    entry: &TreeEntry,
    device_id: Uuid,
    context_by_id: &HashMap<Uuid, PathContextEntry>,
) -> Result<Vec<String>, FilesystemError> {
    let entry_ids =
        ltree::hierarchy_entry_ids(tree_entry_hierarchy_path(entry))?;
    let mut path_components = Vec::with_capacity(entry_ids.len() - 1);
    let mut previous_entry_id = None;

    for (position, entry_id) in entry_ids.iter().copied().enumerate() {
        let is_final_entry = position + 1 == entry_ids.len();
        let context = match context_by_id.get(&entry_id) {
            Some(context) => context,
            None if is_final_entry => return Err(FilesystemError::NotFound),
            None => {
                return Err(FilesystemError::Invariant(
                    "path_context_chain_gap",
                ));
            }
        };
        if context.device_id() != device_id {
            return Err(FilesystemError::Invariant(
                "path_context_device_mismatch",
            ));
        }
        if position == 0 {
            if !matches!(context, PathContextEntry::Root(_)) {
                return Err(FilesystemError::Invariant(
                    "path_context_chain_gap",
                ));
            }
        } else if context.parent_entry_id() != previous_entry_id {
            return Err(FilesystemError::Invariant("path_context_chain_gap"));
        }
        ltree::verify_hierarchy_path(
            &entry_ids[..=position],
            context.hierarchy_path(),
        )?;

        if is_final_entry {
            if context.entry_id() != tree_entry_id(entry)
                || context.kind() != tree_entry_kind(entry)
            {
                return Err(FilesystemError::Invariant(
                    "path_context_entry_mismatch",
                ));
            }
            path_components.push(tree_entry_name(entry).to_string());
        } else if position != 0 {
            if context.kind() != FileEntryKind::Directory {
                return Err(FilesystemError::Invariant(
                    "path_context_non_directory_ancestor",
                ));
            }
            path_components.push(context.name().to_string());
        }
        previous_entry_id = Some(entry_id);
    }

    Ok(path_components)
}

enum PathContextEntry {
    Root(RootEntry),
    Tree(TreeEntry),
}

impl PathContextEntry {
    fn device_id(&self) -> Uuid {
        match self {
            Self::Root(root) => root.device_id,
            Self::Tree(entry) => tree_entry_device_id(entry),
        }
    }

    fn entry_id(&self) -> Uuid {
        match self {
            Self::Root(root) => root.entry_id,
            Self::Tree(entry) => tree_entry_id(entry),
        }
    }

    fn parent_entry_id(&self) -> Option<Uuid> {
        match self {
            Self::Root(_) => None,
            Self::Tree(TreeEntry::Directory(directory)) => {
                Some(directory.parent_entry_id)
            }
            Self::Tree(TreeEntry::File(file)) => Some(file.parent_entry_id),
        }
    }

    fn name(&self) -> &str {
        match self {
            Self::Root(root) => &root.name,
            Self::Tree(entry) => tree_entry_name(entry),
        }
    }

    fn kind(&self) -> FileEntryKind {
        match self {
            Self::Root(_) | Self::Tree(TreeEntry::Directory(_)) => {
                FileEntryKind::Directory
            }
            Self::Tree(TreeEntry::File(_)) => FileEntryKind::File,
        }
    }

    fn hierarchy_path(&self) -> &str {
        match self {
            Self::Root(root) => &root.hierarchy_path,
            Self::Tree(entry) => tree_entry_hierarchy_path(entry),
        }
    }
}

fn tree_entry_device_id(entry: &TreeEntry) -> Uuid {
    match entry {
        TreeEntry::Directory(directory) => directory.device_id,
        TreeEntry::File(file) => file.device_id,
    }
}

fn tree_entry_id(entry: &TreeEntry) -> Uuid {
    match entry {
        TreeEntry::Directory(directory) => directory.entry_id,
        TreeEntry::File(file) => file.file_id,
    }
}

fn tree_entry_kind(entry: &TreeEntry) -> FileEntryKind {
    match entry {
        TreeEntry::Directory(_) => FileEntryKind::Directory,
        TreeEntry::File(_) => FileEntryKind::File,
    }
}

fn tree_entry_name(entry: &TreeEntry) -> &str {
    match entry {
        TreeEntry::Directory(directory) => &directory.name,
        TreeEntry::File(file) => &file.name,
    }
}

fn tree_entry_hierarchy_path(entry: &TreeEntry) -> &str {
    match entry {
        TreeEntry::Directory(directory) => &directory.hierarchy_path,
        TreeEntry::File(file) => &file.hierarchy_path,
    }
}

fn map_breadcrumb_chain(
    scope: &DirectoryScope,
    rows: Vec<file_entry::Model>,
) -> Result<Vec<Breadcrumb>, FilesystemError> {
    let mut rows = rows.into_iter();
    let root = rows.next().ok_or(FilesystemError::NotFound)?;
    let root = model::map_root_model(root)?;
    if root.device_id != scope.device_id() {
        return Err(FilesystemError::Invariant("breadcrumb_device_mismatch"));
    }

    let mut entry_ids = vec![root.entry_id];
    let mut breadcrumbs = vec![Breadcrumb {
        entry_id: root.entry_id,
        name: root.name,
    }];
    let mut previous_entry_id = root.entry_id;

    for row in rows {
        let directory = model::map_directory_model(row)?;
        if directory.device_id != scope.device_id() {
            return Err(FilesystemError::Invariant(
                "breadcrumb_device_mismatch",
            ));
        }
        if directory.parent_entry_id != previous_entry_id {
            return Err(FilesystemError::Invariant("breadcrumb_chain_gap"));
        }

        previous_entry_id = directory.entry_id;
        entry_ids.push(directory.entry_id);
        breadcrumbs.push(Breadcrumb {
            entry_id: directory.entry_id,
            name: directory.name,
        });
    }

    if entry_ids.last() != Some(&scope.entry_id()) {
        return Err(FilesystemError::NotFound);
    }
    ltree::verify_hierarchy_path(&entry_ids, scope.hierarchy_path())?;

    Ok(breadcrumbs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devices::filesystem::{DirectoryEntry, PathSyntax};
    use chrono::{NaiveDate, NaiveDateTime};
    use sea_orm::{DbBackend, QueryTrait};
    use uuid::Uuid;

    #[test]
    fn map_breadcrumb_chain_rejects_parent_gap() {
        let device_id = Uuid::from_u128(1);
        let root_id = Uuid::from_u128(2);
        let current_id = Uuid::from_u128(3);
        let missing_parent_id = Uuid::from_u128(4);
        let hierarchy_path = hierarchy_path(&[root_id, current_id]);
        let error = map_breadcrumb_chain(
            &directory_scope(device_id, root_id, current_id),
            vec![
                root_model(device_id, root_id),
                directory_model(
                    device_id,
                    current_id,
                    missing_parent_id,
                    &hierarchy_path,
                ),
            ],
        )
        .unwrap_err();

        assert!(matches!(
            error,
            FilesystemError::Invariant("breadcrumb_chain_gap")
        ));
    }

    #[test]
    fn map_breadcrumb_chain_rejects_device_mismatch() {
        let device_id = Uuid::from_u128(1);
        let other_device_id = Uuid::from_u128(2);
        let root_id = Uuid::from_u128(3);
        let current_id = Uuid::from_u128(4);
        let hierarchy_path = hierarchy_path(&[root_id, current_id]);
        let error = map_breadcrumb_chain(
            &directory_scope(device_id, root_id, current_id),
            vec![
                root_model(device_id, root_id),
                directory_model(
                    other_device_id,
                    current_id,
                    root_id,
                    &hierarchy_path,
                ),
            ],
        )
        .unwrap_err();

        assert!(matches!(
            error,
            FilesystemError::Invariant("breadcrumb_device_mismatch")
        ));
    }

    #[test]
    fn map_breadcrumb_chain_rejects_missing_current_entry() {
        let device_id = Uuid::from_u128(1);
        let root_id = Uuid::from_u128(2);
        let current_id = Uuid::from_u128(3);
        let error = map_breadcrumb_chain(
            &directory_scope(device_id, root_id, current_id),
            vec![root_model(device_id, root_id)],
        )
        .unwrap_err();

        assert!(matches!(error, FilesystemError::NotFound));
    }

    #[test]
    fn map_path_components_uses_root_relative_names_and_page_final_name() {
        let device_id = Uuid::from_u128(1);
        let root_id = Uuid::from_u128(2);
        let reports_id = Uuid::from_u128(3);
        let archive_id = Uuid::from_u128(4);
        let nested_file_id = Uuid::from_u128(5);
        let reports_path = hierarchy_path(&[root_id, reports_id]);
        let archive_path = hierarchy_path(&[root_id, reports_id, archive_id]);
        let nested_file_path =
            hierarchy_path(&[root_id, reports_id, archive_id, nested_file_id]);
        let entries = vec![tree_file(
            device_id,
            nested_file_id,
            archive_id,
            &nested_file_path,
            "nested.log",
        )];
        let components = map_path_components(
            &entries,
            vec![
                root_model(device_id, root_id),
                named_directory_model(
                    device_id,
                    reports_id,
                    root_id,
                    &reports_path,
                    "reports",
                ),
                named_directory_model(
                    device_id,
                    archive_id,
                    reports_id,
                    &archive_path,
                    "archive",
                ),
                file_model(
                    device_id,
                    nested_file_id,
                    archive_id,
                    &nested_file_path,
                    "renamed-after-page-query.log",
                ),
            ],
        )
        .unwrap();

        assert_eq!(
            components,
            vec![vec![
                "reports".to_string(),
                "archive".to_string(),
                "nested.log".to_string(),
            ]]
        );
    }

    #[test]
    fn map_path_components_rejects_missing_final_row() {
        let device_id = Uuid::from_u128(1);
        let root_id = Uuid::from_u128(2);
        let reports_id = Uuid::from_u128(3);
        let file_id = Uuid::from_u128(4);
        let reports_path = hierarchy_path(&[root_id, reports_id]);
        let file_path = hierarchy_path(&[root_id, reports_id, file_id]);
        let entries = vec![tree_file(
            device_id,
            file_id,
            reports_id,
            &file_path,
            "missing.log",
        )];
        let error = map_path_components(
            &entries,
            vec![
                root_model(device_id, root_id),
                named_directory_model(
                    device_id,
                    reports_id,
                    root_id,
                    &reports_path,
                    "reports",
                ),
            ],
        )
        .unwrap_err();

        assert!(matches!(error, FilesystemError::NotFound));
    }

    #[test]
    fn map_path_components_rejects_parent_gap() {
        let device_id = Uuid::from_u128(1);
        let root_id = Uuid::from_u128(2);
        let reports_id = Uuid::from_u128(3);
        let file_id = Uuid::from_u128(4);
        let unexpected_parent_id = Uuid::from_u128(5);
        let reports_path = hierarchy_path(&[root_id, reports_id]);
        let file_path = hierarchy_path(&[root_id, reports_id, file_id]);
        let entries = vec![tree_file(
            device_id, file_id, reports_id, &file_path, "gap.log",
        )];
        let error = map_path_components(
            &entries,
            vec![
                root_model(device_id, root_id),
                named_directory_model(
                    device_id,
                    reports_id,
                    unexpected_parent_id,
                    &reports_path,
                    "reports",
                ),
                file_model(
                    device_id, file_id, reports_id, &file_path, "gap.log",
                ),
            ],
        )
        .unwrap_err();

        assert!(matches!(
            error,
            FilesystemError::Invariant("path_context_chain_gap")
        ));
    }

    #[test]
    fn map_path_components_rejects_file_ancestor() {
        let device_id = Uuid::from_u128(1);
        let root_id = Uuid::from_u128(2);
        let file_ancestor_id = Uuid::from_u128(3);
        let file_id = Uuid::from_u128(4);
        let file_ancestor_path = hierarchy_path(&[root_id, file_ancestor_id]);
        let file_path = hierarchy_path(&[root_id, file_ancestor_id, file_id]);
        let entries = vec![tree_file(
            device_id,
            file_id,
            file_ancestor_id,
            &file_path,
            "nested.log",
        )];
        let error = map_path_components(
            &entries,
            vec![
                root_model(device_id, root_id),
                file_model(
                    device_id,
                    file_ancestor_id,
                    root_id,
                    &file_ancestor_path,
                    "not-a-directory",
                ),
                file_model(
                    device_id,
                    file_id,
                    file_ancestor_id,
                    &file_path,
                    "nested.log",
                ),
            ],
        )
        .unwrap_err();

        assert!(matches!(
            error,
            FilesystemError::Invariant("path_context_non_directory_ancestor")
        ));
    }

    #[test]
    fn map_path_components_rejects_device_mismatch() {
        let device_id = Uuid::from_u128(1);
        let other_device_id = Uuid::from_u128(2);
        let root_id = Uuid::from_u128(3);
        let file_id = Uuid::from_u128(4);
        let file_path = hierarchy_path(&[root_id, file_id]);
        let entries = vec![tree_file(
            device_id,
            file_id,
            root_id,
            &file_path,
            "mismatch.log",
        )];
        let error = map_path_components(
            &entries,
            vec![
                root_model(device_id, root_id),
                file_model(
                    other_device_id,
                    file_id,
                    root_id,
                    &file_path,
                    "mismatch.log",
                ),
            ],
        )
        .unwrap_err();

        assert!(matches!(
            error,
            FilesystemError::Invariant("path_context_device_mismatch")
        ));
    }

    #[test]
    fn map_path_components_rejects_final_entry_mismatch() {
        let device_id = Uuid::from_u128(1);
        let root_id = Uuid::from_u128(2);
        let final_id = Uuid::from_u128(3);
        let expected_file_id = Uuid::from_u128(4);
        let final_path = hierarchy_path(&[root_id, final_id]);
        let directory_entry = tree_directory(
            device_id,
            final_id,
            root_id,
            &final_path,
            "directory",
        );
        let file_entry = tree_file(
            device_id,
            expected_file_id,
            root_id,
            &final_path,
            "file",
        );

        for entry in [directory_entry, file_entry] {
            let error = map_path_components(
                &[entry],
                vec![
                    root_model(device_id, root_id),
                    file_model(
                        device_id,
                        final_id,
                        root_id,
                        &final_path,
                        "file",
                    ),
                ],
            )
            .unwrap_err();

            assert!(matches!(
                error,
                FilesystemError::Invariant("path_context_entry_mismatch")
            ));
        }
    }

    #[test]
    fn path_context_query_binds_device_and_each_hierarchy_path() {
        let first_path =
            hierarchy_path(&[Uuid::from_u128(1), Uuid::from_u128(2)]);
        let second_path =
            hierarchy_path(&[Uuid::from_u128(1), Uuid::from_u128(3)]);
        let statement = path_context_query(
            Uuid::from_u128(4),
            &[&first_path, &second_path],
        )
        .build(DbBackend::Postgres);

        assert_eq!(statement.sql.matches("SELECT").count(), 1);
        assert!(statement.sql.contains(r#""device_id" = $"#));
        assert_eq!(
            statement.sql.matches(r#""hierarchy_path" @> $"#).count(),
            2
        );
        assert!(!statement.sql.contains(&first_path));
        assert!(!statement.sql.contains(&second_path));
        assert_eq!(statement.values.as_ref().unwrap().0.len(), 3);
    }

    fn directory_scope(
        device_id: Uuid,
        root_id: Uuid,
        current_id: Uuid,
    ) -> DirectoryScope {
        DirectoryScope::Directory(DirectoryEntry {
            entry_id: current_id,
            device_id,
            parent_entry_id: root_id,
            name: "current".to_string(),
            name_key: b"current".to_vec(),
            hierarchy_path: hierarchy_path(&[root_id, current_id]),
            created_at: timestamp(),
            updated_at: timestamp(),
        })
    }

    fn root_model(device_id: Uuid, root_id: Uuid) -> file_entry::Model {
        file_entry::Model {
            id: root_id,
            device_id,
            parent_id: None,
            kind: FileEntryKind::Directory.as_db_str().to_string(),
            name: "/".to_string(),
            name_key: b"/".to_vec(),
            path_syntax: Some(PathSyntax::Posix.as_db_str().to_string()),
            absolute_path: None,
            hierarchy_path: hierarchy_path(&[root_id]),
            mime_type: None,
            extension: None,
            file_metadata_created_at: None,
            file_metadata_modified_at: None,
            created_at: timestamp(),
            updated_at: timestamp(),
        }
    }

    fn directory_model(
        device_id: Uuid,
        id: Uuid,
        parent_id: Uuid,
        hierarchy_path: &str,
    ) -> file_entry::Model {
        file_entry::Model {
            id,
            device_id,
            parent_id: Some(parent_id),
            kind: FileEntryKind::Directory.as_db_str().to_string(),
            name: "current".to_string(),
            name_key: b"current".to_vec(),
            path_syntax: None,
            absolute_path: None,
            hierarchy_path: hierarchy_path.to_string(),
            mime_type: None,
            extension: None,
            file_metadata_created_at: None,
            file_metadata_modified_at: None,
            created_at: timestamp(),
            updated_at: timestamp(),
        }
    }

    fn named_directory_model(
        device_id: Uuid,
        id: Uuid,
        parent_id: Uuid,
        hierarchy_path: &str,
        name: &str,
    ) -> file_entry::Model {
        let mut entry =
            directory_model(device_id, id, parent_id, hierarchy_path);
        entry.name = name.to_string();
        entry.name_key = name.as_bytes().to_vec();
        entry
    }

    fn file_model(
        device_id: Uuid,
        id: Uuid,
        parent_id: Uuid,
        hierarchy_path: &str,
        name: &str,
    ) -> file_entry::Model {
        file_entry::Model {
            id,
            device_id,
            parent_id: Some(parent_id),
            kind: FileEntryKind::File.as_db_str().to_string(),
            name: name.to_string(),
            name_key: name.as_bytes().to_vec(),
            path_syntax: Some(PathSyntax::Posix.as_db_str().to_string()),
            absolute_path: Some(format!("/{name}")),
            hierarchy_path: hierarchy_path.to_string(),
            mime_type: None,
            extension: None,
            file_metadata_created_at: None,
            file_metadata_modified_at: None,
            created_at: timestamp(),
            updated_at: timestamp(),
        }
    }

    fn tree_directory(
        device_id: Uuid,
        id: Uuid,
        parent_id: Uuid,
        hierarchy_path: &str,
        name: &str,
    ) -> TreeEntry {
        model::map_tree_model(named_directory_model(
            device_id,
            id,
            parent_id,
            hierarchy_path,
            name,
        ))
        .unwrap()
    }

    fn tree_file(
        device_id: Uuid,
        id: Uuid,
        parent_id: Uuid,
        hierarchy_path: &str,
        name: &str,
    ) -> TreeEntry {
        model::map_tree_model(file_model(
            device_id,
            id,
            parent_id,
            hierarchy_path,
            name,
        ))
        .unwrap()
    }

    fn hierarchy_path(entry_ids: &[Uuid]) -> String {
        entry_ids
            .iter()
            .map(|entry_id| format!("n{}", entry_id.simple()))
            .collect::<Vec<_>>()
            .join(".")
    }

    fn timestamp() -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 7, 21)
            .unwrap()
            .and_hms_opt(12, 30, 45)
            .unwrap()
    }
}
