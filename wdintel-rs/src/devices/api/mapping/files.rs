use crate::devices::api::types::{
    format_datetime, BrowseDeviceFilesRsp, CountDeviceFileSubtreesRsp,
    DeviceFile, DeviceFileJournalEntry, DeviceFileRoot, DeviceFileSubtreeCount,
    DeviceFileTreeEntry, FileBreadcrumb, FileEntryKind as FileEntryKindDto,
    FileSyncError, FileSyncErrorKind, FileSyncOperation, FileSyncResult,
    JournalDeviceFilesRsp, ListDeviceFileRootsRsp, PathSyntax as PathSyntaxDto,
    SearchDeviceFilesRsp, SyncDeviceFilesRsp,
};
use crate::devices::filesystem::{
    Breadcrumb, BrowseFilesResult, FileEntry, JournalFilesResult, PathSyntax,
    RootEntry, SearchFilesResult, SubtreeFileCount, SyncFileItemOutcome,
    SyncFileOperation, SyncFileRejectionKind, SyncFilesResult, TreeEntry,
};
use crate::error::AppError;

pub(in crate::devices) fn map_roots(
    roots: Vec<RootEntry>,
) -> ListDeviceFileRootsRsp {
    ListDeviceFileRootsRsp {
        roots: roots.into_iter().map(map_root).collect(),
    }
}

pub(in crate::devices) fn map_subtree_counts(
    counts: Vec<SubtreeFileCount>,
) -> CountDeviceFileSubtreesRsp {
    CountDeviceFileSubtreesRsp {
        counts: counts
            .into_iter()
            .map(|count| DeviceFileSubtreeCount {
                entry_id: count.entry_id.hyphenated().to_string(),
                file_count: count.file_count,
            })
            .collect(),
    }
}

pub(in crate::devices) fn map_browse(
    result: BrowseFilesResult,
) -> Result<BrowseDeviceFilesRsp, AppError> {
    if result.entries.len() != result.entry_path_components.len() {
        return Err(AppError::AnyhowError {
            source: anyhow::anyhow!(
                "browse result context does not match entries"
            ),
        });
    }
    Ok(BrowseDeviceFilesRsp {
        breadcrumbs: result
            .breadcrumbs
            .into_iter()
            .map(map_breadcrumb)
            .collect(),
        entries: result
            .entries
            .into_iter()
            .zip(result.entry_path_components)
            .map(|(entry, path_components)| {
                map_tree_entry(entry, path_components)
            })
            .collect(),
        next_cursor: result.next_cursor,
    })
}

pub(in crate::devices) fn map_search(
    result: SearchFilesResult,
) -> SearchDeviceFilesRsp {
    SearchDeviceFilesRsp {
        entries: result
            .entries
            .into_iter()
            .map(|entry| map_tree_entry(entry.entry, entry.path_components))
            .collect(),
        next_cursor: result.next_cursor,
    }
}

pub(in crate::devices) fn map_journal(
    result: JournalFilesResult,
) -> JournalDeviceFilesRsp {
    JournalDeviceFilesRsp {
        entries: result
            .entries
            .into_iter()
            .map(|entry| DeviceFileJournalEntry {
                file_id: entry.file_id.hyphenated().to_string(),
                name: entry.name,
                absolute_path: entry.absolute_path,
                has_content: entry.has_content,
                synchronized_at: format_datetime(entry.synchronized_at),
            })
            .collect(),
        total_count: result.total_count,
        next_cursor: result.next_cursor,
    }
}

pub(in crate::devices) fn map_sync(
    result: SyncFilesResult,
) -> SyncDeviceFilesRsp {
    SyncDeviceFilesRsp {
        results: result
            .results
            .into_iter()
            .map(|result| match result.outcome {
                SyncFileItemOutcome::Accepted {
                    operation,
                    root,
                    file,
                    path_components,
                } => FileSyncResult::Accepted {
                    index: result.index,
                    operation: map_sync_operation(operation),
                    file: map_file(file, root.entry_id, path_components),
                    root: map_root(root),
                },
                SyncFileItemOutcome::Rejected {
                    kind,
                    message,
                    field_errors,
                    ..
                } => {
                    let kind = map_rejection_kind(kind);
                    let field_errors = if kind == FileSyncErrorKind::Validation
                    {
                        field_errors
                            .into_iter()
                            .map(|error| (error.path, error.message))
                            .collect()
                    } else {
                        Vec::new()
                    };
                    FileSyncResult::Rejected {
                        index: result.index,
                        error: FileSyncError {
                            kind,
                            message,
                            field_errors,
                        },
                    }
                }
            })
            .collect(),
    }
}

