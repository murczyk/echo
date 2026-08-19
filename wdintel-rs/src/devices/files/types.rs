use super::error::{FilesystemError, FilesystemFieldError};
use crate::devices::analytics::types::{AnalyticsTag, TagMatch};
use chrono::{DateTime, FixedOffset, NaiveDateTime};
use std::collections::BTreeMap;
use uuid::Uuid;

pub(in crate::devices) use crate::file_registry::entities::sea_orm_active_enums::FileEntryKind as DomainFileEntryKind;
pub(in crate::devices) use crate::file_registry::entities::sea_orm_active_enums::SourceFileStateKind as DomainSourceFileStateKind;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct NormalizedFileMetadata {
    pub(in crate::devices) mime_type: Option<String>,
    pub(in crate::devices) extension: Option<String>,
    pub(in crate::devices) file_metadata_created_at: Option<NaiveDateTime>,
    pub(in crate::devices) file_metadata_modified_at: Option<NaiveDateTime>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct RootEntry {
    pub(in crate::devices) entry_id: Uuid,
    pub(in crate::devices) device_id: Uuid,
    pub(in crate::devices) name: String,
    pub(in crate::devices) hierarchy_path: String,
    pub(in crate::devices) created_at: NaiveDateTime,
    pub(in crate::devices) updated_at: NaiveDateTime,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct SubtreeFileCountsCommand {
    pub(in crate::devices) device_id: Uuid,
    pub(in crate::devices) parent_entry_id: Option<Uuid>,
    pub(in crate::devices) directory_entry_ids: Vec<Uuid>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct SubtreeFileCount {
    pub(in crate::devices) entry_id: Uuid,
    pub(in crate::devices) file_count: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct DirectoryEntry {
    pub(in crate::devices) entry_id: Uuid,
    pub(in crate::devices) device_id: Uuid,
    pub(in crate::devices) parent_entry_id: Uuid,
    pub(in crate::devices) name: String,
    pub(in crate::devices) hierarchy_path: String,
    pub(in crate::devices) created_at: NaiveDateTime,
    pub(in crate::devices) updated_at: NaiveDateTime,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) enum DirectoryScope {
    Root(RootEntry),
    Directory {
        entry: DirectoryEntry,
        root_id: Uuid,
    },
}

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
    pub(in crate::devices) absolute_path: String,
    pub(in crate::devices) hierarchy_path: String,
    pub(in crate::devices) has_content: bool,
    pub(in crate::devices) mime_type: Option<String>,
    pub(in crate::devices) extension: Option<String>,
    pub(in crate::devices) file_metadata_created_at: Option<NaiveDateTime>,
    pub(in crate::devices) file_metadata_modified_at: Option<NaiveDateTime>,
    pub(in crate::devices) created_at: NaiveDateTime,
    pub(in crate::devices) updated_at: NaiveDateTime,
    pub(in crate::devices) revision: i64,
    pub(in crate::devices) sync_id: Uuid,
    pub(in crate::devices) source_file_state: Option<NormalizedSourceFileState>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct FileJournalEntry {
    pub(in crate::devices) file_id: Uuid,
    pub(in crate::devices) name: String,
    pub(in crate::devices) absolute_path: String,
    pub(in crate::devices) has_content: bool,
    pub(in crate::devices) synchronized_at: NaiveDateTime,
    pub(in crate::devices) revision: i64,
    pub(in crate::devices) sync_id: Uuid,
    pub(in crate::devices) source_file_state: Option<NormalizedSourceFileState>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) enum TreeEntry {
    Directory(DirectoryEntry),
    File(FileEntry),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct SearchEntry {
    pub(in crate::devices) entry: TreeEntry,
    pub(in crate::devices) path_components: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct Breadcrumb {
    pub(in crate::devices) entry_id: Uuid,
    pub(in crate::devices) name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct EntrySortKey {
    kind: DomainFileEntryKind,
    name: String,
    entry_id: Uuid,
}

impl EntrySortKey {
    pub(super) fn new(
        kind: DomainFileEntryKind,
        name: String,
        entry_id: Uuid,
    ) -> Self {
        Self {
            kind,
            name,
            entry_id,
        }
    }

    pub(super) fn kind(&self) -> DomainFileEntryKind {
        self.kind.clone()
    }

    pub(super) fn name(&self) -> &str {
        &self.name
    }

    pub(super) fn entry_id(&self) -> Uuid {
        self.entry_id
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct FileJournalSortKey {
    synchronized_at: NaiveDateTime,
    file_id: Uuid,
}

impl FileJournalSortKey {
    pub(super) fn new(synchronized_at: NaiveDateTime, file_id: Uuid) -> Self {
        Self {
            synchronized_at,
            file_id,
        }
    }

    pub(super) fn synchronized_at(&self) -> NaiveDateTime {
        self.synchronized_at
    }

    pub(super) fn file_id(&self) -> Uuid {
        self.file_id
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct KeysetPageRequest<K> {
    limit: u64,
    after: Option<K>,
}

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

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct KeysetPage<T, K> {
    pub(in crate::devices) entries: Vec<T>,
    pub(in crate::devices) next: Option<K>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct RawFileSearchFilters {
    pub(in crate::devices) kinds: Vec<DomainFileEntryKind>,
    pub(in crate::devices) name_query: Option<String>,
    pub(in crate::devices) mime_types: Vec<String>,
    pub(in crate::devices) extensions: Vec<String>,
    pub(in crate::devices) file_metadata_modified_from: Option<NaiveDateTime>,
    pub(in crate::devices) file_metadata_modified_to: Option<NaiveDateTime>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct BrowseFilesCommand {
    pub(in crate::devices) device_id: Uuid,
    pub(in crate::devices) parent_entry_id: Uuid,
    pub(in crate::devices) include_breadcrumbs: bool,
    pub(in crate::devices) limit: Option<u64>,
    pub(in crate::devices) cursor: Option<String>,
    pub(in crate::devices) tag_ids: Vec<String>,
    pub(in crate::devices) tag_match: Option<TagMatch>,
    pub(in crate::devices) untagged: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct BrowseFilesResult {
    pub(in crate::devices) breadcrumbs: Vec<Breadcrumb>,
    pub(in crate::devices) entries: Vec<TreeEntry>,
    pub(in crate::devices) entry_path_components: Vec<Vec<String>>,
    pub(in crate::devices) next_cursor: Option<String>,
    pub(in crate::devices) tags_by_file: BTreeMap<Uuid, Vec<AnalyticsTag>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct SearchFilesCommand {
    pub(in crate::devices) device_id: Uuid,
    pub(in crate::devices) scope_entry_id: Uuid,
    pub(in crate::devices) filters: RawFileSearchFilters,
    pub(in crate::devices) limit: Option<u64>,
    pub(in crate::devices) cursor: Option<String>,
    pub(in crate::devices) tag_ids: Vec<String>,
    pub(in crate::devices) tag_match: Option<TagMatch>,
    pub(in crate::devices) untagged: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct SearchFilesResult {
    pub(in crate::devices) entries: Vec<SearchEntry>,
    pub(in crate::devices) next_cursor: Option<String>,
    pub(in crate::devices) tags_by_file: BTreeMap<Uuid, Vec<AnalyticsTag>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct JournalFilesCommand {
    pub(in crate::devices) device_id: Uuid,
    pub(in crate::devices) limit: Option<u64>,
    pub(in crate::devices) cursor: Option<String>,
    pub(in crate::devices) tag_ids: Vec<String>,
    pub(in crate::devices) tag_match: Option<TagMatch>,
    pub(in crate::devices) untagged: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct JournalFilesResult {
    pub(in crate::devices) entries: Vec<FileJournalEntry>,
    pub(in crate::devices) next_cursor: Option<String>,
    pub(in crate::devices) total_count: u64,
    pub(in crate::devices) tags_by_file: BTreeMap<Uuid, Vec<AnalyticsTag>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct FileSearchFilters {
    kinds: Vec<DomainFileEntryKind>,
    name_query: Option<String>,
    mime_types: Vec<String>,
    extensions: Vec<String>,
    file_metadata_modified_from: Option<NaiveDateTime>,
    file_metadata_modified_to: Option<NaiveDateTime>,
}

impl FileSearchFilters {
    pub(super) fn from_validated_parts(
        kinds: Vec<DomainFileEntryKind>,
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

    pub(super) fn kinds(&self) -> &[DomainFileEntryKind] {
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::devices) enum EntryQueryScope<'a> {
    Browse(&'a DirectoryScope),
    Search {
        directory: &'a DirectoryScope,
        filters: &'a FileSearchFilters,
    },
}

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
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct ParsedSourcePath {
    pub(in crate::devices) absolute_path: String,
    pub(in crate::devices) root_name: String,
    pub(in crate::devices) components: Vec<String>,
}

impl ParsedSourcePath {
    pub(in crate::devices) fn file_name(&self) -> &str {
        self.components
            .last()
            .expect("parsed source path has a file component")
    }
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::devices) struct RawSourceFileState {
    pub(in crate::devices) state: Option<String>,
    pub(in crate::devices) settled_at: Option<String>,
    pub(in crate::devices) settled_by: Option<String>,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::devices) struct RawSyncDeviceFileItem {
    pub(in crate::devices) absolute_path: String,
    pub(in crate::devices) mime_type: Option<String>,
    pub(in crate::devices) extension: Option<String>,
    pub(in crate::devices) file_metadata_created_at: Option<String>,
    pub(in crate::devices) file_metadata_modified_at: Option<String>,
    pub(in crate::devices) source_file_state: Option<RawSourceFileState>,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::devices) struct RawSyncDeviceFilesReq {
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub(in crate::devices) device_id: String,
    pub(in crate::devices) files: Vec<RawSyncDeviceFileItem>,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::devices) struct RawApplyFileSyncBatchReq {
    pub(in crate::devices) files: Vec<RawSyncDeviceFileItem>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct NormalizedSourceFileState {
    pub(in crate::devices) state: DomainSourceFileStateKind,
    pub(in crate::devices) settled_at: DateTime<FixedOffset>,
    pub(in crate::devices) settled_by: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::devices) struct PreparedFileMutation {
    pub(super) device_id: Uuid,
    pub(super) sync_id: Uuid,
    pub(super) candidate_file_id: Uuid,
    pub(super) candidate_root_entry_id: Uuid,
    pub(super) candidate_directory_entry_ids: Vec<Uuid>,
    pub(super) source_path: ParsedSourcePath,
    pub(super) metadata: NormalizedFileMetadata,
    pub(super) source_file_state: Option<NormalizedSourceFileState>,
}

impl PreparedFileMutation {
    pub(in crate::devices) fn new(
        device_id: Uuid,
        sync_id: Uuid,
        source_path: ParsedSourcePath,
        metadata: NormalizedFileMetadata,
        source_file_state: Option<NormalizedSourceFileState>,
    ) -> Self {
        let candidate_directory_count = source_path
            .components
            .len()
            .checked_sub(1)
            .expect("parsed source path has a file component");

        Self {
            device_id,
            sync_id,
            candidate_file_id: Uuid::now_v7(),
            candidate_root_entry_id: Uuid::now_v7(),
            candidate_directory_entry_ids: (0..candidate_directory_count)
                .map(|_| Uuid::now_v7())
                .collect(),
            source_path,
            metadata,
            source_file_state,
        }
    }
}

use crate::devices::types::{
    deserialize_canonical_uuid, deserialize_canonical_uuid_vec,
    deserialize_nullable_canonical_uuid, deserialize_optional_datetime,
};
use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
    Copy,
)]
#[serde(rename_all = "snake_case")]
pub enum FileEntryKind {
    Directory,
    File,
}
#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
    Copy,
)]
#[serde(rename_all = "snake_case")]
pub enum SourceFileStateKind {
    Scanned,
    Downloaded,
    Changed,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct SourceFileState {
    pub state: SourceFileStateKind,
    pub settled_at: String,
    pub settled_by: Option<String>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct DeviceFileRoot {
    pub entry_id: String,
    pub device_id: String,
    pub parent_entry_id: Option<String>,
    pub kind: FileEntryKind,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    pub tags: Vec<AnalyticsTag>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct FileBreadcrumb {
    pub entry_id: String,
    pub name: String,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct DeviceFileTreeEntry {
    pub entry_id: String,
    pub parent_entry_id: String,
    pub kind: FileEntryKind,
    pub file_id: Option<String>,
    pub name: String,
    pub path_components: Vec<String>,
    pub absolute_path: Option<String>,
    pub has_content: bool,
    pub mime_type: Option<String>,
    pub extension: Option<String>,
    pub file_metadata_created_at: Option<String>,
    pub file_metadata_modified_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub revision: Option<i64>,
    pub sync_id: Option<String>,
    pub source_file_state: Option<SourceFileState>,
    pub tags: Vec<AnalyticsTag>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct DeviceFile {
    pub file_id: String,
    pub device_id: String,
    pub parent_entry_id: String,
    pub root_entry_id: String,
    pub absolute_path: String,
    pub has_content: bool,
    pub name: String,
    pub path_components: Vec<String>,
    pub mime_type: Option<String>,
    pub extension: Option<String>,
    pub file_metadata_created_at: Option<String>,
    pub file_metadata_modified_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub revision: i64,
    pub sync_id: String,
    pub source_file_state: Option<SourceFileState>,
    pub tags: Vec<AnalyticsTag>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct ListDeviceFileRootsReq {
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub device_id: String,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct ListDeviceFileRootsRsp {
    pub roots: Vec<DeviceFileRoot>,
}
#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct CountDeviceFileSubtreesReq {
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub device_id: String,
    #[serde(deserialize_with = "deserialize_nullable_canonical_uuid")]
    pub parent_entry_id: Option<String>,
    #[serde(deserialize_with = "deserialize_canonical_uuid_vec")]
    pub directory_entry_ids: Vec<String>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct DeviceFileSubtreeCount {
    pub entry_id: String,
    pub file_count: u64,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct CountDeviceFileSubtreesRsp {
    pub counts: Vec<DeviceFileSubtreeCount>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct BrowseDeviceFilesReq {
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub device_id: String,
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub parent_entry_id: String,
    pub include_breadcrumbs: Option<bool>,
    pub limit: Option<u64>,
    pub cursor: Option<String>,
    pub tag_ids: Option<Vec<String>>,
    pub tag_match: Option<TagMatch>,
    pub untagged: Option<bool>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct BrowseDeviceFilesRsp {
    pub breadcrumbs: Vec<FileBreadcrumb>,
    pub entries: Vec<DeviceFileTreeEntry>,
    pub next_cursor: Option<String>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct SearchDeviceFilesReq {
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub device_id: String,
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub scope_entry_id: String,
    pub name_query: Option<String>,
    pub kinds: Option<Vec<FileEntryKind>>,
    pub mime_types: Option<Vec<String>>,
    pub extensions: Option<Vec<String>>,
    #[serde(default, deserialize_with = "deserialize_optional_datetime")]
    pub file_metadata_modified_from: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_datetime")]
    pub file_metadata_modified_to: Option<String>,
    pub limit: Option<u64>,
    pub cursor: Option<String>,
    pub tag_ids: Option<Vec<String>>,
    pub tag_match: Option<TagMatch>,
    pub untagged: Option<bool>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct SearchDeviceFilesRsp {
    pub entries: Vec<DeviceFileTreeEntry>,
    pub next_cursor: Option<String>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct DeviceFileJournalEntry {
    pub file_id: String,
    pub name: String,
    pub absolute_path: String,
    pub has_content: bool,
    pub synchronized_at: String,
    pub revision: i64,
    pub sync_id: String,
    pub source_file_state: Option<SourceFileState>,
    pub tags: Vec<AnalyticsTag>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct JournalDeviceFilesReq {
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub device_id: String,
    pub limit: Option<u64>,
    pub cursor: Option<String>,
    pub tag_ids: Option<Vec<String>>,
    pub tag_match: Option<TagMatch>,
    pub untagged: Option<bool>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct JournalDeviceFilesRsp {
    pub entries: Vec<DeviceFileJournalEntry>,
    pub total_count: u64,
    pub next_cursor: Option<String>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct SyncDeviceFileItem {
    pub absolute_path: String,
    pub mime_type: Option<String>,
    pub extension: Option<String>,
    pub file_metadata_created_at: Option<String>,
    pub file_metadata_modified_at: Option<String>,
    pub source_file_state: Option<SourceFileState>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct SyncDeviceFilesReq {
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub device_id: String,
    pub files: Vec<SyncDeviceFileItem>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct ApplyFileSyncBatchReq {
    pub files: Vec<SyncDeviceFileItem>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
    Copy,
)]
#[serde(rename_all = "snake_case")]
pub enum FileSyncOperation {
    Created,
    Updated,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
    Copy,
)]
#[serde(rename_all = "snake_case")]
pub enum FileSyncSessionMode {
    Automatic,
    Explicit,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
    Copy,
)]
#[serde(rename_all = "snake_case")]
pub enum FileSyncSessionStatus {
    #[serde(rename = "open")]
    SyncOpen,
    Completed,
    CompletedWithErrors,
    Expired,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
    Copy,
)]
#[serde(rename_all = "snake_case")]
pub enum FileSyncBatchStatus {
    Processing,
    Applied,
    AppliedWithErrors,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
    Copy,
)]
#[serde(rename_all = "snake_case")]
pub enum FileSyncErrorCode {
    Validation,
    DuplicatePathInSession,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct FileSyncFieldError {
    pub path: String,
    pub message: String,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct SyncCounts {
    pub received: u64,
    pub accepted: u64,
    pub created: u64,
    pub updated: u64,
    pub rejected: u64,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct SyncSummary {
    pub sync_id: String,
    pub device_id: String,
    pub mode: FileSyncSessionMode,
    pub status: FileSyncSessionStatus,
    pub analysis_run_id: Option<String>,
    pub next_batch_index: u64,
    pub counts: SyncCounts,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
    pub expires_at: Option<String>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct BatchSummary {
    pub sync_id: String,
    pub batch_index: u64,
    pub status: FileSyncBatchStatus,
    pub counts: SyncCounts,
    pub created_at: String,
    pub applied_at: Option<String>,
}

#[allow(clippy::large_enum_variant)]
#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum FileSyncResult {
    Accepted {
        index: u64,
        operation: FileSyncOperation,
        file_id: String,
        revision: i64,
        file: DeviceFile,
    },
    Rejected {
        index: u64,
        code: FileSyncErrorCode,
        message: String,
        field_errors: Vec<FileSyncFieldError>,
    },
}

#[allow(clippy::large_enum_variant)]
#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(tag = "status")]
pub enum FileSyncSessionItemResult {
    #[serde(rename = "accepted")]
    SessionItemAccepted {
        batch_index: u64,
        item_index: u64,
        operation: FileSyncOperation,
        file_id: String,
        revision: i64,
        file: DeviceFile,
    },
    #[serde(rename = "rejected")]
    SessionItemRejected {
        batch_index: u64,
        item_index: u64,
        code: FileSyncErrorCode,
        message: String,
        field_errors: Vec<FileSyncFieldError>,
    },
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct SyncDeviceFilesRsp {
    pub sync: SyncSummary,
    pub results: Vec<FileSyncResult>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct StartFileSyncSessionReq {
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub device_id: String,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct FileSyncSessionRsp {
    pub sync: SyncSummary,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct ApplyFileSyncBatchRsp {
    pub sync: SyncSummary,
    pub batch: BatchSummary,
    pub results: Vec<FileSyncResult>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct CompleteFileSyncSessionReq {
    pub expected_batch_count: u64,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct FileSyncSessionItemsRsp {
    pub sync: SyncSummary,
    pub results: Vec<FileSyncSessionItemResult>,
    pub next_cursor: Option<String>,
}
