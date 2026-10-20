use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(
    Debug,
    Clone,
    PartialEq,
    Eq,
    Serialize,
    Deserialize,
    Elm,
    ElmEncode,
    ElmDecode,
)]
#[allow(
    clippy::enum_variant_names,
    reason = "Generated Elm constructors share a module namespace"
)]
pub enum DeviceArchiveState {
    #[serde(rename = "missing_content")]
    ArchiveMissingContent,
    #[serde(rename = "not_prepared")]
    ArchiveNotPrepared,
    #[serde(rename = "queued")]
    ArchiveQueued,
    #[serde(rename = "running")]
    ArchiveRunning,
    #[serde(rename = "retry_wait")]
    ArchiveRetryWait,
    #[serde(rename = "ready")]
    ArchiveReady,
    #[serde(rename = "failed")]
    ArchiveFailed,
}

#[derive(
    Debug,
    Clone,
    PartialEq,
    Eq,
    Serialize,
    Deserialize,
    Elm,
    ElmEncode,
    ElmDecode,
)]
#[allow(
    clippy::enum_variant_names,
    reason = "Generated Elm constructors share a module namespace"
)]
pub enum DeviceArchiveReason {
    #[serde(rename = "password_protected")]
    ArchiveReasonPasswordProtected,
    #[serde(rename = "invalid_archive")]
    ArchiveReasonInvalidArchive,
    #[serde(rename = "unsupported_format")]
    ArchiveReasonUnsupportedFormat,
    #[serde(rename = "source_too_large")]
    ArchiveReasonSourceTooLarge,
    #[serde(rename = "unsafe_path")]
    ArchiveReasonUnsafePath,
    #[serde(rename = "path_conflict")]
    ArchiveReasonPathConflict,
    #[serde(rename = "integrity_mismatch")]
    ArchiveReasonIntegrityMismatch,
    #[serde(rename = "safety_limit")]
    ArchiveReasonSafetyLimit,
    #[serde(rename = "retry_exhausted")]
    ArchiveReasonRetryExhausted,
    #[serde(rename = "storage_unavailable")]
    ArchiveReasonStorageUnavailable,
    #[serde(rename = "internal_error")]
    ArchiveReasonInternalError,
}

#[derive(
    Debug,
    Clone,
    PartialEq,
    Eq,
    Serialize,
    Deserialize,
    Elm,
    ElmEncode,
    ElmDecode,
)]
#[serde(deny_unknown_fields)]
pub struct DeviceFileContentRef {
    pub device_id: Uuid,
    pub file_id: Uuid,
    pub revision: i64,
}

#[derive(
    Debug,
    Clone,
    PartialEq,
    Eq,
    Serialize,
    Deserialize,
    Elm,
    ElmEncode,
    ElmDecode,
)]
#[serde(deny_unknown_fields)]
pub struct DeviceArchiveOrigin {
    pub archive_id: Uuid,
    pub source_file_id: Uuid,
    pub source_revision: i64,
}

#[derive(
    Debug,
    Clone,
    PartialEq,
    Eq,
    Serialize,
    Deserialize,
    Elm,
    ElmEncode,
    ElmDecode,
)]
#[serde(deny_unknown_fields)]
pub struct DeviceArchiveSummary {
    pub archive_id: Option<Uuid>,
    pub root_entry_id: Option<Uuid>,
    pub state: DeviceArchiveState,
    pub reason: Option<DeviceArchiveReason>,
    pub message: Option<String>,
    pub limit_name: Option<String>,
}

#[derive(
    Debug,
    Clone,
    PartialEq,
    Eq,
    Serialize,
    Deserialize,
    Elm,
    ElmEncode,
    ElmDecode,
)]
#[serde(deny_unknown_fields)]
pub struct DeviceArchiveStatus {
    pub source: DeviceFileContentRef,
    pub archive: DeviceArchiveSummary,
    pub next_attempt_at: Option<String>,
    pub poll_after_ms: i64,
    pub updated_at: Option<String>,
}
