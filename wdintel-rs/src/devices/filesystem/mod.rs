mod cursor;
mod error;
mod ltree;
mod query;
mod repository;
mod types;
mod validation;

#[allow(unused_imports)]
pub(in crate::devices) use cursor::FileCursorCodec;
pub(in crate::devices) use error::FilesystemError;
#[allow(unused_imports)]
pub(in crate::devices) use error::FilesystemFieldError;
#[cfg(test)]
pub(in crate::devices::filesystem) use ltree::{
    ancestor_expr, descendant_expr,
};
pub(in crate::devices) use repository::FilesystemRepository;
#[allow(unused_imports)]
pub(in crate::devices) use types::{
    Breadcrumb, DirectoryEntry, DirectoryScope, EntryQueryScope, EntrySortKey,
    FileSearchFilters, KeysetPage, KeysetPageRequest, ParsedSourcePath,
    RawFileSearchFilters, RootEntry, RootSortKey, SearchEntry,
    SyncFileItemCommand, SyncFileItemOutcome, SyncFileItemResult,
    SyncFileOperation, SyncFileRejectionKind, TreeEntry,
};
pub(in crate::devices) use types::{
    FileEntry, FileEntryKind, OffsetPage, OffsetPageRequest, PathSyntax,
};

#[cfg(test)]
mod tests;
