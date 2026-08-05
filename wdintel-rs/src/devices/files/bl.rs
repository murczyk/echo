use super::cursor;
use super::error::{FilesystemError, FilesystemFieldError};
use super::query;
use super::sync_pipeline::sync_files;
use super::types::{
    BrowseFilesCommand, BrowseFilesResult, EntryQueryScope, FileSearchFilters,
    JournalFilesCommand, JournalFilesResult, KeysetPageRequest, RootEntry,
    SearchFilesCommand, SearchFilesResult, SubtreeFileCount,
    SubtreeFileCountsCommand, SyncFilesCommand, SyncFilesResult,
};
use super::validation::{
    duplicate_file_ids, validate_subtree_count_directories,
    validate_sync_batch_size,
};
use crate::devices::access;
use crate::devices::devices::query::{
    self as device_query, FileRegistryDeviceAccess,
};
use crate::entities::login;
use crate::error::AppError;
use crate::file_registry::FileRegistryDb;
use crate::h;
use crate::types::ShortContext;
use sea_orm::DatabaseConnection;
use uuid::Uuid;

pub(in crate::devices) async fn list_roots(
    main_db: &DatabaseConnection,
    file_registry_db: &FileRegistryDb,
    login: &login::Model,
    device_id: Uuid,
) -> Result<Vec<RootEntry>, AppError> {
    let device_id = device_query::authorize_file_registry_access(
        main_db,
        login,
        device_id,
        FileRegistryDeviceAccess::Read,
    )
    .await
    .c(h!())?;

    query::list_roots(file_registry_db, device_id)
        .await
        .map_err(map_read_error)
}
pub(in crate::devices) async fn count_subtrees(
    main_db: &DatabaseConnection,
    file_registry_db: &FileRegistryDb,
    login: &login::Model,
    command: SubtreeFileCountsCommand,
) -> Result<Vec<SubtreeFileCount>, AppError> {
    let SubtreeFileCountsCommand {
        device_id,
        parent_entry_id,
        directory_entry_ids,
    } = command;
    let device_id = device_query::authorize_file_registry_access(
        main_db,
        login,
        device_id,
        FileRegistryDeviceAccess::Read,
    )
    .await
    .c(h!())?;
    validate_subtree_count_directories(&directory_entry_ids)
        .map_err(map_read_error)
        .c(h!())?;

    query::count_file_subtrees(
        file_registry_db,
        device_id,
        parent_entry_id,
        &directory_entry_ids,
    )
    .await
    .map_err(map_read_error)
}

pub(in crate::devices) async fn journal(
    main_db: &DatabaseConnection,
    file_registry_db: &FileRegistryDb,
    login: &login::Model,
    command: JournalFilesCommand,
) -> Result<JournalFilesResult, AppError> {
    let JournalFilesCommand {
        device_id,
        limit,
        cursor,
    } = command;
    let device_id = device_query::authorize_file_registry_access(
        main_db,
        login,
        device_id,
        FileRegistryDeviceAccess::Read,
    )
    .await
    .c(h!())?;
    let after = match cursor {
        Some(cursor) => {
            let boundary_file_id =
                cursor::decode(&cursor).map_err(map_read_error).c(h!())?;
            Some(
                query::resolve_file_journal_cursor(
                    file_registry_db,
                    device_id,
                    boundary_file_id,
                )
                .await
                .map_err(map_read_error)
                .c(h!())?,
            )
        }
        None => None,
    };
    let page = KeysetPageRequest::try_new(limit, after)
        .map_err(map_read_error)
        .c(h!())?;
    let (page, total_count) =
        query::list_file_journal_with_total(file_registry_db, device_id, page)
            .await
            .map_err(map_read_error)
            .c(h!())?;

    Ok(JournalFilesResult {
        total_count,
        entries: page.entries,
        next_cursor: page
            .next
            .map(|sort_key| cursor::encode(sort_key.file_id())),
    })
}

pub(in crate::devices) async fn browse(
    main_db: &DatabaseConnection,
    file_registry_db: &FileRegistryDb,
    login: &login::Model,
    command: BrowseFilesCommand,
) -> Result<BrowseFilesResult, AppError> {
    let BrowseFilesCommand {
        device_id,
        parent_entry_id,
        include_breadcrumbs,
        limit,
        cursor,
    } = command;
    let device_id = device_query::authorize_file_registry_access(
        main_db,
        login,
        device_id,
        FileRegistryDeviceAccess::Read,
    )
    .await
    .c(h!())?;
    let scope = query::find_directory_scope(
        file_registry_db,
        device_id,
        parent_entry_id,
    )
    .await
    .map_err(map_read_error)
    .c(h!())?;
    let after = match cursor {
        Some(cursor) => {
            let boundary_entry_id =
                cursor::decode(&cursor).map_err(map_read_error).c(h!())?;
            let query_scope = EntryQueryScope::Browse(&scope);
            Some(
                query::resolve_cursor_entry_sort_key(
                    file_registry_db,
                    boundary_entry_id,
                    &query_scope,
                )
                .await
                .map_err(map_read_error)
                .c(h!())?,
            )
        }
        None => None,
    };
    let page = KeysetPageRequest::try_new(limit, after)
        .map_err(map_read_error)
        .c(h!())?;
    let page = query::list_children(file_registry_db, &scope, page)
        .await
        .map_err(map_read_error)
        .c(h!())?;
    let entry_path_components =
        query::load_path_components(file_registry_db, &page.entries)
            .await
            .map_err(map_read_error)
            .c(h!())?;
    let breadcrumbs = if include_breadcrumbs {
        query::list_breadcrumbs(file_registry_db, &scope)
            .await
            .map_err(map_read_error)
            .c(h!())?
    } else {
        Vec::new()
    };

    Ok(BrowseFilesResult {
        breadcrumbs,
        entries: page.entries,
        entry_path_components,
        next_cursor: page
            .next
            .map(|entry_sort_key| cursor::encode(entry_sort_key.entry_id())),
    })
}

