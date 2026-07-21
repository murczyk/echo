mod error;
mod query;
mod repository;
mod types;

pub(in crate::devices) use error::FilesystemError;
#[allow(unused_imports)]
pub(in crate::devices) use error::FilesystemFieldError;
pub(in crate::devices) use repository::FilesystemRepository;
#[allow(unused_imports)]
pub(in crate::devices) use types::{
    Breadcrumb, DirectoryEntry, EntrySortKey, FileSearchFilters, KeysetPage,
    KeysetPageRequest, ParsedSourcePath, RootEntry, RootSortKey,
    SyncFileItemCommand, SyncFileItemOutcome, SyncFileItemResult,
    SyncFileOperation, SyncFileRejectionKind, TreeEntry,
};
pub(in crate::devices) use types::{
    FileEntry, FileEntryKind, OffsetPage, OffsetPageRequest, PathSyntax,
};

#[cfg(test)]
mod tests;
