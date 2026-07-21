use super::{
    query, DirectoryScope, EntryQueryScope, EntrySortKey, FileEntry,
    FilesystemError, OffsetPage, OffsetPageRequest,
};
use crate::file_registry::FileRegistryDb;
use uuid::Uuid;

pub(in crate::devices) struct FilesystemRepository<'db> {
    file_registry_db: &'db FileRegistryDb,
}

impl<'db> FilesystemRepository<'db> {
    pub(in crate::devices) fn new(
        file_registry_db: &'db FileRegistryDb,
    ) -> Self {
        Self { file_registry_db }
    }

    pub(in crate::devices) async fn list_files_offset(
        &self,
        device_id: Uuid,
        page: OffsetPageRequest,
    ) -> Result<OffsetPage<FileEntry>, FilesystemError> {
        query::list_files_offset(
            self.file_registry_db.connection(),
            device_id,
            page,
        )
        .await
    }

    #[allow(dead_code)]
    pub(in crate::devices) async fn find_directory_scope(
        &self,
        device_id: Uuid,
        entry_id: Uuid,
    ) -> Result<DirectoryScope, FilesystemError> {
        query::find_directory_scope(
            self.file_registry_db.connection(),
            device_id,
            entry_id,
        )
        .await
    }

    #[allow(dead_code)]
    pub(in crate::devices) async fn resolve_cursor_entry_sort_key(
        &self,
        boundary_entry_id: Uuid,
        scope: &EntryQueryScope<'_>,
    ) -> Result<EntrySortKey, FilesystemError> {
        query::resolve_cursor_entry_sort_key(
            self.file_registry_db.connection(),
            boundary_entry_id,
            scope,
        )
        .await
    }
}
