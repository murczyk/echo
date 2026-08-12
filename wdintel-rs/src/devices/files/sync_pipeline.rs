use super::{
    normalize_file_metadata, query, FileMutationResult, FilesystemError,
    FilesystemFieldError, PreparedFileMutation, SyncFileItemCommand,
    SyncFileItemOutcome, SyncFileItemResult, SyncFileRejectionKind,
    SyncFilesResult,
};
use crate::config::DEVICE_FILE_SYNC_ITEM_MAX_ATTEMPTS;
use crate::file_registry::FileRegistryDb;
use chrono::{DateTime, FixedOffset};
use std::{collections::HashSet, future::Future};
use uuid::Uuid;

pub(super) enum PreparedSyncFileItem {
    Mutation {
        index: usize,
        mutation: PreparedFileMutation,
    },
    Rejected(SyncFileItemResult),
}

pub(super) async fn sync_files(
    file_registry_db: &FileRegistryDb,
    device_id: Uuid,
    files: Vec<SyncFileItemCommand>,
    duplicate_file_ids: HashSet<Uuid>,
) -> Result<SyncFilesResult, FilesystemError> {
    sync_files_with_mutator(
        device_id,
        files,
        duplicate_file_ids,
        |mutation| async move {
            query::mutate_file(file_registry_db, &mutation).await
        },
    )
    .await
}

pub(super) async fn sync_files_with_mutator<M, Fut>(
    device_id: Uuid,
    files: Vec<SyncFileItemCommand>,
    duplicate_file_ids: HashSet<Uuid>,
    mut mutate_file: M,
) -> Result<SyncFilesResult, FilesystemError>
where
    M: FnMut(PreparedFileMutation) -> Fut,
    Fut: Future<Output = Result<FileMutationResult, FilesystemError>>,
{
    let prepared_files =
        prepare_sync_items(device_id, files, &duplicate_file_ids)?;
    let mut results = Vec::with_capacity(prepared_files.len());

    for prepared_file in prepared_files {
        match prepared_file {
            PreparedSyncFileItem::Rejected(result) => results.push(result),
            PreparedSyncFileItem::Mutation { index, mutation } => {
                let result =
                    match mutate_file_with_retry(&mutation, &mut mutate_file)
                        .await
                    {
                        Ok(result) => SyncFileItemResult {
                            index,
                            outcome: SyncFileItemOutcome::Accepted {
                                operation: result.operation,
                                root: result.root,
                                file: result.file,
                                path_components: result.path_components,
                            },
                        },
                        Err(error) => map_sync_item_error(index, error)?,
                    };
                results.push(result);
            }
        }
    }

    Ok(SyncFilesResult {
        results,
        tags_by_file: Default::default(),
    })
}

pub(super) async fn mutate_file_with_retry<T, M, Fut>(
    mutation: &PreparedFileMutation,
    mutate_file: &mut M,
) -> Result<T, FilesystemError>
where
    M: FnMut(PreparedFileMutation) -> Fut,
    Fut: Future<Output = Result<T, FilesystemError>>,
{
    for attempt in 1..=DEVICE_FILE_SYNC_ITEM_MAX_ATTEMPTS {
        match mutate_file(mutation.clone()).await {
            Err(FilesystemError::Conflict)
                if attempt < DEVICE_FILE_SYNC_ITEM_MAX_ATTEMPTS =>
            {
                continue;
            }
            result => return result,
        }
    }

    unreachable!("retry attempt range is non-empty")
}

pub(super) fn prepare_sync_items(
    device_id: Uuid,
    files: Vec<SyncFileItemCommand>,
    duplicate_file_ids: &HashSet<Uuid>,
) -> Result<Vec<PreparedSyncFileItem>, FilesystemError> {
    let mut prepared_files = Vec::with_capacity(files.len());

    for (index, file) in files.into_iter().enumerate() {
        prepared_files.push(prepare_sync_item(
            index,
            device_id,
            file,
            duplicate_file_ids,
        )?);
    }

    Ok(prepared_files)
}

