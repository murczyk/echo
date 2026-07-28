use super::common::{
    deserialize_canonical_uuid, deserialize_canonical_uuid_vec,
    deserialize_nullable_canonical_uuid, deserialize_optional_canonical_uuid,
    deserialize_optional_datetime, FieldError, FileEntryKind, PathSyntax,
    RequiredPatch,
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
)]
#[serde(deny_unknown_fields)]
pub struct DeviceFileRoot {
    pub entry_id: String,
    pub device_id: String,
    pub parent_entry_id: Option<String>,
    pub kind: FileEntryKind,
    pub name: String,
    pub path_syntax: PathSyntax,
    pub created_at: String,
    pub updated_at: String,
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
    pub path_syntax: Option<PathSyntax>,
    pub absolute_path: Option<String>,
    pub mime_type: Option<String>,
    pub extension: Option<String>,
    pub file_metadata_created_at: Option<String>,
    pub file_metadata_modified_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
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
    pub path_syntax: PathSyntax,
    pub absolute_path: String,
    pub name: String,
    pub path_components: Vec<String>,
    pub mime_type: Option<String>,
    pub extension: Option<String>,
    pub file_metadata_created_at: Option<String>,
    pub file_metadata_modified_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
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
    pub synchronized_at: String,
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
    #[serde(
        default,
        deserialize_with = "deserialize_optional_canonical_uuid",
        skip_serializing_if = "RequiredPatch::is_missing"
    )]
    pub file_id: RequiredPatch<String>,
    pub absolute_path: String,
    pub mime_type: Option<String>,
    pub extension: Option<String>,
    pub file_metadata_created_at: Option<String>,
    pub file_metadata_modified_at: Option<String>,
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
    pub path_syntax: PathSyntax,
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
pub enum FileSyncErrorKind {
    Validation,
    NotFound,
    Conflict,
    Dependency,
    Internal,
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
pub struct FileSyncError {
    pub kind: FileSyncErrorKind,
    pub message: String,
    pub field_errors: Vec<FieldError>,
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
        index: usize,
        operation: FileSyncOperation,
        root: DeviceFileRoot,
        file: DeviceFile,
    },
    Rejected {
        index: usize,
        error: FileSyncError,
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
    pub results: Vec<FileSyncResult>,
}
