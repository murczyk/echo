use super::*;

#[test]
fn stale_optimistic_root_is_a_retryable_conflict() {
    let optimistic_root_entry_id = Uuid::from_u128(1);
    let unchanged_path = format!(
        "n{}.n{}",
        optimistic_root_entry_id.simple(),
        Uuid::from_u128(2).simple(),
    );
    ensure_file_root_unchanged(optimistic_root_entry_id, &unchanged_path)
        .unwrap();

    let changed_path = format!(
        "n{}.n{}",
        Uuid::from_u128(3).simple(),
        Uuid::from_u128(2).simple(),
    );
    assert!(matches!(
        ensure_file_root_unchanged(optimistic_root_entry_id, &changed_path,),
        Err(FilesystemError::Conflict)
    ));
}
