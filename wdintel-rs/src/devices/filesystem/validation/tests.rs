use super::*;
use crate::config::{
    DEVICE_FILE_ABSOLUTE_PATH_MAX_BYTES, DEVICE_FILE_ABSOLUTE_PATH_MAX_CHARS,
    DEVICE_FILE_PATH_COMPONENTS_MAX_CHARS,
    DEVICE_FILE_PATH_COMPONENT_MAX_CHARS,
};
use crate::devices::filesystem::types::{
    EntrySortKey, FileEntryKind, KeysetPageRequest,
};
use chrono::NaiveDate;
use uuid::Uuid;

fn raw_filters() -> RawFileSearchFilters {
    RawFileSearchFilters {
        kinds: Vec::new(),
        name_query: None,
        mime_types: Vec::new(),
        extensions: Vec::new(),
        file_metadata_modified_from: None,
        file_metadata_modified_to: None,
    }
}

fn validation_errors(
    result: Result<FileSearchFilters, FilesystemError>,
) -> Vec<FilesystemFieldError> {
    match result {
        Err(FilesystemError::Validation(errors)) => errors,
        _ => panic!("expected filesystem validation error"),
    }
}

#[test]
fn keyset_page_request_enforces_configured_limit_boundaries() {
    let default =
        KeysetPageRequest::<EntrySortKey>::try_new(None, None).unwrap();
    assert_eq!(default.limit(), 100);
    assert_eq!(default.after(), None);

    for limit in [0, 101] {
        let Err(FilesystemError::Validation(errors)) =
            KeysetPageRequest::<EntrySortKey>::try_new(Some(limit), None)
        else {
            panic!("expected invalid limit");
        };
        assert_eq!(
            errors,
            vec![FilesystemFieldError {
                path: "limit".to_string(),
                message: "must be between 1 and 100".to_string(),
            }]
        );
    }
}

#[test]
fn filters_reject_pre_deduplication_value_counts_with_exact_paths() {
    let filters = RawFileSearchFilters {
        kinds: vec![FileEntryKind::File; 51],
        mime_types: vec!["application/json".to_string(); 51],
        extensions: vec!["json".to_string(); 51],
        ..raw_filters()
    };

    let errors = validation_errors(filters.try_into());
    assert_eq!(
        errors
            .into_iter()
            .map(|error| error.path)
            .collect::<Vec<_>>(),
        vec!["kinds", "mime_types", "extensions",]
    );
}

#[test]
fn filters_canonicalize_only_arrays_and_trim_name_query_once() {
    let filters = RawFileSearchFilters {
        kinds: vec![
            FileEntryKind::File,
            FileEntryKind::Directory,
            FileEntryKind::File,
        ],
        name_query: Some("  💾ab  ".to_string()),
        mime_types: vec![
            "text/plain".to_string(),
            " text/plain ".to_string(),
            "text/plain".to_string(),
        ],
        extensions: vec![
            "txt".to_string(),
            "TXT".to_string(),
            "txt".to_string(),
        ],
        ..raw_filters()
    };

    let filters = FileSearchFilters::try_from(filters).unwrap();
    let expected_mime_types =
        vec![" text/plain ".to_string(), "text/plain".to_string()];
    let expected_extensions = vec!["TXT".to_string(), "txt".to_string()];

    assert_eq!(
        filters.kinds(),
        &[FileEntryKind::Directory, FileEntryKind::File]
    );
    assert_eq!(filters.name_query(), Some("💾ab"));
    assert_eq!(filters.mime_types(), expected_mime_types.as_slice());
    assert_eq!(filters.extensions(), expected_extensions.as_slice());
}

#[test]
fn name_query_uses_unicode_scalar_limits_and_rejects_whitespace() {
    let accepted = RawFileSearchFilters {
        name_query: Some("💾ab".to_string()),
        ..raw_filters()
    };
    assert_eq!(
        FileSearchFilters::try_from(accepted).unwrap().name_query(),
        Some("💾ab")
    );

    for name_query in ["   ".to_string(), "a".repeat(256)] {
        let errors = validation_errors(
            RawFileSearchFilters {
                name_query: Some(name_query),
                ..raw_filters()
            }
            .try_into(),
        );
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].path, "name_query");
    }
}

