use super::*;
use chrono::NaiveDate;
use uuid::Uuid;

fn timestamp() -> chrono::NaiveDateTime {
    NaiveDate::from_ymd_opt(2026, 7, 21)
        .unwrap()
        .and_hms_milli_opt(10, 30, 45, 123)
        .unwrap()
}

fn root_model() -> file_entry::Model {
    let timestamp = timestamp();
    file_entry::Model {
        id: Uuid::from_u128(1),
        device_id: Uuid::from_u128(2),
        parent_id: None,
        kind: "directory".to_string(),
        name: "/".to_string(),
        name_key: b"/".to_vec(),
        path_syntax: Some("posix".to_string()),
        absolute_path: None,
        hierarchy_path: "n00000000000000000000000000000001".to_string(),
        mime_type: None,
        extension: None,
        file_metadata_created_at: None,
        file_metadata_modified_at: None,
        created_at: timestamp,
        updated_at: timestamp,
        content_path: None,
    }
}

fn directory_model() -> file_entry::Model {
    let mut entry = root_model();
    entry.id = Uuid::from_u128(3);
    entry.parent_id = Some(Uuid::from_u128(1));
    entry.name = "reports".to_string();
    entry.name_key = b"reports".to_vec();
    entry.path_syntax = None;
    entry.hierarchy_path =
        "n00000000000000000000000000000001.n00000000000000000000000000000003"
            .to_string();
    entry
}

fn file_model() -> file_entry::Model {
    let mut entry = directory_model();
    entry.id = Uuid::from_u128(4);
    entry.kind = "file".to_string();
    entry.name = "report.pdf".to_string();
    entry.name_key = b"report.pdf".to_vec();
    entry.path_syntax = Some("posix".to_string());
    entry.absolute_path = Some("/reports/report.pdf".to_string());
    entry.hierarchy_path = "n00000000000000000000000000000001.n00000000000000000000000000000003.n00000000000000000000000000000004".to_string();
    entry.mime_type = Some("application/pdf".to_string());
    entry.extension = Some("pdf".to_string());
    entry.file_metadata_created_at = Some(timestamp());
    entry.file_metadata_modified_at = Some(timestamp());
    entry.content_path = Some("devices/018f0000/report.pdf".to_string());
    entry
}

fn assert_invariant<T>(
    result: Result<T, FilesystemError>,
    expected_code: &'static str,
) {
    assert!(matches!(
        result,
        Err(FilesystemError::Invariant(code)) if code == expected_code
    ));
}

#[test]
fn mappers_preserve_all_valid_row_shapes() {
    let root = map_root_model(root_model()).unwrap();
    assert_eq!(root.entry_id, Uuid::from_u128(1));
    assert_eq!(root.path_syntax, PathSyntax::Posix);

    let directory = map_directory_model(directory_model()).unwrap();
    assert_eq!(directory.entry_id, Uuid::from_u128(3));
    assert_eq!(directory.parent_entry_id, Uuid::from_u128(1));

    let file = map_file_model(file_model()).unwrap();
    assert_eq!(file.file_id, Uuid::from_u128(4));
    assert_eq!(file.absolute_path, "/reports/report.pdf");
    assert!(file.has_content);

    assert!(matches!(
        map_tree_model(directory_model()),
        Ok(TreeEntry::Directory(_))
    ));
    assert!(matches!(
        map_tree_model(file_model()),
        Ok(TreeEntry::File(_))
    ));
    assert!(matches!(
        map_directory_scope(root_model(), None),
        Ok(DirectoryScope::Root(_))
    ));
    assert!(matches!(
        map_directory_scope(
            directory_model(),
            Some((Uuid::from_u128(1), PathSyntax::Posix)),
        ),
        Ok(DirectoryScope::Directory { .. })
    ));
}

#[test]
fn mappers_reject_invalid_shapes_with_stable_invariants() {
    let mut root_with_parent = root_model();
    root_with_parent.parent_id = Some(Uuid::from_u128(9));
    assert_invariant(map_root_model(root_with_parent), "root_parent_present");

    let mut root_without_syntax = root_model();
    root_without_syntax.path_syntax = None;
    assert_invariant(
        map_root_model(root_without_syntax),
        "root_path_syntax_missing",
    );

    let mut root_with_path = root_model();
    root_with_path.absolute_path = Some("/".to_string());
    assert_invariant(
        map_root_model(root_with_path),
        "root_absolute_path_present",
    );

    let mut root_with_metadata = root_model();
    root_with_metadata.mime_type = Some("text/plain".to_string());
    assert_invariant(
        map_root_model(root_with_metadata),
        "root_file_metadata_present",
    );

    let mut directory_without_parent = directory_model();
    directory_without_parent.parent_id = None;
    assert_invariant(
        map_directory_model(directory_without_parent),
        "directory_parent_missing",
    );

    let mut directory_with_syntax = directory_model();
    directory_with_syntax.path_syntax = Some("posix".to_string());
    assert_invariant(
        map_directory_model(directory_with_syntax),
        "directory_path_syntax_present",
    );

    let mut directory_with_path = directory_model();
    directory_with_path.absolute_path = Some("/reports".to_string());
    assert_invariant(
        map_directory_model(directory_with_path),
        "directory_absolute_path_present",
    );

    let mut directory_with_metadata = directory_model();
    directory_with_metadata.extension = Some("tmp".to_string());
    assert_invariant(
        map_directory_model(directory_with_metadata),
        "directory_file_metadata_present",
    );
    let mut directory_with_content = directory_model();
    directory_with_content.content_path =
        Some("devices/018f0000/reports".to_string());
    assert_invariant(
        map_directory_model(directory_with_content),
        "directory_file_metadata_present",
    );

    assert_invariant(map_file_model(directory_model()), "file_entry_non_file");
    assert_invariant(map_tree_model(root_model()), "tree_root_entry");
    assert_invariant(
        map_directory_scope(file_model(), None),
        "directory_scope_non_directory_entry",
    );
    assert_invariant(
        map_directory_scope(directory_model(), None),
        "directory_scope_root_context_missing",
    );
}
