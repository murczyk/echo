use super::{query, FileEntry, FilesystemError, OffsetPage, OffsetPageRequest};
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
}
