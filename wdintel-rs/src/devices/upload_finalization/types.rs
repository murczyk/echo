use chrono::{DateTime, Utc};
use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Clone,
    Copy,
    Debug,
    Eq,
    PartialEq,
    Serialize,
    Deserialize,
)]
#[allow(
    clippy::enum_variant_names,
    reason = "Generated Elm constructors share a module namespace"
)]
pub(crate) enum FinalizationKind {
    #[serde(rename = "file")]
    FinalizationFileKind,
    #[serde(rename = "audio")]
    FinalizationAudioKind,
}

impl FinalizationKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::FinalizationFileKind => "file",
            Self::FinalizationAudioKind => "audio",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct FinalizationCommand {
    pub created_by_login_id: Uuid,
    pub device_id: Uuid,
    pub source_size_bytes: i64,
    pub source_locator: Option<String>,
    pub target: FinalizationTarget,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum FinalizationTarget {
    File {
        upload_id: Uuid,
        file_id: Uuid,
        revision: i64,
    },
    Audio {
        tus_id: Uuid,
        audio_id: Uuid,
        name: String,
        recording_started_at: DateTime<Utc>,
        pin_token: Uuid,
    },
}

impl FinalizationCommand {
    pub(crate) fn kind(&self) -> FinalizationKind {
        match self.target {
            FinalizationTarget::File { .. } => {
                FinalizationKind::FinalizationFileKind
            }
            FinalizationTarget::Audio { .. } => {
                FinalizationKind::FinalizationAudioKind
            }
        }
    }

    pub(crate) fn source_identity(&self) -> String {
        match self.target {
            FinalizationTarget::File { upload_id, .. } => upload_id.to_string(),
            FinalizationTarget::Audio { tus_id, .. } => {
                format!("{}/{tus_id}", self.device_id)
            }
        }
    }
}

#[derive(
    Elm, ElmEncode, ElmDecode, Clone, Debug, Default, Serialize, Deserialize,
)]
#[serde(deny_unknown_fields)]
pub(crate) struct CompleteDeviceFileUploadReq {
    #[serde(default)]
    pub async_finalization: bool,
}

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct QueuedAcknowledgement {
    pub status: QueuedStatus,
    pub job_id: Uuid,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Clone, Copy, Debug, Serialize, Deserialize,
)]
pub(crate) enum QueuedStatus {
    #[serde(rename = "queued")]
    FinalizationQueuedAcknowledgement,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Clone,
    Copy,
    Debug,
    Eq,
    PartialEq,
    Serialize,
    Deserialize,
)]
#[allow(
    clippy::enum_variant_names,
    reason = "Generated Elm constructors share a module namespace"
)]
pub(crate) enum FinalizationStatus {
    #[serde(rename = "queued")]
    FinalizationQueued,
    #[serde(rename = "processing")]
    FinalizationProcessing,
    #[serde(rename = "retry_wait")]
    FinalizationRetryWait,
    #[serde(rename = "outcome_unknown")]
    FinalizationOutcomeUnknown,
    #[serde(rename = "completed")]
    FinalizationCompleted,
    #[serde(rename = "failed")]
    FinalizationFailed,
}

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FinalizationJobSnapshot {
    pub job_id: Uuid,
    pub kind: FinalizationKind,
    pub status: FinalizationStatus,
    pub created_at: String,
    pub updated_at: String,
    pub finished_at: Option<String>,
    pub retry_after_seconds: Option<u64>,
    pub result: Option<FinalizationResult>,
    pub error: Option<FinalizationError>,
}

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Serialize, Deserialize)]
#[allow(
    clippy::enum_variant_names,
    reason = "Generated Elm constructors share a module namespace"
)]
#[serde(untagged)]
pub(crate) enum FinalizationResult {
    #[serde(rename = "file")]
    FinalizationFileResult(FinalizationFileReceipt),
    #[serde(rename = "audio")]
    FinalizationAudioResult(
        crate::devices::audio::types::ReceiveDeviceAudioRsp,
    ),
}

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FinalizationFileReceipt {
    pub upload_id: Uuid,
    pub file_id: Uuid,
    pub revision: i64,
    pub status: CompletedStatus,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Clone, Copy, Debug, Serialize, Deserialize,
)]
pub(crate) enum CompletedStatus {
    #[serde(rename = "completed")]
    FinalizationFileCompleted,
}

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FinalizationError {
    pub code: String,
    pub message: String,
    pub action: FinalizationAction,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Clone, Copy, Debug, Serialize, Deserialize,
)]
#[allow(
    clippy::enum_variant_names,
    reason = "Generated Elm constructors share a module namespace"
)]
pub(crate) enum FinalizationAction {
    #[serde(rename = "retry_poll")]
    FinalizationRetryPoll,
    #[serde(rename = "new_upload")]
    FinalizationNewUpload,
    #[serde(rename = "correct_request")]
    FinalizationCorrectRequest,
    #[serde(rename = "contact_operator")]
    FinalizationContactOperator,
}