fn map_root(root: RootEntry) -> DeviceFileRoot {
    DeviceFileRoot {
        entry_id: root.entry_id.hyphenated().to_string(),
        device_id: root.device_id.hyphenated().to_string(),
        parent_entry_id: None,
        kind: FileEntryKindDto::Directory,
        name: root.name,
        path_syntax: map_path_syntax(root.path_syntax),
        created_at: format_datetime(root.created_at),
        updated_at: format_datetime(root.updated_at),
    }
}

fn map_breadcrumb(breadcrumb: Breadcrumb) -> FileBreadcrumb {
    FileBreadcrumb {
        entry_id: breadcrumb.entry_id.hyphenated().to_string(),
        name: breadcrumb.name,
    }
}

fn map_tree_entry(
    entry: TreeEntry,
    path_components: Vec<String>,
) -> DeviceFileTreeEntry {
    match entry {
        TreeEntry::Directory(directory) => DeviceFileTreeEntry {
            entry_id: directory.entry_id.hyphenated().to_string(),
            parent_entry_id: directory.parent_entry_id.hyphenated().to_string(),
            kind: FileEntryKindDto::Directory,
            file_id: None,
            name: directory.name,
            path_components,
            path_syntax: None,
            absolute_path: None,
            has_content: false,
            mime_type: None,
            extension: None,
            file_metadata_created_at: None,
            file_metadata_modified_at: None,
            created_at: format_datetime(directory.created_at),
            updated_at: format_datetime(directory.updated_at),
        },
        TreeEntry::File(file) => DeviceFileTreeEntry {
            entry_id: file.file_id.hyphenated().to_string(),
            parent_entry_id: file.parent_entry_id.hyphenated().to_string(),
            kind: FileEntryKindDto::File,
            file_id: Some(file.file_id.hyphenated().to_string()),
            name: file.name,
            path_components,
            path_syntax: Some(map_path_syntax(file.path_syntax)),
            absolute_path: Some(file.absolute_path),
            has_content: file.has_content,
            mime_type: file.mime_type,
            extension: file.extension,
            file_metadata_created_at: file
                .file_metadata_created_at
                .map(format_datetime),
            file_metadata_modified_at: file
                .file_metadata_modified_at
                .map(format_datetime),
            created_at: format_datetime(file.created_at),
            updated_at: format_datetime(file.updated_at),
        },
    }
}

fn map_file(
    file: FileEntry,
    root_entry_id: uuid::Uuid,
    path_components: Vec<String>,
) -> DeviceFile {
    DeviceFile {
        file_id: file.file_id.hyphenated().to_string(),
        device_id: file.device_id.hyphenated().to_string(),
        parent_entry_id: file.parent_entry_id.hyphenated().to_string(),
        root_entry_id: root_entry_id.hyphenated().to_string(),
        path_syntax: map_path_syntax(file.path_syntax),
        absolute_path: file.absolute_path,
        has_content: file.has_content,
        name: file.name,
        path_components,
        mime_type: file.mime_type,
        extension: file.extension,
        file_metadata_created_at: file
            .file_metadata_created_at
            .map(format_datetime),
        file_metadata_modified_at: file
            .file_metadata_modified_at
            .map(format_datetime),
        created_at: format_datetime(file.created_at),
        updated_at: format_datetime(file.updated_at),
    }
}

fn map_path_syntax(path_syntax: PathSyntax) -> PathSyntaxDto {
    match path_syntax {
        PathSyntax::Posix => PathSyntaxDto::Posix,
        PathSyntax::Windows => PathSyntaxDto::Windows,
    }
}

fn map_sync_operation(operation: SyncFileOperation) -> FileSyncOperation {
    match operation {
        SyncFileOperation::Created => FileSyncOperation::Created,
        SyncFileOperation::Updated => FileSyncOperation::Updated,
    }
}