#[test]
fn modified_time_range_is_validated_before_sql() {
    let from = NaiveDate::from_ymd_opt(2026, 7, 21)
        .unwrap()
        .and_hms_opt(12, 0, 0)
        .unwrap();
    let to = NaiveDate::from_ymd_opt(2026, 7, 21)
        .unwrap()
        .and_hms_opt(11, 0, 0)
        .unwrap();
    let errors = validation_errors(
        RawFileSearchFilters {
            file_metadata_modified_from: Some(from),
            file_metadata_modified_to: Some(to),
            ..raw_filters()
        }
        .try_into(),
    );

    assert_eq!(
        errors,
        vec![FilesystemFieldError {
            path: "file_metadata_modified_from".to_string(),
            message: "must be before or equal to file_metadata_modified_to"
                .to_string(),
        }]
    );
}

fn path_validation_errors(
    result: Result<(), FilesystemError>,
) -> Vec<FilesystemFieldError> {
    match result {
        Err(FilesystemError::Validation(errors)) => errors,
        _ => panic!("expected filesystem validation error"),
    }
}

#[test]
fn absolute_path_limits_enforce_utf8_bytes_before_scalar_values() {
    let max_path = "\u{10ffff}".repeat(DEVICE_FILE_ABSOLUTE_PATH_MAX_CHARS);
    assert_eq!(max_path.len(), DEVICE_FILE_ABSOLUTE_PATH_MAX_BYTES);
    validate_absolute_path_limits(&max_path, "files[0].absolute_path").unwrap();

    let byte_overflow = format!("{max_path}\u{10ffff}");
    assert_eq!(
        path_validation_errors(validate_absolute_path_limits(
            &byte_overflow,
            "files[0].absolute_path",
        )),
        vec![FilesystemFieldError {
            path: "files[0].absolute_path".to_string(),
            message: format!(
                "must contain at most {DEVICE_FILE_ABSOLUTE_PATH_MAX_BYTES} UTF-8 bytes"
            ),
        }]
    );

    assert_eq!(
        path_validation_errors(validate_absolute_path_limits(
            "",
            "files[1].absolute_path",
        )),
        vec![FilesystemFieldError {
            path: "files[1].absolute_path".to_string(),
            message: format!(
                "must contain between 1 and {DEVICE_FILE_ABSOLUTE_PATH_MAX_CHARS} Unicode scalar values"
            ),
        }]
    );
}

#[test]
fn path_component_limits_enforce_aggregate_scalar_boundary() {
    let component = "💾".repeat(DEVICE_FILE_PATH_COMPONENT_MAX_CHARS);
    let component_count = DEVICE_FILE_PATH_COMPONENTS_MAX_CHARS
        / DEVICE_FILE_PATH_COMPONENT_MAX_CHARS;
    let components = vec![component.as_str(); component_count];
    validate_path_component_limits(&components, "files[2].absolute_path")
        .unwrap();

    let mut aggregate_overflow = components;
    aggregate_overflow.push("a");
    assert_eq!(
        path_validation_errors(validate_path_component_limits(
            &aggregate_overflow,
            "files[2].absolute_path",
        )),
        vec![FilesystemFieldError {
            path: "files[2].absolute_path".to_string(),
            message: format!(
                "path components must contain at most {DEVICE_FILE_PATH_COMPONENTS_MAX_CHARS} Unicode scalar values in total"
            ),
        }]
    );
}

fn sync_file(file_id: Option<Uuid>) -> SyncFileItemCommand {
    SyncFileItemCommand {
        file_id,
        absolute_path: "/logs/a.log".to_string(),
        mime_type: None,
        extension: None,
        file_metadata_created_at: None,
        file_metadata_modified_at: None,
    }
}

#[test]
fn sync_batch_size_enforces_configured_boundaries() {
    for item_count in [1, DEVICE_FILE_SYNC_BATCH_MAX_COUNT] {
        validate_sync_batch_size(item_count).unwrap();
    }

    for item_count in [0, DEVICE_FILE_SYNC_BATCH_MAX_COUNT + 1] {
        assert_eq!(
            path_validation_errors(validate_sync_batch_size(item_count)),
            vec![FilesystemFieldError {
                path: "files".to_string(),
                message: format!(
                    "must contain between 1 and {DEVICE_FILE_SYNC_BATCH_MAX_COUNT} items"
                ),
            }]
        );
    }
}

#[test]
fn duplicate_file_ids_mark_only_repeated_supplied_ids() {
    let first = Uuid::from_u128(1);
    let second = Uuid::from_u128(2);
    let files = vec![
        sync_file(Some(first)),
        sync_file(None),
        sync_file(Some(second)),
        sync_file(Some(first)),
        sync_file(None),
        sync_file(Some(second)),
        sync_file(Some(first)),
    ];

    assert_eq!(
        duplicate_file_ids(&files),
        std::collections::HashSet::from([first, second])
    );
}
