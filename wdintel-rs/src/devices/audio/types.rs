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
    pub can_edit: bool,
}

#[derive(Elm, ElmEncode, ElmDecode, Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReceiveDeviceAudioReq {
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub device_id: String,
    pub upload_url: String,
    pub name: String,
    #[serde(deserialize_with = "deserialize_recording_start")]
    pub recording_started_at: String,
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

#[derive(Clone, Copy, Debug, Deserialize)]
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
