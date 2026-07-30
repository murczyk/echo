use super::sync::sync_files;
use super::validation::{
    duplicate_file_ids, validate_subtree_count_directories,
    validate_sync_batch_size,
};
use super::{
    BrowseFilesCommand, BrowseFilesResult, EntryQueryScope, FileCursorCodec,
    FileSearchFilters, FilesystemError, FilesystemFieldError,
    FilesystemRepository, JournalFilesCommand, JournalFilesResult,
    KeysetPageRequest, RootEntry, SearchFilesCommand, SearchFilesResult,
    SubtreeFileCount, SubtreeFileCountsCommand, SyncFilesCommand,
    SyncFilesResult,
};
use crate::devices::access::DeviceActor;
use crate::devices::main_db::MainDb;
use crate::devices::visibility::{DeviceVisibility, FileRegistryDeviceAccess};
use crate::error::AppError;
use crate::file_registry::FileRegistryDb;
use sea_orm::DatabaseConnection;
use uuid::Uuid;

pub(in crate::devices) struct FileMetadataService;

impl FileMetadataService {
    pub(in crate::devices) async fn list_roots(
        main_db: MainDb<'_, DatabaseConnection>,
        file_registry_db: &FileRegistryDb,
        actor: &DeviceActor,
        device_id: Uuid,
    ) -> Result<Vec<RootEntry>, AppError> {
        let device_id = DeviceVisibility::verify_file_registry_access(
            main_db,
            actor,
            device_id,
            FileRegistryDeviceAccess::Read,
        )
        .await?;

        FilesystemRepository::new(file_registry_db)
            .list_roots(device_id)
            .await
            .map_err(map_read_error)
    }
    pub(in crate::devices) async fn count_subtrees(
        main_db: MainDb<'_, DatabaseConnection>,
        file_registry_db: &FileRegistryDb,
        actor: &DeviceActor,
        command: SubtreeFileCountsCommand,
    ) -> Result<Vec<SubtreeFileCount>, AppError> {
        let SubtreeFileCountsCommand {
            device_id,
            parent_entry_id,
            directory_entry_ids,
        } = command;
        let device_id = DeviceVisibility::verify_file_registry_access(
            main_db,
            actor,
            device_id,
            FileRegistryDeviceAccess::Read,
        )
        .await?;
        validate_subtree_count_directories(&directory_entry_ids)
            .map_err(map_read_error)?;

        FilesystemRepository::new(file_registry_db)
            .count_file_subtrees(
                device_id,
                parent_entry_id,
                &directory_entry_ids,
            )
            .await
            .map_err(map_read_error)
    }

    pub(in crate::devices) async fn journal(
        main_db: MainDb<'_, DatabaseConnection>,
        file_registry_db: &FileRegistryDb,
        actor: &DeviceActor,
        command: JournalFilesCommand,
    ) -> Result<JournalFilesResult, AppError> {
        let JournalFilesCommand {
            device_id,
            limit,
            cursor,
        } = command;
        let device_id = DeviceVisibility::verify_file_registry_access(
            main_db,
            actor,
            device_id,
            FileRegistryDeviceAccess::Read,
        )
        .await?;
        let repository = FilesystemRepository::new(file_registry_db);
        let after = match cursor {
            Some(cursor) => {
                let boundary_file_id =
                    FileCursorCodec::decode(&cursor).map_err(map_read_error)?;
                Some(
                    repository
                        .resolve_file_journal_cursor(
                            device_id,
                            boundary_file_id,
                        )
                        .await
                        .map_err(map_read_error)?,
                )
            }
            None => None,
        };
        let page =
            KeysetPageRequest::try_new(limit, after).map_err(map_read_error)?;
        let (page, total_count) = repository
            .list_file_journal_with_total(device_id, page)
            .await
            .map_err(map_read_error)?;

        Ok(JournalFilesResult {
            total_count,
            entries: page.entries,
            next_cursor: page
                .next
                .map(|sort_key| FileCursorCodec::encode(sort_key.file_id())),
        })
    }

    pub(in crate::devices) async fn browse(
        main_db: MainDb<'_, DatabaseConnection>,
        file_registry_db: &FileRegistryDb,
        actor: &DeviceActor,
        command: BrowseFilesCommand,
    ) -> Result<BrowseFilesResult, AppError> {
        let BrowseFilesCommand {
            device_id,
            parent_entry_id,
            include_breadcrumbs,
            limit,
            cursor,
        } = command;
        let device_id = DeviceVisibility::verify_file_registry_access(
            main_db,
            actor,
            device_id,
            FileRegistryDeviceAccess::Read,
        )
        .await?;
        let repository = FilesystemRepository::new(file_registry_db);
        let scope = repository
            .find_directory_scope(device_id, parent_entry_id)
            .await
            .map_err(map_read_error)?;
        let after = match cursor {
            Some(cursor) => {
                let boundary_entry_id =
                    FileCursorCodec::decode(&cursor).map_err(map_read_error)?;
                let query_scope = EntryQueryScope::Browse(&scope);
                Some(
                    repository
                        .resolve_cursor_entry_sort_key(
                            boundary_entry_id,
                            &query_scope,
                        )
                        .await
                        .map_err(map_read_error)?,
                )
            }
            None => None,
        };
        let page =
            KeysetPageRequest::try_new(limit, after).map_err(map_read_error)?;
        let page = repository
            .list_children(&scope, page)
            .await
            .map_err(map_read_error)?;
        let entry_path_components = repository
            .load_path_components(&page.entries)
            .await
            .map_err(map_read_error)?;
        let breadcrumbs = if include_breadcrumbs {
            repository
                .list_breadcrumbs(&scope)
                .await
                .map_err(map_read_error)?
        } else {
            Vec::new()
        };

        Ok(BrowseFilesResult {
            breadcrumbs,
            entries: page.entries,
            entry_path_components,
            next_cursor: page.next.map(|entry_sort_key| {
                FileCursorCodec::encode(entry_sort_key.entry_id())
            }),
        })
    }

