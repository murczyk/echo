mod cursor;
mod error;
mod ltree;
mod metadata;
mod mutation;
mod path;
mod query;
mod repository;
#[allow(dead_code)]
mod service;
mod sync;

mod types;
mod validation;

#[allow(unused_imports)]
pub(in crate::devices) use cursor::FileCursorCodec;
pub(in crate::devices) use error::FilesystemError;
#[allow(unused_imports)]
pub(in crate::devices) use error::FilesystemFieldError;
pub(in crate::devices::filesystem) use error::{
    classify_transaction_error, map_database_error, map_transaction_body_error,
    TransactionErrorClass,
};
#[cfg(test)]
pub(in crate::devices::filesystem) use ltree::{
    ancestor_expr, descendant_expr,
};
#[allow(unused_imports)]
pub(in crate::devices) use metadata::normalize_file_metadata;
#[allow(unused_imports)]
pub(in crate::devices) use path::SourcePathParser;
pub(in crate::devices) use repository::FilesystemRepository;
#[allow(unused_imports)]
pub(in crate::devices) use service::FileMetadataService;
#[allow(unused_imports)]
pub(in crate::devices) use types::{
    Breadcrumb, BrowseFilesCommand, BrowseFilesResult, DirectoryEntry,
    DirectoryScope, EntryQueryScope, EntrySortKey, FileMutationResult,
    FileSearchFilters, KeysetPage, KeysetPageRequest, NormalizedFileMetadata,
    ParsedSourcePath, RawFileSearchFilters, RootEntry, RootSortKey,
    SearchEntry, SearchFilesCommand, SearchFilesResult, SyncFileItemCommand,
    SyncFileItemOutcome, SyncFileItemResult, SyncFileOperation,
    SyncFileRejectionKind, SyncFilesCommand, SyncFilesResult, TreeEntry,
};
pub(in crate::devices) use types::{
    FileEntry, FileEntryKind, OffsetPage, OffsetPageRequest, PathSyntax,
    PreparedFileMutation,
};

#[cfg(test)]
mod tests;
