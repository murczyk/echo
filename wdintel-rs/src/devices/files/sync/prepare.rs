use super::super::types::{
    FileSyncFieldError, NormalizedFileMetadata, ParsedSourcePath,
    RawSourceFileState, RawSyncDeviceFileItem,
};
use super::super::{
    normalize_file_metadata, parse_source_path, DomainSourceFileStateKind,
    FilesystemError, NormalizedSourceFileState,
};
use crate::file_registry::entities::{
    file_sync_item, sea_orm_active_enums::FileSyncItemOutcome,
};
use chrono::{DateTime, FixedOffset, Utc};
use sea_orm::ActiveValue::Set;
use uuid::Uuid;

const VALIDATION_ERROR_CODE: &str = "validation";
const VALIDATION_ERROR_MESSAGE: &str = "file validation failed";

struct PreparedRequestItem {
    absolute_path: String,
    metadata: NormalizedFileMetadata,
    created_at: Option<DateTime<FixedOffset>>,
    modified_at: Option<DateTime<FixedOffset>>,
    source_file_state: Option<NormalizedSourceFileState>,
    field_errors: Vec<FileSyncFieldError>,
}

pub(super) fn prepare_items(
    sync_id: Uuid,
    batch_index: i32,
    files: Vec<RawSyncDeviceFileItem>,
    created_at: DateTime<FixedOffset>,
) -> Result<Vec<file_sync_item::ActiveModel>, FilesystemError> {
    files
        .into_iter()
        .enumerate()
        .map(|(item_index, item)| {
            let item_index = i32::try_from(item_index).map_err(|_| {
                FilesystemError::Invariant("sync_item_index_overflow")
            })?;
            let item = prepare_item(item_index, item)?;
            let rejected = !item.field_errors.is_empty();
            let source_file_state = item.source_file_state.as_ref();
            Ok(file_sync_item::ActiveModel {
                id: Set(sync_id),
                batch_index: Set(batch_index),
                item_index: Set(item_index),
                outcome: Set(rejected.then_some(FileSyncItemOutcome::Rejected)),
                file_id: Set(None),
                absolute_path: Set(item.absolute_path),
                mime_type: Set(item.metadata.mime_type),
                extension: Set(item.metadata.extension),
                file_metadata_created_at: Set(item
                    .created_at
                    .map(|value| value.with_timezone(&Utc).fixed_offset())),
                file_metadata_modified_at: Set(item
                    .modified_at
                    .map(|value| value.with_timezone(&Utc).fixed_offset())),
                source_file_state: Set(
                    source_file_state.map(|value| value.state.clone())
                ),
                source_file_state_settled_at: Set(
                    source_file_state.map(|value| value.settled_at)
                ),
                source_file_state_settled_by: Set(
                    source_file_state.map(|value| value.settled_by.clone())
                ),
                revision: Set(None),
                root_id: Set(None),
                error_code: Set(
                    rejected.then(|| VALIDATION_ERROR_CODE.to_string())
                ),
                error_message: Set(
                    rejected.then(|| VALIDATION_ERROR_MESSAGE.to_string())
                ),
                field_errors: Set(serde_json::to_value(item.field_errors)
                    .expect("file sync field errors serialize")),
                created_at: Set(created_at),
            })
        })
        .collect()
}

fn prepare_item(
    item_index: i32,
    item: RawSyncDeviceFileItem,
) -> Result<PreparedRequestItem, FilesystemError> {
    let prefix = format!("files[{item_index}]");
    let canonical_path = item.absolute_path.trim().to_string();
    let mut field_errors = Vec::new();
    let source_path = collect_validation(
        parse_source_path(
            canonical_path.clone(),
            &format!("{prefix}.absolute_path"),
        ),
        &mut field_errors,
    )?;
    let created_at = parse_timestamp(
        item.file_metadata_created_at.as_deref(),
        &format!("{prefix}.file_metadata_created_at"),
        &mut field_errors,
    );
    let modified_at = parse_timestamp(
        item.file_metadata_modified_at.as_deref(),
        &format!("{prefix}.file_metadata_modified_at"),
        &mut field_errors,
    );
    let metadata = collect_validation(
        normalize_file_metadata(
            source_path
                .as_ref()
                .map(ParsedSourcePath::file_name)
                .unwrap_or(""),
            item.mime_type.clone(),
            item.extension.clone(),
            created_at,
            modified_at,
            &prefix,
        ),
        &mut field_errors,
    )?
    .unwrap_or_else(|| NormalizedFileMetadata {
        mime_type: item.mime_type.map(|value| value.trim().to_string()),
        extension: item.extension.map(|value| value.trim().to_string()),
        file_metadata_created_at: created_at
            .map(|value| value.with_timezone(&Utc).naive_utc()),
        file_metadata_modified_at: modified_at
            .map(|value| value.with_timezone(&Utc).naive_utc()),
    });
    let source_file_state = parse_source_file_state(
        item.source_file_state,
        &prefix,
        &mut field_errors,
    );

    Ok(PreparedRequestItem {
        absolute_path: source_path
            .map(|source_path| source_path.absolute_path)
            .unwrap_or(canonical_path),
        metadata,
        created_at,
        modified_at,
        source_file_state,
        field_errors,
    })
}

