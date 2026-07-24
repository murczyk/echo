use super::*;
use chrono::NaiveDate;
use std::future;

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
        sync_file(Some(file_id), "C:\\logs\\a.log", Some("   "), Some(".log")),
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

fn prepared_mutation(absolute_path: &str) -> PreparedFileMutation {
    let prepared = prepare_sync_items(
        Uuid::now_v7(),
        PathSyntax::Windows,
        vec![sync_file(None, absolute_path, None, None)],
        &HashSet::new(),
    )
    .unwrap()
    .pop()
    .unwrap();
    let PreparedSyncFileItem::Mutation { mutation, .. } = prepared else {
        panic!("expected prepared mutation");
    };
    mutation
}

fn mutation_result(
    mutation: &PreparedFileMutation,
) -> super::super::FileMutationResult {
    let timestamp = NaiveDate::from_ymd_opt(2026, 7, 24)
        .unwrap()
        .and_hms_opt(12, 0, 0)
        .unwrap();
    let root_id = mutation.candidate_root_entry_id;
    let parent_entry_id = mutation
        .candidate_directory_entry_ids
        .last()
        .copied()
        .unwrap_or(root_id);
    let root_path = format!("n{}", root_id.simple());
    let file_path = format!("{root_path}.n{}", mutation.file_id.simple());

    super::super::FileMutationResult {
        operation: mutation.operation,
        root: super::super::RootEntry {
            entry_id: root_id,
            device_id: mutation.device_id,
            name: mutation.source_path.root_name.clone(),
            name_key: mutation.source_path.root_name.as_bytes().to_vec(),
            path_syntax: mutation.source_path.path_syntax,
            hierarchy_path: root_path,
            created_at: timestamp,
            updated_at: timestamp,
        },
        file: super::super::FileEntry {
            file_id: mutation.file_id,
            device_id: mutation.device_id,
            parent_entry_id,
            name: mutation.source_path.file_name().to_string(),
            name_key: mutation.source_path.file_name().as_bytes().to_vec(),
            path_syntax: mutation.source_path.path_syntax,
            absolute_path: mutation.source_path.absolute_path.clone(),
            hierarchy_path: file_path,
            mime_type: mutation.metadata.mime_type.clone(),
            extension: mutation.metadata.extension.clone(),
            file_metadata_created_at: mutation
                .metadata
                .file_metadata_created_at,
            file_metadata_modified_at: mutation
                .metadata
                .file_metadata_modified_at,
            created_at: timestamp,
            updated_at: timestamp,
        },
        path_components: mutation.source_path.components.clone(),
    }
}

#[tokio::test]
async fn retries_reuse_the_same_prepared_mutation_candidates() {
    let mutation = prepared_mutation(r"C:\logs\retry.log");
    let expected_identity = (
        mutation.file_id,
        mutation.candidate_root_entry_id,
        mutation.candidate_directory_entry_ids.clone(),
    );
    let mut identities = Vec::new();
    let mut attempts = 0;
    let result = mutate_file_with_retry(&mutation, &mut |attempt| {
        attempts += 1;
        identities.push((
            attempt.file_id,
            attempt.candidate_root_entry_id,
            attempt.candidate_directory_entry_ids.clone(),
        ));
        future::ready(if attempts == 1 {
            Err(FilesystemError::Conflict)
        } else {
            Ok(attempt.file_id)
        })
    })
    .await
    .unwrap();

    assert_eq!(result, mutation.file_id);
    assert_eq!(
        identities,
        vec![expected_identity.clone(), expected_identity]
    );
}

#[tokio::test]
async fn exhausted_conflict_rejects_item_and_continues() {
    let mut attempted_paths = Vec::new();
    let result = sync_files_with_mutator(
        Uuid::now_v7(),
        PathSyntax::Windows,
        vec![
            sync_file(None, r"C:\retry\rejected.log", None, None),
            sync_file(None, r"D:\accepted\kept.log", None, None),
        ],
        HashSet::new(),
        |mutation| {
            attempted_paths.push(mutation.source_path.absolute_path.clone());
            let result = if mutation.source_path.absolute_path
                == r"C:\retry\rejected.log"
            {
                Err(FilesystemError::Conflict)
            } else {
                Ok(mutation_result(&mutation))
            };
            future::ready(result)
        },
    )
    .await
    .unwrap();

    assert_eq!(
        attempted_paths
            .iter()
            .filter(|path| path.as_str() == r"C:\retry\rejected.log")
            .count(),
        DEVICE_FILE_SYNC_ITEM_MAX_ATTEMPTS,
    );
    assert_eq!(
        attempted_paths.last().map(String::as_str),
        Some(r"D:\accepted\kept.log"),
    );
    assert!(matches!(
        result.results[0].outcome,
        SyncFileItemOutcome::Rejected {
            kind: SyncFileRejectionKind::Conflict,
            retry: true,
            ..
        }
    ));
    assert!(matches!(
        result.results[1].outcome,
        SyncFileItemOutcome::Accepted { .. }
    ));
}

#[tokio::test]
async fn commit_uncertainty_stops_later_items_after_prior_success() {
    let mut attempted_paths = Vec::new();
    let error = sync_files_with_mutator(
        Uuid::now_v7(),
        PathSyntax::Windows,
        vec![
            sync_file(None, r"C:\prior\committed.log", None, None),
            sync_file(None, r"D:\target\uncertain.log", None, None),
            sync_file(None, r"E:\later\must-not-run.log", None, None),
        ],
        HashSet::new(),
        |mutation| {
            attempted_paths.push(mutation.source_path.absolute_path.clone());
            let result = if mutation.source_path.absolute_path
                == r"D:\target\uncertain.log"
            {
                Err(FilesystemError::CommitUncertain(anyhow::anyhow!(
                    "uncertain"
                )))
            } else {
                Ok(mutation_result(&mutation))
            };
            future::ready(result)
        },
    )
    .await
    .unwrap_err();

    assert!(matches!(error, FilesystemError::CommitUncertain(_)));
    assert_eq!(
        attempted_paths,
        [r"C:\prior\committed.log", r"D:\target\uncertain.log",],
    );
}
