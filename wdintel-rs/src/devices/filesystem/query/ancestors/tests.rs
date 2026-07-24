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
            file_model(device_id, file_id, reports_id, &file_path, "gap.log"),
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
    let directory_entry =
        tree_directory(device_id, final_id, root_id, &final_path, "directory");
    let file_entry =
        tree_file(device_id, expected_file_id, root_id, &final_path, "file");

    for entry in [directory_entry, file_entry] {
        let error = map_path_components(
            &[entry],
            vec![
                root_model(device_id, root_id),
                file_model(device_id, final_id, root_id, &final_path, "file"),
            ],
        )
        .unwrap_err();

        assert!(matches!(
            error,
            FilesystemError::Invariant("path_context_entry_mismatch")
        ));
    }
}

fn directory_scope(
    device_id: Uuid,
    root_id: Uuid,
    current_id: Uuid,
) -> DirectoryScope {
    DirectoryScope::Directory {
        entry: DirectoryEntry {
            entry_id: current_id,
            device_id,
            parent_entry_id: root_id,
            name: "current".to_string(),
            name_key: b"current".to_vec(),
            hierarchy_path: hierarchy_path(&[root_id, current_id]),
            created_at: timestamp(),
            updated_at: timestamp(),
        },
        root_id,
        path_syntax: PathSyntax::Posix,
    }
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
    let mut entry = directory_model(device_id, id, parent_id, hierarchy_path);
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
