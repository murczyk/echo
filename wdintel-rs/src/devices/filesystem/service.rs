use super::{
    BrowseFilesCommand, BrowseFilesResult, EntryQueryScope, FileCursorCodec,
    FileSearchFilters, FilesystemError, FilesystemRepository,
    KeysetPageRequest, RootEntry, SearchFilesCommand, SearchFilesResult,
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
}

fn map_read_error(error: FilesystemError) -> AppError {
    match error {
        FilesystemError::Validation(errors) => AppError::Form(
            errors
                .into_iter()
                .map(|error| (error.path, error.message))
                .collect(),
        ),
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
                path: "filters.name_query".to_string(),
                message: "must not be empty".to_string(),
            },
        ]));
        let AppError::Form(errors) = validation else {
            panic!("validation must map to form errors");
        };
        assert_eq!(errors.get("cursor"), Some(&"invalid cursor".to_string()));
        assert_eq!(
            errors.get("filters.name_query"),
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
}
