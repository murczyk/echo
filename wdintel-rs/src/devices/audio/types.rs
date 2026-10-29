use crate::devices::types::deserialize_canonical_uuid;
use chrono::{DateTime, Utc};
use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceAudio {
    pub id: String,
    pub device_id: String,
    pub name: String,
    pub recording_started_at: String,
    pub recording_ended_at: String,
    pub duration_seconds: f64,
    pub processed: bool,
    pub processing_version: String,
}

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceAudioTranscription {
    pub text: String,
    pub text_version: String,
}

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceAudioDetails {
    pub audio: DeviceAudio,
    pub transcription: DeviceAudioTranscription,
    pub automatic_transcription: DeviceAudioAutomaticTranscriptionSnapshot,
    pub transcription_availability: DeviceAudioTranscriptionAvailability,
    pub can_edit: bool,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    Deserialize,
    Serialize,
)]
#[allow(
    clippy::enum_variant_names,
    reason = "Generated Elm constructors share a module namespace"
)]
pub enum DeviceAudioAutomaticTranscriptionState {
    #[serde(rename = "not_requested")]
    AudioAsrNotRequested,
    #[serde(rename = "queued")]
    AudioAsrQueued,
    #[serde(rename = "preparing")]
    AudioAsrPreparing,
    #[serde(rename = "running")]
    AudioAsrRunning,
    #[serde(rename = "retry_wait")]
    AudioAsrRetryWait,
    #[serde(rename = "succeeded")]
    AudioAsrSucceeded,
    #[serde(rename = "no_speech")]
    AudioAsrNoSpeech,
    #[serde(rename = "failed")]
    AudioAsrFailed,
    #[serde(rename = "outcome_unknown")]
    AudioAsrOutcomeUnknown,
    #[serde(rename = "cancelled")]
    AudioAsrCancelled,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    Deserialize,
    Serialize,
)]
#[allow(
    clippy::enum_variant_names,
    reason = "Generated Elm constructors share a module namespace"
)]
pub enum DeviceAudioTranscriptionDisposition {
    #[serde(rename = "queued")]
    AudioAsrRetryQueued,
    #[serde(rename = "already_active")]
    AudioAsrRetryAlreadyActive,
    #[serde(rename = "already_completed")]
    AudioAsrRetryAlreadyCompleted,
}

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceAudioAutomaticTranscriptionSnapshot {
    pub version: Uuid,
    pub text: Option<String>,
    pub state: DeviceAudioAutomaticTranscriptionState,
    pub retry_at: Option<String>,
    pub message: Option<String>,
}

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceAudioTranscriptionAvailability {
    pub device_enabled: bool,
    pub global_enabled: bool,
    pub can_edit_manual: bool,
    pub can_manage_setting: bool,
    pub can_retry: bool,
    pub blocked_reason: Option<String>,
}

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceAudioTranscriptionStatusReq {
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub device_id: String,
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub audio_id: String,
    pub known_version: Option<Uuid>,
}

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceAudioTranscriptionStatusRsp {
    pub snapshot: Option<DeviceAudioAutomaticTranscriptionSnapshot>,
    pub availability: DeviceAudioTranscriptionAvailability,
}

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RetryDeviceAudioTranscriptionReq {
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub device_id: String,
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub audio_id: String,
}

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RetryDeviceAudioTranscriptionRsp {
    pub snapshot: DeviceAudioAutomaticTranscriptionSnapshot,
    pub availability: DeviceAudioTranscriptionAvailability,
    pub disposition: DeviceAudioTranscriptionDisposition,
}

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceAudioAsrSettingsReq {
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub device_id: String,
}

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SetDeviceAudioAsrSettingsReq {
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub device_id: String,
    pub enabled: bool,
}

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceAudioAsrSettingsRsp {
    pub device_id: String,
    pub enabled: bool,
    pub global_enabled: bool,
    pub can_manage_setting: bool,
    pub blocked_reason: Option<String>,
}

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceAudioTranscriptionAdmissionError {
    pub code: String,
    pub message: String,
}

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PrepareDeviceAudioReq {
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub device_id: String,
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub audio_id: String,
    #[serde(default)]
    pub retry: bool,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    Deserialize,
    Serialize,
)]
#[serde(rename_all = "snake_case")]
pub enum DeviceAudioPreparationState {
    Queued,
    Preparing,
    Ready,
    Failed,
}

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Deserialize, Serialize)]
pub struct DeviceAudioPreparation {
    pub content: DeviceAudioPreparationState,
    pub wave: DeviceAudioPreparationState,
    pub spectrogram: DeviceAudioPreparationState,
    pub retry_after_ms: u64,
    pub transcription_admission_error:
        Option<DeviceAudioTranscriptionAdmissionError>,
}

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReceiveDeviceAudioReq {
    #[serde(default)]
    pub async_finalization: bool,
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub device_id: String,
    pub upload_url: String,
    pub name: String,
    #[serde(deserialize_with = "deserialize_recording_start")]
    pub recording_started_at: String,
}