#[derive(Clone, Debug)]
pub(crate) struct ClaimedFinalizationJob {
    pub job_id: Uuid,
    pub owner: Uuid,
    pub lease_epoch: i64,
    pub kind: FinalizationKind,
    pub requires_reconciliation: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct PreparedAudio {
    pub media_type: String,
    pub duration_seconds: f64,
    pub recording_ended_at: DateTime<Utc>,
}

#[derive(Clone, Debug)]
pub(crate) struct VerifiedFinalizationObject {
    pub attempt_id: Uuid,
    pub object_key: String,
    pub source_size_bytes: i64,
    pub source_sha256: [u8; 32],
    pub is_encrypted: bool,
    pub audio: Option<PreparedAudio>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub(crate) enum FinalizationFailure {
    #[error("audio payload is invalid")]
    InvalidAudio,
    #[error("audio format is unsupported")]
    UnsupportedAudio,
    #[error("audio name already exists")]
    AudioNameConflict,
    #[error("source not found")]
    SourceOwned,
    #[error("accepted upload command differs")]
    CommandConflict,
    #[error("finalization capacity unavailable")]
    CapacityUnavailable,
    #[error("finalization lease is no longer current")]
    StaleClaim,
    #[error("finalization dependency unavailable")]
    DependencyUnavailable,
    #[error("storage outcome requires reconciliation")]
    StorageOutcomeUnknown,
    #[error("target revision changed")]
    TargetRevisionChanged,
    #[error("target is unavailable")]
    TargetUnavailable,
    #[error("publication permission revoked")]
    PublicationForbidden,
    #[error("accepted source is missing")]
    SourceLost,
    #[error("source fingerprint does not match")]
    SourceDigestMismatch,
}

impl FinalizationFailure {
    pub(crate) fn diagnostic(self) -> FinalizationError {
        let (code, action) = match self {
            Self::InvalidAudio => {
                ("invalid_audio", FinalizationAction::FinalizationNewUpload)
            }
            Self::UnsupportedAudio => (
                "unsupported_audio",
                FinalizationAction::FinalizationNewUpload,
            ),
            Self::AudioNameConflict => (
                "device_audio_name_conflict",
                FinalizationAction::FinalizationCorrectRequest,
            ),
            Self::TargetRevisionChanged => (
                "target_revision_changed",
                FinalizationAction::FinalizationCorrectRequest,
            ),
            Self::TargetUnavailable => (
                "target_unavailable",
                FinalizationAction::FinalizationContactOperator,
            ),
            Self::PublicationForbidden => (
                "publication_forbidden",
                FinalizationAction::FinalizationContactOperator,
            ),
            Self::SourceLost => {
                ("source_lost", FinalizationAction::FinalizationNewUpload)
            }
            Self::SourceDigestMismatch => (
                "source_digest_mismatch",
                FinalizationAction::FinalizationNewUpload,
            ),
            Self::StorageOutcomeUnknown => (
                "storage_outcome_unknown",
                FinalizationAction::FinalizationRetryPoll,
            ),
            Self::CapacityUnavailable => (
                "execution_capacity_unavailable",
                FinalizationAction::FinalizationRetryPoll,
            ),
            Self::CommandConflict => (
                "command_conflict",
                FinalizationAction::FinalizationCorrectRequest,
            ),
            Self::SourceOwned => (
                "target_unavailable",
                FinalizationAction::FinalizationContactOperator,
            ),
            Self::StaleClaim | Self::DependencyUnavailable => (
                "dependency_unavailable",
                FinalizationAction::FinalizationRetryPoll,
            ),
        };
        FinalizationError {
            code: code.into(),
            message: self.to_string(),
            action,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum WriteResolution {
    Acknowledged,
    DefinitelyNotDispatched,
}
