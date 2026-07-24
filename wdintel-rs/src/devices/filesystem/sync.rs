use super::{
    normalize_file_metadata, FilesystemError, FilesystemFieldError,
    FilesystemRepository, PathSyntax, PreparedFileMutation, SourcePathParser,
    SyncFileItemCommand, SyncFileItemOutcome, SyncFileItemResult,
    SyncFileRejectionKind, SyncFilesResult,
};
use crate::config::DEVICE_FILE_SYNC_ITEM_MAX_ATTEMPTS;
use chrono::{DateTime, FixedOffset};
use std::collections::HashSet;
use uuid::Uuid;

enum PreparedSyncFileItem {
    Mutation {
        index: usize,
        mutation: PreparedFileMutation,
    },
    Rejected(SyncFileItemResult),
}

pub(super) async fn sync_files(
    repository: &FilesystemRepository<'_>,
    device_id: Uuid,
    path_syntax: PathSyntax,
    files: Vec<SyncFileItemCommand>,
    duplicate_file_ids: HashSet<Uuid>,
) -> Result<SyncFilesResult, FilesystemError> {
    let prepared_files =
        prepare_sync_items(device_id, path_syntax, files, &duplicate_file_ids)?;
    let mut results = Vec::with_capacity(prepared_files.len());

    for prepared_file in prepared_files {
        match prepared_file {
            PreparedSyncFileItem::Rejected(result) => results.push(result),
            PreparedSyncFileItem::Mutation { index, mutation } => {
                let result =
                    match mutate_file_with_retry(repository, &mutation).await {
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

    Ok(SyncFilesResult { results })
}

async fn mutate_file_with_retry(
    repository: &FilesystemRepository<'_>,
    mutation: &PreparedFileMutation,
) -> Result<super::FileMutationResult, FilesystemError> {
    for attempt in 1..=DEVICE_FILE_SYNC_ITEM_MAX_ATTEMPTS {
        match repository.mutate_file(mutation).await {
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

fn prepare_sync_items(
    device_id: Uuid,
    path_syntax: PathSyntax,
    files: Vec<SyncFileItemCommand>,
    duplicate_file_ids: &HashSet<Uuid>,
) -> Result<Vec<PreparedSyncFileItem>, FilesystemError> {
    let mut prepared_files = Vec::with_capacity(files.len());

    for (index, file) in files.into_iter().enumerate() {
        prepared_files.push(prepare_sync_item(
            index,
            device_id,
            path_syntax,
            file,
            duplicate_file_ids,
        )?);
    }

    Ok(prepared_files)
}

fn prepare_sync_item(
    index: usize,
    device_id: Uuid,
    path_syntax: PathSyntax,
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

    let source_path = match SourcePathParser::parse(
        path_syntax,
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

fn map_sync_item_error(
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

#[cfg(test)]
mod tests {
    use super::*;

    fn sync_file(
        file_id: Option<Uuid>,
        absolute_path: &str,
        mime_type: Option<&str>,
        extension: Option<&str>,
    ) -> SyncFileItemCommand {
        SyncFileItemCommand {
            file_id,
            absolute_path: absolute_path.to_string(),
            mime_type: mime_type.map(str::to_string),
            extension: extension.map(str::to_string),
            file_metadata_created_at: None,
            file_metadata_modified_at: None,
        }
    }

    fn field_error(path: &str) -> FilesystemFieldError {
        FilesystemFieldError {
            path: path.to_string(),
            message: "invalid".to_string(),
        }
    }

    #[test]
    fn preparation_keeps_duplicate_and_item_validation_errors_ordered() {
        let file_id = Uuid::now_v7();
        let duplicate_file_ids = HashSet::from([file_id]);
        let files = vec![
            sync_file(
                Some(file_id),
                "C:\\logs\\a.log",
                Some("   "),
                Some(".log"),
            ),
            sync_file(Some(file_id), "relative.log", None, None),
        ];

        let prepared = prepare_sync_items(
            Uuid::now_v7(),
            PathSyntax::Windows,
            files,
            &duplicate_file_ids,
        )
        .unwrap();
        let error_paths = prepared
            .into_iter()
            .map(|prepared| match prepared {
                PreparedSyncFileItem::Rejected(SyncFileItemResult {
                    outcome: SyncFileItemOutcome::Rejected { field_errors, .. },
                    ..
                }) => field_errors
                    .into_iter()
                    .map(|error| error.path)
                    .collect::<Vec<_>>(),
                PreparedSyncFileItem::Mutation { .. } => {
                    panic!("expected rejected item")
                }
                PreparedSyncFileItem::Rejected(_) => {
                    panic!("expected validation rejection")
                }
            })
            .collect::<Vec<_>>();

        assert_eq!(
            error_paths,
            vec![
                vec![
                    "files[0].file_id",
                    "files[0].mime_type",
                    "files[0].extension",
                ],
                vec!["files[1].file_id", "files[1].absolute_path"],
            ]
        );
    }

    #[test]
    fn invalid_timestamp_string_is_an_item_validation_rejection() {
        let mut file = sync_file(None, "/logs/a.log", None, None);
        file.file_metadata_created_at = Some("not-a-timestamp".to_string());
        file.file_metadata_modified_at =
            Some("2026-07-23T12:00:00+03:00".to_string());

        let prepared = prepare_sync_items(
            Uuid::now_v7(),
            PathSyntax::Posix,
            vec![file],
            &HashSet::new(),
        )
        .unwrap();
        let PreparedSyncFileItem::Rejected(SyncFileItemResult {
            outcome:
                SyncFileItemOutcome::Rejected {
                    kind, field_errors, ..
                },
            ..
        }) = prepared.into_iter().next().unwrap()
        else {
            panic!("expected timestamp validation rejection");
        };

        assert_eq!(kind, SyncFileRejectionKind::Validation);
        assert_eq!(
            field_errors
                .into_iter()
                .map(|error| error.path)
                .collect::<Vec<_>>(),
            vec!["files[0].file_metadata_created_at"],
        );
    }

    #[test]
    fn item_error_mapping_is_safe_and_commit_uncertainty_is_fatal() {
        let cases = vec![
            (
                FilesystemError::Validation(vec![field_error(
                    "files[0].absolute_path",
                )]),
                SyncFileRejectionKind::Validation,
                "filesystem validation failed",
                false,
                vec![field_error("files[0].absolute_path")],
            ),
            (
                FilesystemError::NotFound,
                SyncFileRejectionKind::NotFound,
                "filesystem entry not found",
                false,
                Vec::new(),
            ),
            (
                FilesystemError::Conflict,
                SyncFileRejectionKind::Conflict,
                "filesystem conflict",
                true,
                Vec::new(),
            ),
            (
                FilesystemError::Dependency(anyhow::anyhow!("dependency")),
                SyncFileRejectionKind::Dependency,
                "filesystem dependency failed",
                false,
                Vec::new(),
            ),
            (
                FilesystemError::Invariant("invariant"),
                SyncFileRejectionKind::Internal,
                "filesystem internal failure",
                false,
                Vec::new(),
            ),
            (
                FilesystemError::Internal(anyhow::anyhow!("internal")),
                SyncFileRejectionKind::Internal,
                "filesystem internal failure",
                false,
                Vec::new(),
            ),
        ];

        for (
            error,
            expected_kind,
            expected_message,
            expected_retry,
            expected_errors,
        ) in cases
        {
            let SyncFileItemResult {
                index,
                outcome:
                    SyncFileItemOutcome::Rejected {
                        kind,
                        message,
                        retry,
                        field_errors,
                    },
            } = map_sync_item_error(7, error).unwrap()
            else {
                panic!("expected rejected item result")
            };

            assert_eq!(index, 7);
            assert_eq!(kind, expected_kind);
            assert_eq!(message, expected_message);
            assert_eq!(retry, expected_retry);
            assert_eq!(field_errors, expected_errors);
        }

        assert!(matches!(
            map_sync_item_error(
                0,
                FilesystemError::CommitUncertain(anyhow::anyhow!("uncertain")),
            ),
            Err(FilesystemError::CommitUncertain(_))
        ));
    }
}
