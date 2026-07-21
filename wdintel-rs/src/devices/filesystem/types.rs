use super::error::{FilesystemError, FilesystemFieldError};
use chrono::NaiveDateTime;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(in crate::devices) enum PathSyntax {
    Posix,
    Windows,
}

impl PathSyntax {
    pub(in crate::devices) fn as_db_str(self) -> &'static str {
        match self {
            Self::Posix => "posix",
            Self::Windows => "windows",
        }
    }
}

impl TryFrom<&str> for PathSyntax {
    type Error = FilesystemError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "posix" => Ok(Self::Posix),
            "windows" => Ok(Self::Windows),
            _ => Err(FilesystemError::Invariant("unknown_path_syntax")),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(in crate::devices) enum FileEntryKind {
    Directory,
    File,
}

impl FileEntryKind {
    pub(in crate::devices) fn as_db_str(self) -> &'static str {
        match self {
            Self::Directory => "directory",
            Self::File => "file",
        }
    }
}

impl TryFrom<&str> for FileEntryKind {
    type Error = FilesystemError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "directory" => Ok(Self::Directory),
            "file" => Ok(Self::File),
            _ => Err(FilesystemError::Invariant("unknown_file_entry_kind")),
        }
    }
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct RootEntry {
    pub(in crate::devices) entry_id: Uuid,
    pub(in crate::devices) device_id: Uuid,
    pub(in crate::devices) name: String,
    pub(in crate::devices) name_key: Vec<u8>,
    pub(in crate::devices) path_syntax: PathSyntax,
    pub(in crate::devices) hierarchy_path: String,
    pub(in crate::devices) created_at: NaiveDateTime,
    pub(in crate::devices) updated_at: NaiveDateTime,
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct DirectoryEntry {
    pub(in crate::devices) entry_id: Uuid,
    pub(in crate::devices) device_id: Uuid,
    pub(in crate::devices) parent_entry_id: Uuid,
    pub(in crate::devices) name: String,
    pub(in crate::devices) name_key: Vec<u8>,
    pub(in crate::devices) hierarchy_path: String,
    pub(in crate::devices) created_at: NaiveDateTime,
    pub(in crate::devices) updated_at: NaiveDateTime,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct FileEntry {
    pub(in crate::devices) file_id: Uuid,
    pub(in crate::devices) device_id: Uuid,
    pub(in crate::devices) parent_entry_id: Uuid,
    pub(in crate::devices) name: String,
    pub(in crate::devices) name_key: Vec<u8>,
    pub(in crate::devices) path_syntax: PathSyntax,
    pub(in crate::devices) absolute_path: String,
    pub(in crate::devices) hierarchy_path: String,
    pub(in crate::devices) mime_type: Option<String>,
    pub(in crate::devices) extension: Option<String>,
    pub(in crate::devices) file_metadata_created_at: Option<NaiveDateTime>,
    pub(in crate::devices) file_metadata_modified_at: Option<NaiveDateTime>,
    pub(in crate::devices) created_at: NaiveDateTime,
    pub(in crate::devices) updated_at: NaiveDateTime,
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) enum TreeEntry {
    Directory(DirectoryEntry),
    File(FileEntry),
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct Breadcrumb {
    pub(in crate::devices) entry_id: Uuid,
    pub(in crate::devices) name: String,
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(in crate::devices) struct RootSortKey {
    pub(in crate::devices) path_syntax: PathSyntax,
    pub(in crate::devices) name_key: Vec<u8>,
    pub(in crate::devices) entry_id: Uuid,
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(in crate::devices) struct EntrySortKey {
    pub(in crate::devices) kind: FileEntryKind,
    pub(in crate::devices) name_key: Vec<u8>,
    pub(in crate::devices) entry_id: Uuid,
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct KeysetPageRequest<K> {
    pub(in crate::devices) limit: u64,
    pub(in crate::devices) after: Option<K>,
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct KeysetPage<T, K> {
    pub(in crate::devices) entries: Vec<T>,
    pub(in crate::devices) next: Option<K>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct OffsetPageRequest {
    pub(in crate::devices) limit: u64,
    pub(in crate::devices) offset: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct OffsetPage<T> {
    pub(in crate::devices) entries: Vec<T>,
    pub(in crate::devices) total: u64,
    pub(in crate::devices) has_more: bool,
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct FileSearchFilters {
    pub(in crate::devices) kinds: Vec<FileEntryKind>,
    pub(in crate::devices) name_query: Option<String>,
    pub(in crate::devices) mime_types: Vec<String>,
    pub(in crate::devices) extensions: Vec<String>,
    pub(in crate::devices) file_metadata_modified_from: Option<NaiveDateTime>,
    pub(in crate::devices) file_metadata_modified_to: Option<NaiveDateTime>,
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct ParsedSourcePath {
    pub(in crate::devices) path_syntax: PathSyntax,
    pub(in crate::devices) absolute_path: String,
    pub(in crate::devices) root_name: String,
    pub(in crate::devices) components: Vec<String>,
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct SyncFileItemCommand {
    pub(in crate::devices) file_id: Option<Uuid>,
    pub(in crate::devices) absolute_path: String,
    pub(in crate::devices) mime_type: Option<String>,
    pub(in crate::devices) extension: Option<String>,
    pub(in crate::devices) file_metadata_created_at: Option<NaiveDateTime>,
    pub(in crate::devices) file_metadata_modified_at: Option<NaiveDateTime>,
}

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::devices) enum SyncFileOperation {
    Created,
    Updated,
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct SyncFileItemResult {
    pub(in crate::devices) index: usize,
    pub(in crate::devices) outcome: SyncFileItemOutcome,
}

#[allow(clippy::large_enum_variant)]
#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) enum SyncFileItemOutcome {
    Accepted {
        operation: SyncFileOperation,
        root: RootEntry,
        file: FileEntry,
        path_components: Vec<String>,
    },
    Rejected {
        kind: SyncFileRejectionKind,
        message: String,
        retry: bool,
        field_errors: Vec<FilesystemFieldError>,
    },
}

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::devices) enum SyncFileRejectionKind {
    Validation,
    NotFound,
    Conflict,
    Dependency,
    Internal,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_syntax_db_literals_round_trip() {
        for (db_literal, expected) in [
            ("posix", PathSyntax::Posix),
            ("windows", PathSyntax::Windows),
        ] {
            assert_eq!(PathSyntax::try_from(db_literal).unwrap(), expected);
            assert_eq!(expected.as_db_str(), db_literal);
        }

        assert!(matches!(
            PathSyntax::try_from("unknown"),
            Err(FilesystemError::Invariant("unknown_path_syntax"))
        ));
    }

    #[test]
    fn file_entry_kind_db_literals_round_trip() {
        for (db_literal, expected) in [
            ("directory", FileEntryKind::Directory),
            ("file", FileEntryKind::File),
        ] {
            assert_eq!(FileEntryKind::try_from(db_literal).unwrap(), expected);
            assert_eq!(expected.as_db_str(), db_literal);
        }

        assert!(matches!(
            FileEntryKind::try_from("unknown"),
            Err(FilesystemError::Invariant("unknown_file_entry_kind"))
        ));
    }

    #[test]
    fn root_sort_key_uses_syntax_name_and_uuid_order() {
        let lowest_id = Uuid::from_u128(1);
        let highest_id = Uuid::from_u128(2);

        assert!(
            RootSortKey {
                path_syntax: PathSyntax::Posix,
                name_key: b"z".to_vec(),
                entry_id: highest_id,
            } < RootSortKey {
                path_syntax: PathSyntax::Windows,
                name_key: b"a".to_vec(),
                entry_id: lowest_id,
            }
        );
        assert!(
            RootSortKey {
                path_syntax: PathSyntax::Posix,
                name_key: b"Z".to_vec(),
                entry_id: highest_id,
            } < RootSortKey {
                path_syntax: PathSyntax::Posix,
                name_key: b"a".to_vec(),
                entry_id: lowest_id,
            }
        );
        assert!(
            RootSortKey {
                path_syntax: PathSyntax::Posix,
                name_key: b"same".to_vec(),
                entry_id: lowest_id,
            } < RootSortKey {
                path_syntax: PathSyntax::Posix,
                name_key: b"same".to_vec(),
                entry_id: highest_id,
            }
        );
    }

    #[test]
    fn entry_sort_key_uses_kind_name_and_uuid_order() {
        let lowest_id = Uuid::from_u128(1);
        let highest_id = Uuid::from_u128(2);

        assert!(
            EntrySortKey {
                kind: FileEntryKind::Directory,
                name_key: b"z".to_vec(),
                entry_id: highest_id,
            } < EntrySortKey {
                kind: FileEntryKind::File,
                name_key: b"a".to_vec(),
                entry_id: lowest_id,
            }
        );
        assert!(
            EntrySortKey {
                kind: FileEntryKind::File,
                name_key: b"Z".to_vec(),
                entry_id: highest_id,
            } < EntrySortKey {
                kind: FileEntryKind::File,
                name_key: b"a".to_vec(),
                entry_id: lowest_id,
            }
        );
        assert!(
            EntrySortKey {
                kind: FileEntryKind::File,
                name_key: b"same".to_vec(),
                entry_id: lowest_id,
            } < EntrySortKey {
                kind: FileEntryKind::File,
                name_key: b"same".to_vec(),
                entry_id: highest_id,
            }
        );
    }
}
