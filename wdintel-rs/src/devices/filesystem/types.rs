use super::error::{FilesystemError, FilesystemFieldError};
use chrono::{DateTime, FixedOffset, NaiveDateTime};
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

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) enum DirectoryScope {
    Root(RootEntry),
    Directory {
        entry: DirectoryEntry,
        root_id: Uuid,
        path_syntax: PathSyntax,
    },
}

#[allow(dead_code)]
impl DirectoryScope {
    pub(in crate::devices) fn device_id(&self) -> Uuid {
        match self {
            Self::Root(root) => root.device_id,
            Self::Directory { entry, .. } => entry.device_id,
        }
    }

    pub(in crate::devices) fn entry_id(&self) -> Uuid {
        match self {
            Self::Root(root) => root.entry_id,
            Self::Directory { entry, .. } => entry.entry_id,
        }
    }

    pub(in crate::devices) fn root_id(&self) -> Uuid {
        match self {
            Self::Root(root) => root.entry_id,
            Self::Directory { root_id, .. } => *root_id,
        }
    }

    pub(in crate::devices) fn path_syntax(&self) -> PathSyntax {
        match self {
            Self::Root(root) => root.path_syntax,
            Self::Directory { path_syntax, .. } => *path_syntax,
        }
    }

    pub(super) fn hierarchy_path(&self) -> &str {
        match self {
            Self::Root(root) => &root.hierarchy_path,
            Self::Directory { entry, .. } => &entry.hierarchy_path,
        }
    }
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
pub(in crate::devices) struct SearchEntry {
    pub(in crate::devices) entry: TreeEntry,
    pub(in crate::devices) path_components: Vec<String>,
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
    path_syntax: PathSyntax,
    name_key: Vec<u8>,
    entry_id: Uuid,
}

#[allow(dead_code)]
impl RootSortKey {
    pub(super) fn new(
        path_syntax: PathSyntax,
        name_key: Vec<u8>,
        entry_id: Uuid,
    ) -> Self {
        Self {
            path_syntax,
            name_key,
            entry_id,
        }
    }

    pub(super) fn path_syntax(&self) -> PathSyntax {
        self.path_syntax
    }

    pub(super) fn name_key(&self) -> &[u8] {
        &self.name_key
    }

    pub(super) fn entry_id(&self) -> Uuid {
        self.entry_id
    }
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(in crate::devices) struct EntrySortKey {
    kind: FileEntryKind,
    name_key: Vec<u8>,
    entry_id: Uuid,
}

#[allow(dead_code)]
impl EntrySortKey {
    pub(super) fn new(
        kind: FileEntryKind,
        name_key: Vec<u8>,
        entry_id: Uuid,
    ) -> Self {
        Self {
            kind,
            name_key,
            entry_id,
        }
    }

    pub(super) fn kind(&self) -> FileEntryKind {
        self.kind
    }

    pub(super) fn name_key(&self) -> &[u8] {
        &self.name_key
    }

    pub(super) fn entry_id(&self) -> Uuid {
        self.entry_id
    }
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct KeysetPageRequest<K> {
    limit: u64,
    after: Option<K>,
}

#[allow(dead_code)]
impl<K> KeysetPageRequest<K> {
    pub(in crate::devices) fn try_new(
        limit: Option<u64>,
        after: Option<K>,
    ) -> Result<Self, FilesystemError> {
        let limit =
            limit.unwrap_or(crate::config::DEVICE_FILE_PAGE_DEFAULT_LIMIT);
        if !(1..=crate::config::DEVICE_FILE_PAGE_MAX_LIMIT).contains(&limit) {
            return Err(FilesystemError::Validation(vec![
                FilesystemFieldError {
                    path: "limit".to_string(),
                    message: format!(
                        "must be between 1 and {}",
                        crate::config::DEVICE_FILE_PAGE_MAX_LIMIT
                    ),
                },
            ]));
        }
        Ok(Self { limit, after })
    }

