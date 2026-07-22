use super::{super::ltree, model};
use crate::devices::filesystem::{
    Breadcrumb, DirectoryScope, FileEntryKind, FilesystemError,
};
use crate::file_registry::entities::file_entry;
use crate::h;
use crate::types::ShortContext;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder,
};

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
