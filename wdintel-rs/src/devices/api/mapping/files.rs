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
mod tests;