    pub(in crate::devices) fn limit(&self) -> u64 {
        self.limit
    }

    pub(in crate::devices) fn after(&self) -> Option<&K> {
        self.after.as_ref()
    }
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
pub(in crate::devices) struct RawFileSearchFilters {
    pub(in crate::devices) kinds: Vec<FileEntryKind>,
    pub(in crate::devices) name_query: Option<String>,
    pub(in crate::devices) mime_types: Vec<String>,
    pub(in crate::devices) extensions: Vec<String>,
    pub(in crate::devices) file_metadata_modified_from: Option<NaiveDateTime>,
    pub(in crate::devices) file_metadata_modified_to: Option<NaiveDateTime>,
}
#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct BrowseFilesCommand {
    pub(in crate::devices) device_id: Uuid,
    pub(in crate::devices) parent_entry_id: Uuid,
    pub(in crate::devices) include_breadcrumbs: bool,
    pub(in crate::devices) limit: Option<u64>,
    pub(in crate::devices) cursor: Option<String>,
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct BrowseFilesResult {
    pub(in crate::devices) breadcrumbs: Vec<Breadcrumb>,
    pub(in crate::devices) entries: Vec<TreeEntry>,
    pub(in crate::devices) next_cursor: Option<String>,
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct SearchFilesCommand {
    pub(in crate::devices) device_id: Uuid,
    pub(in crate::devices) scope_entry_id: Uuid,
    pub(in crate::devices) filters: RawFileSearchFilters,
    pub(in crate::devices) limit: Option<u64>,
    pub(in crate::devices) cursor: Option<String>,
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct SearchFilesResult {
    pub(in crate::devices) entries: Vec<SearchEntry>,
    pub(in crate::devices) next_cursor: Option<String>,
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct FileSearchFilters {
    kinds: Vec<FileEntryKind>,
    name_query: Option<String>,
    mime_types: Vec<String>,
    extensions: Vec<String>,
    file_metadata_modified_from: Option<NaiveDateTime>,
    file_metadata_modified_to: Option<NaiveDateTime>,
}

#[allow(dead_code)]
impl FileSearchFilters {
    pub(super) fn from_validated_parts(
        kinds: Vec<FileEntryKind>,
        name_query: Option<String>,
        mime_types: Vec<String>,
        extensions: Vec<String>,
        file_metadata_modified_from: Option<NaiveDateTime>,
        file_metadata_modified_to: Option<NaiveDateTime>,
    ) -> Self {
        Self {
            kinds,
            name_query,
            mime_types,
            extensions,
            file_metadata_modified_from,
            file_metadata_modified_to,
        }
    }

    pub(super) fn kinds(&self) -> &[FileEntryKind] {
        &self.kinds
    }

    pub(super) fn name_query(&self) -> Option<&str> {
        self.name_query.as_deref()
    }

    pub(super) fn mime_types(&self) -> &[String] {
        &self.mime_types
    }

    pub(super) fn extensions(&self) -> &[String] {
        &self.extensions
    }

    pub(super) fn file_metadata_modified_from(&self) -> Option<NaiveDateTime> {
        self.file_metadata_modified_from
    }

    pub(super) fn file_metadata_modified_to(&self) -> Option<NaiveDateTime> {
        self.file_metadata_modified_to
    }

    pub(super) fn requires_file_metadata(&self) -> bool {
        !self.mime_types.is_empty()
            || !self.extensions.is_empty()
            || self.file_metadata_modified_from.is_some()
            || self.file_metadata_modified_to.is_some()
    }
}

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::devices) enum EntryQueryScope<'a> {
    Browse(&'a DirectoryScope),
    Search {
        directory: &'a DirectoryScope,
        filters: &'a FileSearchFilters,
    },
}

#[allow(dead_code)]
impl EntryQueryScope<'_> {
    pub(super) fn directory(&self) -> &DirectoryScope {
        match self {
            Self::Browse(directory) | Self::Search { directory, .. } => {
                directory
            }
        }
    }

    pub(super) fn device_id(&self) -> Uuid {
        self.directory().device_id()
    }

    pub(super) fn entry_id(&self) -> Uuid {
        self.directory().entry_id()
    }

    pub(super) fn filters(&self) -> Option<&FileSearchFilters> {
        match self {
            Self::Browse(_) => None,
            Self::Search { filters, .. } => Some(filters),
        }
    }
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
impl ParsedSourcePath {
    pub(in crate::devices) fn file_name(&self) -> &str {
        self.components
            .last()
            .expect("parsed source path has a file component")
    }
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct SyncFilesCommand {
    pub(in crate::devices) device_id: Uuid,
    pub(in crate::devices) path_syntax: PathSyntax,
    pub(in crate::devices) files: Vec<SyncFileItemCommand>,
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq)]
pub(in crate::devices) struct SyncFilesResult {
    pub(in crate::devices) results: Vec<SyncFileItemResult>,
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct SyncFileItemCommand {
    pub(in crate::devices) file_id: Option<Uuid>,
    pub(in crate::devices) absolute_path: String,
    pub(in crate::devices) mime_type: Option<String>,
    pub(in crate::devices) extension: Option<String>,
    pub(in crate::devices) file_metadata_created_at:
        Option<DateTime<FixedOffset>>,
    pub(in crate::devices) file_metadata_modified_at:
        Option<DateTime<FixedOffset>>,
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct NormalizedFileMetadata {
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
pub(in crate::devices) struct PreparedFileMutation {
    pub(super) device_id: Uuid,
    pub(super) operation: SyncFileOperation,
    pub(super) file_id: Uuid,
    pub(super) candidate_root_entry_id: Uuid,
    pub(super) candidate_directory_entry_ids: Vec<Uuid>,
    pub(super) source_path: ParsedSourcePath,
    pub(super) metadata: NormalizedFileMetadata,
}

#[allow(dead_code)]
impl PreparedFileMutation {
    pub(in crate::devices) fn for_create(
        device_id: Uuid,
        source_path: ParsedSourcePath,
        metadata: NormalizedFileMetadata,
    ) -> Self {
        Self::new(
            device_id,
            SyncFileOperation::Created,
            Uuid::now_v7(),
            source_path,
            metadata,
        )
    }

    pub(in crate::devices) fn for_update(
        device_id: Uuid,
        file_id: Uuid,
        source_path: ParsedSourcePath,
        metadata: NormalizedFileMetadata,
    ) -> Self {
        Self::new(
            device_id,
            SyncFileOperation::Updated,
            file_id,
            source_path,
            metadata,
        )
    }

    fn new(
        device_id: Uuid,
        operation: SyncFileOperation,
        file_id: Uuid,
        source_path: ParsedSourcePath,
        metadata: NormalizedFileMetadata,
    ) -> Self {
        let candidate_directory_count = source_path
            .components
            .len()
            .checked_sub(1)
            .expect("parsed source path has a file component");

        Self {
            device_id,
            operation,
            file_id,
            candidate_root_entry_id: Uuid::now_v7(),
            candidate_directory_entry_ids: (0..candidate_directory_count)
                .map(|_| Uuid::now_v7())
                .collect(),
            source_path,
            metadata,
        }
    }
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct FileMutationResult {
    pub(in crate::devices) operation: SyncFileOperation,
    pub(in crate::devices) root: RootEntry,
    pub(in crate::devices) file: FileEntry,
    pub(in crate::devices) path_components: Vec<String>,
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
            RootSortKey::new(PathSyntax::Posix, b"z".to_vec(), highest_id)
                < RootSortKey::new(
                    PathSyntax::Windows,
                    b"a".to_vec(),
                    lowest_id
                )
        );
        assert!(
            RootSortKey::new(PathSyntax::Posix, b"Z".to_vec(), highest_id)
                < RootSortKey::new(PathSyntax::Posix, b"a".to_vec(), lowest_id)
        );
        assert!(
            RootSortKey::new(PathSyntax::Posix, b"same".to_vec(), lowest_id)
                < RootSortKey::new(
                    PathSyntax::Posix,
                    b"same".to_vec(),
                    highest_id
                )
        );
    }

    #[test]
    fn entry_sort_key_uses_kind_name_and_uuid_order() {
        let lowest_id = Uuid::from_u128(1);
        let highest_id = Uuid::from_u128(2);

        assert!(
            EntrySortKey::new(
                FileEntryKind::Directory,
                b"z".to_vec(),
                highest_id
            ) < EntrySortKey::new(
                FileEntryKind::File,
                b"a".to_vec(),
                lowest_id
            )
        );
        assert!(
            EntrySortKey::new(FileEntryKind::File, b"Z".to_vec(), highest_id)
                < EntrySortKey::new(
                    FileEntryKind::File,
                    b"a".to_vec(),
                    lowest_id
                )
        );
        assert!(
            EntrySortKey::new(FileEntryKind::File, b"same".to_vec(), lowest_id)
                < EntrySortKey::new(
                    FileEntryKind::File,
                    b"same".to_vec(),
                    highest_id
                )
        );
    }

    #[test]
    fn directory_and_query_scopes_preserve_one_navigation_scope() {
        let device_id = Uuid::from_u128(1);
        let root_id = Uuid::from_u128(2);
        let directory_id = Uuid::from_u128(3);
        let timestamp = chrono::NaiveDate::from_ymd_opt(2026, 7, 21)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap();
        let root_scope = DirectoryScope::Root(RootEntry {
            entry_id: root_id,
            device_id,
            name: "root".to_string(),
            name_key: b"root".to_vec(),
            path_syntax: PathSyntax::Posix,
            hierarchy_path: "n00000000000000000000000000000002".to_string(),
            created_at: timestamp,
            updated_at: timestamp,
        });
        let directory_scope = DirectoryScope::Directory {
            entry: DirectoryEntry {
                entry_id: directory_id,
                device_id,
                parent_entry_id: root_id,
                name: "directory".to_string(),
                name_key: b"directory".to_vec(),
                hierarchy_path:
                    "n00000000000000000000000000000002.n00000000000000000000000000000003"
                        .to_string(),
                created_at: timestamp,
                updated_at: timestamp,
            },
            root_id,
            path_syntax: PathSyntax::Posix,
        };
        let filters = FileSearchFilters::try_from(RawFileSearchFilters {
            kinds: vec![FileEntryKind::File],
            name_query: Some("abc".to_string()),
            mime_types: Vec::new(),
            extensions: Vec::new(),
            file_metadata_modified_from: None,
            file_metadata_modified_to: None,
        })
        .unwrap();

        let browse = EntryQueryScope::Browse(&root_scope);
        assert_eq!(browse.device_id(), device_id);
        assert_eq!(browse.entry_id(), root_id);
        assert_eq!(browse.directory(), &root_scope);
        assert_eq!(browse.filters(), None);
        assert_eq!(
            root_scope.hierarchy_path(),
            "n00000000000000000000000000000002"
        );

        let search = EntryQueryScope::Search {
            directory: &directory_scope,
            filters: &filters,
        };
        assert_eq!(search.device_id(), device_id);
        assert_eq!(search.entry_id(), directory_id);
        assert_eq!(search.directory(), &directory_scope);
        assert_eq!(search.filters(), Some(&filters));
        assert_eq!(
            directory_scope.hierarchy_path(),
            "n00000000000000000000000000000002.n00000000000000000000000000000003"
        );
        assert_eq!(directory_scope.root_id(), root_id);
        assert_eq!(directory_scope.path_syntax(), PathSyntax::Posix);
    }
}