pub(super) struct ReceiveDeviceAudioBody(pub ReceiveDeviceAudioReq);

impl<'de> Deserialize<'de> for ReceiveDeviceAudioBody {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Self, D::Error> {
        struct ObjectVisitor;

        impl<'de> serde::de::Visitor<'de> for ObjectVisitor {
            type Value = ReceiveDeviceAudioBody;

            fn expecting(
                &self,
                formatter: &mut std::fmt::Formatter,
            ) -> std::fmt::Result {
                formatter.write_str("an audio receive request object")
            }

            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                map: M,
            ) -> Result<Self::Value, M::Error> {
                ReceiveDeviceAudioReq::deserialize(
                    serde::de::value::MapAccessDeserializer::new(map),
                )
                .map(ReceiveDeviceAudioBody)
            }
        }

        deserializer.deserialize_map(ObjectVisitor)
    }
}

fn deserialize_recording_start<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    DateTime::parse_from_rfc3339(&value).map_err(|_| {
        serde::de::Error::custom(
            "must be an RFC 3339 timestamp with an explicit timezone",
        )
    })?;
    Ok(value)
}

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReceiveDeviceAudioRsp {
    pub audio: DeviceAudio,
}

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ListDeviceAudioReq {
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub device_id: String,
    #[serde(default)]
    pub unprocessed_only: bool,
    #[serde(default = "default_page_size")]
    pub limit: u32,
    pub cursor: Option<String>,
}

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ListDeviceAudioRsp {
    pub audio: Vec<DeviceAudio>,
    pub next_cursor: Option<String>,
}

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceAudioDetailReq {
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub device_id: String,
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub audio_id: String,
}

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SaveDeviceAudioTranscriptionReq {
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub device_id: String,
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub audio_id: String,
    pub text: String,
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub expected_text_version: String,
}

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SaveDeviceAudioTranscriptionRsp {
    pub audio_id: String,
    pub transcription: DeviceAudioTranscription,
}

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SetDeviceAudioProcessingReq {
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub device_id: String,
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub audio_id: String,
    pub processed: bool,
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub expected_processing_version: String,
}

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SetDeviceAudioProcessingRsp {
    pub audio_id: String,
    pub processed: bool,
    pub processing_version: String,
}

fn default_page_size() -> u32 {
    super::DEVICE_AUDIO_DEFAULT_PAGE_SIZE
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ReceiveDeviceAudioCommand {
    pub device_id: Uuid,
    pub upload_url: String,
    pub name: String,
    pub recording_started_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ListDeviceAudioCommand {
    pub device_id: Uuid,
    pub unprocessed_only: bool,
    pub limit: u32,
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DeviceAudioDetailCommand {
    pub device_id: Uuid,
    pub audio_id: Uuid,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SaveDeviceAudioTranscriptionCommand {
    pub device_id: Uuid,
    pub audio_id: Uuid,
    pub text: String,
    pub expected_text_version: Uuid,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SetDeviceAudioProcessingCommand {
    pub device_id: Uuid,
    pub audio_id: Uuid,
    pub processed: bool,
    pub expected_processing_version: Uuid,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OpenDeviceAudioCommand {
    pub device_id: Uuid,
    pub audio_id: Uuid,
    pub representation: DeviceAudioRepresentation,
    pub method: DeviceAudioMethod,
    pub range: Option<DeviceAudioRange>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
pub(crate) enum DeviceAudioRepresentation {
    Content,
    Wave,
    Spectrogram,
}

#[derive(Clone, Copy, Debug, Deserialize)]
pub(crate) enum DeviceAudioMethod {
    Get,
    Head,
}

#[derive(Clone, Copy, Debug, Deserialize)]
pub(crate) enum DeviceAudioRange {
    From { start: u64, end: Option<u64> },
    Suffix { length: u64 },
}

pub(crate) struct DeviceAudioContentRange {
    pub start: u64,
    pub end: u64,
    pub total: u64,
}

pub(crate) struct DeviceAudioContent {
    pub mime_type: String,
    pub length: u64,
    pub range: Option<DeviceAudioContentRange>,
    pub stream: std::pin::Pin<
        Box<
            dyn futures_util::Stream<Item = anyhow::Result<bytes::Bytes>>
                + Send,
        >,
    >,
}

#[derive(Debug)]
pub(crate) enum ReceiveDeviceAudioOutcome {
    Accepted(ReceiveDeviceAudioRsp),
    Duplicate,
}

#[derive(Debug)]
pub(crate) enum SaveDeviceAudioTranscriptionOutcome {
    Saved(SaveDeviceAudioTranscriptionRsp),
    Unchanged(SaveDeviceAudioTranscriptionRsp),
    Conflict {
        audio_id: Uuid,
        current: DeviceAudioTranscription,
    },
}

#[derive(Debug)]
pub(crate) enum SetDeviceAudioProcessingOutcome {
    Saved(SetDeviceAudioProcessingRsp),
    Unchanged(SetDeviceAudioProcessingRsp),
    Conflict(SetDeviceAudioProcessingRsp),
}