fn map_rejection_kind(kind: SyncFileRejectionKind) -> FileSyncErrorKind {
    match kind {
        SyncFileRejectionKind::Validation => FileSyncErrorKind::Validation,
        SyncFileRejectionKind::NotFound => FileSyncErrorKind::NotFound,
        SyncFileRejectionKind::Conflict => FileSyncErrorKind::Conflict,
        SyncFileRejectionKind::Dependency => FileSyncErrorKind::Dependency,
        SyncFileRejectionKind::Internal => FileSyncErrorKind::Internal,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devices::filesystem::{
        FileJournalEntry, FilesystemFieldError, JournalFilesResult,
        SyncFileItemResult,
    };
    use chrono::NaiveDate;
    use serde_json::json;
    use uuid::Uuid;

    #[test]
    fn roots_use_canonical_wire_fields_and_utc_timestamps() {
        let timestamp = NaiveDate::from_ymd_opt(2026, 7, 23)
            .unwrap()
            .and_hms_milli_opt(9, 10, 11, 123)
            .unwrap();
        let root = RootEntry {
            entry_id: Uuid::parse_str("018f0000-0000-7000-8000-000000000001")
                .unwrap(),
            device_id: Uuid::parse_str("018f0000-0000-7000-8000-000000000002")
                .unwrap(),
            name: "/".to_string(),
            name_key: vec![1],
            path_syntax: PathSyntax::Posix,
            hierarchy_path: "internal".to_string(),
            created_at: timestamp,
            updated_at: timestamp,
        };

        assert_eq!(
            serde_json::to_value(map_roots(vec![root])).unwrap(),
            json!({
                "roots": [{
                    "entry_id": "018f0000-0000-7000-8000-000000000001",
                    "device_id": "018f0000-0000-7000-8000-000000000002",
                    "parent_entry_id": null,
                    "kind": "directory",
                    "name": "/",
                    "path_syntax": "posix",
                    "created_at": "2026-07-23T09:10:11.123Z",
                    "updated_at": "2026-07-23T09:10:11.123Z"
                }]
            }),
        );
    }
    #[test]
    fn subtree_counts_preserve_request_order() {
        let first =
            Uuid::parse_str("018f0000-0000-7000-8000-000000000001").unwrap();
        let second =
            Uuid::parse_str("018f0000-0000-7000-8000-000000000002").unwrap();

        assert_eq!(
            serde_json::to_value(map_subtree_counts(vec![
                SubtreeFileCount {
                    entry_id: first,
                    file_count: 7,
                },
                SubtreeFileCount {
                    entry_id: second,
                    file_count: 0,
                },
            ]))
            .unwrap(),
            json!({
                "counts": [
                    {
                        "entry_id": "018f0000-0000-7000-8000-000000000001",
                        "file_count": 7
                    },
                    {
                        "entry_id": "018f0000-0000-7000-8000-000000000002",
                        "file_count": 0
                    }
                ]
            }),
        );
    }

    #[test]
    fn browse_rejects_misaligned_path_context() {
        let error = map_browse(BrowseFilesResult {
            breadcrumbs: Vec::new(),
            entries: Vec::new(),
            entry_path_components: vec![Vec::new()],
            next_cursor: None,
        })
        .unwrap_err();
        assert!(matches!(error, AppError::AnyhowError { .. }));
    }

    #[test]
    fn journal_maps_current_sync_timestamp_and_pagination_cursor() {
        let synchronized_at = NaiveDate::from_ymd_opt(2026, 7, 28)
            .unwrap()
            .and_hms_opt(8, 15, 30)
            .unwrap();
        let result = JournalFilesResult {
            entries: vec![FileJournalEntry {
                file_id: Uuid::parse_str(
                    "018f0000-0000-7000-8000-000000000003",
                )
                .unwrap(),
                name: "report.log".to_string(),
                absolute_path: "/var/log/report.log".to_string(),
                has_content: true,
                synchronized_at,
            }],
            next_cursor: Some(
                "018f0000-0000-7000-8000-000000000003".to_string(),
            ),
            total_count: 27,
        };

        assert_eq!(
            serde_json::to_value(map_journal(result)).unwrap(),
            json!({
                "entries": [{
                    "file_id": "018f0000-0000-7000-8000-000000000003",
                    "name": "report.log",
                    "absolute_path": "/var/log/report.log",
                    "has_content": true,
                    "synchronized_at": "2026-07-28T08:15:30Z"
                }],
                "total_count": 27,
                "next_cursor": "018f0000-0000-7000-8000-000000000003"
            }),
        );
    }

    #[test]
    fn sync_maps_all_safe_rejection_kinds_in_input_order() {
        let results = [
            SyncFileRejectionKind::Validation,
            SyncFileRejectionKind::NotFound,
            SyncFileRejectionKind::Conflict,
            SyncFileRejectionKind::Dependency,
            SyncFileRejectionKind::Internal,
        ]
        .into_iter()
        .enumerate()
        .map(|(index, kind)| SyncFileItemResult {
            index,
            outcome: SyncFileItemOutcome::Rejected {
                kind,
                message: format!("safe-{index}"),
                retry: true,
                field_errors: vec![FilesystemFieldError {
                    path: format!("files[{index}].absolute_path"),
                    message: "invalid".to_string(),
                }],
            },
        })
        .collect();

        let value = serde_json::to_value(map_sync(SyncFilesResult { results }))
            .unwrap();
        let results = value["results"].as_array().unwrap();
        assert_eq!(
            results
                .iter()
                .map(|result| result["error"]["kind"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec![
                "validation",
                "not_found",
                "conflict",
                "dependency",
                "internal",
            ],
        );
        for (index, result) in results.iter().enumerate() {
            assert_eq!(result["index"], index);
            assert_eq!(result["status"], "rejected");
            assert!(result.get("retry").is_none());
            let field_errors =
                result["error"]["field_errors"].as_array().unwrap();
            assert_eq!(field_errors.len(), usize::from(index == 0));
        }
    }
}
