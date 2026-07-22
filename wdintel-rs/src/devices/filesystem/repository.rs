use super::{
    mutation, query, Breadcrumb, DirectoryScope, EntryQueryScope, EntrySortKey,
    FileEntry, FileMutationResult, FileSearchFilters, FilesystemError,
    KeysetPage, KeysetPageRequest, OffsetPage, OffsetPageRequest,
    PreparedFileMutation, RootEntry, SearchEntry, TreeEntry,
};
use crate::file_registry::FileRegistryDb;
use crate::h;
use crate::types::ShortContext;
use sea_orm::TransactionTrait;
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

    #[allow(dead_code)]
    pub(in crate::devices) async fn mutate_file(
        &self,
        mutation: &PreparedFileMutation,
    ) -> Result<FileMutationResult, FilesystemError> {
        let transaction = self
            .file_registry_db
            .connection()
            .begin()
            .await
            .c(h!())
            .map_err(FilesystemError::Internal)?;
        let result = match mutation::mutate_file(&transaction, mutation).await {
            Ok(result) => result,
            Err(error) => {
                transaction
                    .rollback()
                    .await
                    .c(h!())
                    .map_err(FilesystemError::Internal)?;
                return Err(error);
            }
        };

        transaction
            .commit()
            .await
            .c(h!())
            .map_err(FilesystemError::CommitUncertain)?;
        Ok(result)
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
    pub(in crate::devices) async fn list_roots(
        &self,
        device_id: Uuid,
    ) -> Result<Vec<RootEntry>, FilesystemError> {
        query::list_roots(self.file_registry_db.connection(), device_id).await
    }

    #[allow(dead_code)]
    pub(in crate::devices) async fn list_children(
        &self,
        scope: &DirectoryScope,
        page: KeysetPageRequest<EntrySortKey>,
    ) -> Result<KeysetPage<TreeEntry, EntrySortKey>, FilesystemError> {
        query::list_children(self.file_registry_db.connection(), scope, page)
            .await
    }

    #[allow(dead_code)]
    pub(in crate::devices) async fn search_entries(
        &self,
        scope: &DirectoryScope,
        filters: &FileSearchFilters,
        page: KeysetPageRequest<EntrySortKey>,
    ) -> Result<KeysetPage<SearchEntry, EntrySortKey>, FilesystemError> {
        query::search_entries(
            self.file_registry_db.connection(),
            scope,
            filters,
            page,
        )
        .await
    }

    #[allow(dead_code)]
    pub(in crate::devices) async fn list_breadcrumbs(
        &self,
        scope: &DirectoryScope,
    ) -> Result<Vec<Breadcrumb>, FilesystemError> {
        query::list_breadcrumbs(self.file_registry_db.connection(), scope).await
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
