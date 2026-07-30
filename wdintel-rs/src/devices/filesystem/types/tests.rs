use super::*;

#[test]
fn path_syntax_db_literals_round_trip() {
    for (db_literal, expected) in [
        ("posix", PathSyntax::Posix),
        ("windows", PathSyntax::Windows),
    ] {
        assert_eq!(PathSyntax::try_from(db_literal).unwrap(), expected);
        assert_eq!(expected.as_db_str(), db_literal);
    }

    assert!(matches!(
        PathSyntax::try_from("unknown"),
        Err(FilesystemError::Invariant("unknown_path_syntax"))
    ));
}

#[test]
fn file_entry_kind_db_literals_round_trip() {
    for (db_literal, expected) in [
        ("directory", FileEntryKind::Directory),
        ("file", FileEntryKind::File),
    ] {
        assert_eq!(FileEntryKind::try_from(db_literal).unwrap(), expected);
        assert_eq!(expected.as_db_str(), db_literal);
    }

    assert!(matches!(
        FileEntryKind::try_from("unknown"),
        Err(FilesystemError::Invariant("unknown_file_entry_kind"))
    ));
}

#[test]
fn entry_sort_key_uses_kind_name_and_uuid_order() {
    let lowest_id = Uuid::from_u128(1);
    let highest_id = Uuid::from_u128(2);

    assert!(
        EntrySortKey::new(FileEntryKind::Directory, b"z".to_vec(), highest_id)
            < EntrySortKey::new(FileEntryKind::File, b"a".to_vec(), lowest_id)
    );
    assert!(
        EntrySortKey::new(FileEntryKind::File, b"Z".to_vec(), highest_id)
            < EntrySortKey::new(FileEntryKind::File, b"a".to_vec(), lowest_id)
    );
    assert!(
        EntrySortKey::new(FileEntryKind::File, b"same".to_vec(), lowest_id)
            < EntrySortKey::new(
                FileEntryKind::File,
                b"same".to_vec(),
                highest_id
            )
    );
}

#[test]
fn directory_and_query_scopes_preserve_one_navigation_scope() {
    let device_id = Uuid::from_u128(1);
    let root_id = Uuid::from_u128(2);
    let directory_id = Uuid::from_u128(3);
    let timestamp = chrono::NaiveDate::from_ymd_opt(2026, 7, 21)
        .unwrap()
        .and_hms_opt(12, 0, 0)
        .unwrap();
    let root_scope = DirectoryScope::Root(RootEntry {
        entry_id: root_id,
        device_id,
        name: "root".to_string(),
        name_key: b"root".to_vec(),
        path_syntax: PathSyntax::Posix,
        hierarchy_path: "n00000000000000000000000000000002".to_string(),
        created_at: timestamp,
        updated_at: timestamp,
    });
    let directory_scope = DirectoryScope::Directory {
        entry: DirectoryEntry {
            entry_id: directory_id,
            device_id,
            parent_entry_id: root_id,
            name: "directory".to_string(),
            name_key: b"directory".to_vec(),
            hierarchy_path:
                "n00000000000000000000000000000002.n00000000000000000000000000000003"
                    .to_string(),
            created_at: timestamp,
            updated_at: timestamp,
        },
        root_id,
        path_syntax: PathSyntax::Posix,
    };
    let filters = FileSearchFilters::try_from(RawFileSearchFilters {
        kinds: vec![FileEntryKind::File],
        name_query: Some("abc".to_string()),
        mime_types: Vec::new(),
        extensions: Vec::new(),
        file_metadata_modified_from: None,
        file_metadata_modified_to: None,
    })
    .unwrap();

    let browse = EntryQueryScope::Browse(&root_scope);
    assert_eq!(browse.device_id(), device_id);
    assert_eq!(browse.directory(), &root_scope);
    assert_eq!(
        root_scope.hierarchy_path(),
        "n00000000000000000000000000000002"
    );

    let search = EntryQueryScope::Search {
        directory: &directory_scope,
        filters: &filters,
    };
    assert_eq!(search.device_id(), device_id);
    assert_eq!(search.directory(), &directory_scope);
    assert_eq!(
        directory_scope.hierarchy_path(),
        "n00000000000000000000000000000002.n00000000000000000000000000000003"
    );
}