    pub(in crate::devices) async fn search(
        main_db: MainDb<'_, DatabaseConnection>,
        file_registry_db: &FileRegistryDb,
        actor: &DeviceActor,
        command: SearchFilesCommand,
    ) -> Result<SearchFilesResult, AppError> {
        let SearchFilesCommand {
            device_id,
            scope_entry_id,
            filters,
            limit,
            cursor,
        } = command;
        let device_id = DeviceVisibility::verify_file_registry_access(
            main_db,
            actor,
            device_id,
            FileRegistryDeviceAccess::Read,
        )
        .await?;
        let filters =
            FileSearchFilters::try_from(filters).map_err(map_read_error)?;
        let repository = FilesystemRepository::new(file_registry_db);
        let scope = repository
            .find_directory_scope(device_id, scope_entry_id)
            .await
            .map_err(map_read_error)?;
        let after = match cursor {
            Some(cursor) => {
                let boundary_entry_id =
                    FileCursorCodec::decode(&cursor).map_err(map_read_error)?;
                let query_scope = EntryQueryScope::Search {
                    directory: &scope,
                    filters: &filters,
                };
                Some(
                    repository
                        .resolve_cursor_entry_sort_key(
                            boundary_entry_id,
                            &query_scope,
                        )
                        .await
                        .map_err(map_read_error)?,
                )
            }
            None => None,
        };
        let page =
            KeysetPageRequest::try_new(limit, after).map_err(map_read_error)?;
        let page = repository
            .search_entries(&scope, &filters, page)
            .await
            .map_err(map_read_error)?;

        Ok(SearchFilesResult {
            entries: page.entries,
            next_cursor: page.next.map(|entry_sort_key| {
                FileCursorCodec::encode(entry_sort_key.entry_id())
            }),
        })
    }
    pub(in crate::devices) async fn sync(
        main_db: MainDb<'_, DatabaseConnection>,
        file_registry_db: &FileRegistryDb,
        actor: &DeviceActor,
        command: SyncFilesCommand,
    ) -> Result<SyncFilesResult, AppError> {
        actor.require_source_write()?;
        validate_sync_batch_size(command.files.len())
            .map_err(map_sync_error)?;
        let duplicate_file_ids = duplicate_file_ids(&command.files);
        let SyncFilesCommand {
            device_id,
            path_syntax,
            files,
        } = command;
        let device_id = DeviceVisibility::verify_file_registry_access(
            main_db,
            actor,
            device_id,
            FileRegistryDeviceAccess::SourceWrite,
        )
        .await?;

        let repository = FilesystemRepository::new(file_registry_db);
        sync_files(
            &repository,
            device_id,
            path_syntax,
            files,
            duplicate_file_ids,
        )
        .await
        .map_err(map_sync_error)
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devices::filesystem::FilesystemFieldError;

    #[test]
    fn read_error_mapping_preserves_application_taxonomy() {
        let validation = map_read_error(FilesystemError::Validation(vec![
            FilesystemFieldError {
                path: "cursor".to_string(),
                message: "invalid cursor".to_string(),
            },
            FilesystemFieldError {
                path: "name_query".to_string(),
                message: "must not be empty".to_string(),
            },
        ]));
        let AppError::Form(errors) = validation else {
            panic!("validation must map to form errors");
        };
        assert_eq!(errors.get("cursor"), Some(&"invalid cursor".to_string()));
        assert_eq!(
            errors.get("name_query"),
            Some(&"must not be empty".to_string())
        );

        assert!(matches!(
            map_read_error(FilesystemError::NotFound),
            AppError::NotFound
        ));
        assert!(matches!(
            map_read_error(FilesystemError::Invariant("internal_detail")),
            AppError::BL { msg }
                if msg == "device filesystem invariant violated"
        ));

        let internal = map_read_error(FilesystemError::Internal(
            anyhow::anyhow!("database connection failed"),
        ));
        let AppError::AnyhowError { source } = internal else {
            panic!("internal filesystem error must retain its source");
        };
        assert_eq!(source.to_string(), "failed to read device filesystem");
        assert!(source.chain().any(|error| matches!(
            error.downcast_ref::<FilesystemError>(),
            Some(FilesystemError::Internal(_))
        )));
    }

    #[test]
    fn sync_commit_uncertainty_remains_fatal_with_its_source() {
        let error = map_sync_error(FilesystemError::CommitUncertain(
            anyhow::anyhow!("stage-eleven-uncertain"),
        ));
        let AppError::AnyhowError { source } = error else {
            panic!("commit uncertainty must remain a top-level error");
        };
        assert_eq!(source.to_string(), "failed to sync device filesystem");
        assert!(source.chain().any(|error| matches!(
            error.downcast_ref::<FilesystemError>(),
            Some(FilesystemError::CommitUncertain(_))
        )));
        assert!(source
            .chain()
            .any(|error| error.to_string().contains("stage-eleven-uncertain")));
    }
}