pub(in crate::devices) async fn search(
    main_db: &DatabaseConnection,
    file_registry_db: &FileRegistryDb,
    login: &login::Model,
    command: SearchFilesCommand,
) -> Result<SearchFilesResult, AppError> {
    let SearchFilesCommand {
        device_id,
        scope_entry_id,
        filters,
        limit,
        cursor,
    } = command;
    let device_id = device_query::authorize_file_registry_access(
        main_db,
        login,
        device_id,
        FileRegistryDeviceAccess::Read,
    )
    .await
    .c(h!())?;
    let filters = FileSearchFilters::try_from(filters)
        .map_err(map_read_error)
        .c(h!())?;
    let scope = query::find_directory_scope(
        file_registry_db,
        device_id,
        scope_entry_id,
    )
    .await
    .map_err(map_read_error)
    .c(h!())?;
    let after = match cursor {
        Some(cursor) => {
            let boundary_entry_id =
                cursor::decode(&cursor).map_err(map_read_error).c(h!())?;
            let query_scope = EntryQueryScope::Search {
                directory: &scope,
                filters: &filters,
            };
            Some(
                query::resolve_cursor_entry_sort_key(
                    file_registry_db,
                    boundary_entry_id,
                    &query_scope,
                )
                .await
                .map_err(map_read_error)
                .c(h!())?,
            )
        }
        None => None,
    };
    let page = KeysetPageRequest::try_new(limit, after)
        .map_err(map_read_error)
        .c(h!())?;
    let page = query::search_entries(file_registry_db, &scope, &filters, page)
        .await
        .map_err(map_read_error)
        .c(h!())?;

    Ok(SearchFilesResult {
        entries: page.entries,
        next_cursor: page
            .next
            .map(|entry_sort_key| cursor::encode(entry_sort_key.entry_id())),
    })
}
pub(in crate::devices) async fn sync(
    main_db: &DatabaseConnection,
    file_registry_db: &FileRegistryDb,
    login: &login::Model,
    command: SyncFilesCommand,
) -> Result<SyncFilesResult, AppError> {
    access::require_file_sync(&login.roles).c(h!())?;
    validate_sync_batch_size(command.files.len())
        .map_err(map_sync_error)
        .c(h!())?;
    let duplicate_file_ids = duplicate_file_ids(&command.files);
    let SyncFilesCommand { device_id, files } = command;
    let device_id = device_query::authorize_file_registry_access(
        main_db,
        login,
        device_id,
        FileRegistryDeviceAccess::FileSync,
    )
    .await
    .c(h!())?;

    sync_files(file_registry_db, device_id, files, duplicate_file_ids)
        .await
        .map_err(map_sync_error)
}

fn validation_form(errors: Vec<FilesystemFieldError>) -> AppError {
    AppError::Form(
        errors
            .into_iter()
            .map(|error| (error.path, error.message))
            .collect(),
    )
}

fn map_read_error(error: FilesystemError) -> AppError {
    match error {
        FilesystemError::Validation(errors) => validation_form(errors),
        FilesystemError::NotFound => AppError::NotFound,
        FilesystemError::Invariant(_) => AppError::BL {
            msg: "device filesystem invariant violated".to_string(),
        },
        error @ (FilesystemError::Conflict
        | FilesystemError::Dependency(_)
        | FilesystemError::Internal(_)
        | FilesystemError::CommitUncertain(_)) => AppError::AnyhowError {
            source: anyhow::Error::new(error)
                .context("failed to read device filesystem"),
        },
    }
}

fn map_sync_error(error: FilesystemError) -> AppError {
    match error {
        FilesystemError::Validation(errors) => validation_form(errors),
        FilesystemError::NotFound => AppError::NotFound,
        FilesystemError::Invariant(_) => AppError::BL {
            msg: "device filesystem invariant violated".to_string(),
        },
        error @ (FilesystemError::Conflict
        | FilesystemError::Dependency(_)
        | FilesystemError::Internal(_)
        | FilesystemError::CommitUncertain(_)) => AppError::AnyhowError {
            source: anyhow::Error::new(error)
                .context("failed to sync device filesystem"),
        },
    }
}

mod mapping {
    use super::super::types::FileEntryKind as FileEntryKindDto;
    use super::super::types::{
        BrowseDeviceFilesRsp, CountDeviceFileSubtreesRsp, DeviceFile,
        DeviceFileJournalEntry, DeviceFileRoot, DeviceFileSubtreeCount,
        DeviceFileTreeEntry, FileBreadcrumb, FileSyncError, FileSyncErrorKind,
        FileSyncOperation, FileSyncResult, JournalDeviceFilesRsp,
        ListDeviceFileRootsRsp, SearchDeviceFilesRsp, SyncDeviceFilesRsp,
    };
    use super::super::{
        Breadcrumb, BrowseFilesResult, FileEntry, JournalFilesResult,
        RootEntry, SearchFilesResult, SubtreeFileCount, SyncFileItemOutcome,
        SyncFileOperation, SyncFileRejectionKind, SyncFilesResult, TreeEntry,
    };
    use crate::devices::types::format_datetime;
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
                        let field_errors =
                            if kind == FileSyncErrorKind::Validation {
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
                parent_entry_id: directory
                    .parent_entry_id
                    .hyphenated()
                    .to_string(),
                kind: FileEntryKindDto::Directory,
                file_id: None,
                name: directory.name,
                path_components,
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
}

pub(in crate::devices) use mapping::{
    map_browse, map_journal, map_roots, map_search, map_subtree_counts,
    map_sync,
};