fn collect_validation<T>(
    result: Result<T, FilesystemError>,
    field_errors: &mut Vec<FileSyncFieldError>,
) -> Result<Option<T>, FilesystemError> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(FilesystemError::Validation(errors)) => {
            field_errors.extend(errors.into_iter().map(|error| {
                FileSyncFieldError {
                    path: error.path,
                    message: error.message,
                }
            }));
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

fn parse_timestamp(
    value: Option<&str>,
    path: &str,
    field_errors: &mut Vec<FileSyncFieldError>,
) -> Option<DateTime<FixedOffset>> {
    let value = value?;
    match DateTime::parse_from_rfc3339(value) {
        Ok(value) => Some(value.with_timezone(&Utc).fixed_offset()),
        Err(_) => {
            field_errors.push(FileSyncFieldError {
                path: path.to_string(),
                message:
                    "must be an RFC 3339 timestamp with an explicit timezone"
                        .to_string(),
            });
            None
        }
    }
}

fn parse_source_file_state(
    value: Option<RawSourceFileState>,
    prefix: &str,
    field_errors: &mut Vec<FileSyncFieldError>,
) -> Option<NormalizedSourceFileState> {
    let value = value?;
    let path = format!("{prefix}.source_file_state");
    let initial_error_count = field_errors.len();
    let state = match value.state.as_deref() {
        Some("scanned") => Some(DomainSourceFileStateKind::Scanned),
        Some("downloaded") => Some(DomainSourceFileStateKind::Downloaded),
        Some("changed") => Some(DomainSourceFileStateKind::Changed),
        Some(_) => {
            field_errors.push(FileSyncFieldError {
                path: format!("{path}.state"),
                message: "must be one of scanned, downloaded, changed"
                    .to_string(),
            });
            None
        }
        None => {
            field_errors.push(FileSyncFieldError {
                path: format!("{path}.state"),
                message: "must be a string".to_string(),
            });
            None
        }
    };
    let settled_at = match value.settled_at.as_deref() {
        Some(value) => match DateTime::parse_from_rfc3339(value) {
            Ok(value) => Some(value.with_timezone(&Utc).fixed_offset()),
            Err(_) => {
                field_errors.push(FileSyncFieldError {
                    path: format!("{path}.settled_at"),
                    message:
                        "must be an RFC 3339 timestamp with an explicit timezone"
                            .to_string(),
                });
                None
            }
        },
        None => {
            field_errors.push(FileSyncFieldError {
                path: format!("{path}.settled_at"),
                message: "must be a string".to_string(),
            });
            None
        }
    };
    let settled_by = match value.settled_by.as_deref() {
        Some(value) if !value.trim().is_empty() => {
            Some(value.trim().to_string())
        }
        Some(_) => {
            field_errors.push(FileSyncFieldError {
                path: format!("{path}.settled_by"),
                message: "must be non-empty after trimming".to_string(),
            });
            None
        }
        None => {
            field_errors.push(FileSyncFieldError {
                path: format!("{path}.settled_by"),
                message: "must be a string".to_string(),
            });
            None
        }
    };

    if field_errors.len() != initial_error_count {
        return None;
    }
    Some(NormalizedSourceFileState {
        state: state.expect("validated source state"),
        settled_at: settled_at.expect("validated settlement timestamp"),
        settled_by: settled_by.expect("validated settlement actor"),
    })
}