fn prepare_sync_item(
    index: usize,
    device_id: Uuid,
    file: SyncFileItemCommand,
    duplicate_file_ids: &HashSet<Uuid>,
) -> Result<PreparedSyncFileItem, FilesystemError> {
    let SyncFileItemCommand {
        file_id,
        absolute_path,
        mime_type,
        extension,
        file_metadata_created_at,
        file_metadata_modified_at,
    } = file;
    let field_prefix = format!("files[{index}]");
    let mut errors = Vec::new();
    let file_metadata_created_at = parse_item_timestamp(
        file_metadata_created_at,
        &format!("{field_prefix}.file_metadata_created_at"),
        &mut errors,
    );
    let file_metadata_modified_at = parse_item_timestamp(
        file_metadata_modified_at,
        &format!("{field_prefix}.file_metadata_modified_at"),
        &mut errors,
    );

    if let Some(file_id) = file_id {
        if duplicate_file_ids.contains(&file_id) {
            errors.push(FilesystemFieldError {
                path: format!("{field_prefix}.file_id"),
                message: "must be unique within the batch".to_string(),
            });
        }
    }

    let source_path = match super::path::parse(
        absolute_path,
        &format!("{field_prefix}.absolute_path"),
    ) {
        Ok(source_path) => Some(source_path),
        Err(FilesystemError::Validation(mut path_errors)) => {
            errors.append(&mut path_errors);
            None
        }
        Err(error) => return Err(error),
    };

    let metadata = match source_path.as_ref() {
        Some(source_path) => match normalize_file_metadata(
            source_path.file_name(),
            mime_type,
            extension,
            file_metadata_created_at,
            file_metadata_modified_at,
            &field_prefix,
        ) {
            Ok(metadata) => Some(metadata),
            Err(FilesystemError::Validation(mut metadata_errors)) => {
                errors.append(&mut metadata_errors);
                None
            }
            Err(error) => return Err(error),
        },
        None => None,
    };

    if !errors.is_empty() {
        return Ok(PreparedSyncFileItem::Rejected(rejected_result(
            index,
            SyncFileRejectionKind::Validation,
            "filesystem validation failed",
            false,
            errors,
        )));
    }

    let source_path = source_path.expect("successful source path parsing");
    let metadata = metadata.expect("successful file metadata normalization");
    let mutation = match file_id {
        Some(file_id) => PreparedFileMutation::for_update(
            device_id,
            file_id,
            source_path,
            metadata,
        ),
        None => {
            PreparedFileMutation::for_create(device_id, source_path, metadata)
        }
    };

    Ok(PreparedSyncFileItem::Mutation { index, mutation })
}

fn parse_item_timestamp(
    value: Option<String>,
    path: &str,
    errors: &mut Vec<FilesystemFieldError>,
) -> Option<DateTime<FixedOffset>> {
    let value = value?;
    match DateTime::parse_from_rfc3339(&value) {
        Ok(value) => Some(value),
        Err(_) => {
            errors.push(FilesystemFieldError {
                path: path.to_string(),
                message:
                    "must be an RFC 3339 timestamp with an explicit timezone"
                        .to_string(),
            });
            None
        }
    }
}

pub(super) fn map_sync_item_error(
    index: usize,
    error: FilesystemError,
) -> Result<SyncFileItemResult, FilesystemError> {
    match error {
        FilesystemError::Validation(field_errors) => Ok(rejected_result(
            index,
            SyncFileRejectionKind::Validation,
            "filesystem validation failed",
            false,
            field_errors,
        )),
        FilesystemError::NotFound => Ok(rejected_result(
            index,
            SyncFileRejectionKind::NotFound,
            "filesystem entry not found",
            false,
            Vec::new(),
        )),
        FilesystemError::Conflict => Ok(rejected_result(
            index,
            SyncFileRejectionKind::Conflict,
            "filesystem conflict",
            true,
            Vec::new(),
        )),
        FilesystemError::Dependency(_) => Ok(rejected_result(
            index,
            SyncFileRejectionKind::Dependency,
            "filesystem dependency failed",
            false,
            Vec::new(),
        )),
        FilesystemError::Invariant(_) | FilesystemError::Internal(_) => {
            Ok(rejected_result(
                index,
                SyncFileRejectionKind::Internal,
                "filesystem internal failure",
                false,
                Vec::new(),
            ))
        }
        FilesystemError::CommitUncertain(error) => {
            Err(FilesystemError::CommitUncertain(error))
        }
    }
}

fn rejected_result(
    index: usize,
    kind: SyncFileRejectionKind,
    message: &str,
    retry: bool,
    field_errors: Vec<FilesystemFieldError>,
) -> SyncFileItemResult {
    SyncFileItemResult {
        index,
        outcome: SyncFileItemOutcome::Rejected {
            kind,
            message: message.to_string(),
            retry,
            field_errors,
        },
    }
}
