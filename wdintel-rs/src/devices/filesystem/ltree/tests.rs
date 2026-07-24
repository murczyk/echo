use super::*;

#[test]
fn uuid_paths_use_only_lowercase_uuid_labels() {
    let root_id = Uuid::from_u128(0x018f0000000700080000000000000002);
    let directory_id = Uuid::from_u128(0x018f0000000700080000000000000001);
    let root_label = "n018f0000000700080000000000000002";
    let directory_label = "n018f0000000700080000000000000001";

    assert_eq!(uuid_label(root_id), root_label);
    assert_eq!(root_hierarchy_path(root_id), root_label);
    assert_eq!(
        child_hierarchy_path(root_label, directory_id),
        format!("{root_label}.{directory_label}")
    );
}

#[test]
fn expected_hierarchy_path_requires_exact_nonempty_uuid_chain() {
    let root_id = Uuid::from_u128(1);
    let directory_id = Uuid::from_u128(2);
    let expected =
        "n00000000000000000000000000000001.n00000000000000000000000000000002";

    assert_eq!(
        expected_hierarchy_path(&[root_id, directory_id]).unwrap(),
        expected
    );
    assert!(verify_hierarchy_path(&[root_id, directory_id], expected).is_ok());
    assert!(matches!(
        expected_hierarchy_path(&[]),
        Err(FilesystemError::Invariant("hierarchy_path_empty"))
    ));
    assert!(matches!(
        verify_hierarchy_path(&[root_id, directory_id], "nwrong"),
        Err(FilesystemError::Invariant("hierarchy_path_mismatch"))
    ));
}

#[test]
fn hierarchy_entry_ids_requires_canonical_nonempty_labels() {
    let root_id = Uuid::from_u128(1);
    let directory_id = Uuid::from_u128(2);
    let hierarchy_path =
        expected_hierarchy_path(&[root_id, directory_id]).unwrap();

    assert_eq!(
        hierarchy_entry_ids(&hierarchy_path).unwrap(),
        vec![root_id, directory_id]
    );
    for hierarchy_path in [
        "",
        "nwrong",
        "n0000000000000000000000000000000A",
        "n00000000000000000000000000000001..n00000000000000000000000000000002",
    ] {
        assert!(matches!(
            hierarchy_entry_ids(hierarchy_path),
            Err(FilesystemError::Invariant("hierarchy_path_mismatch"))
        ));
    }
}
