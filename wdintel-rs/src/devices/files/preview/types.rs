use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

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
#[allow(
    clippy::enum_variant_names,
    reason = "Generated Elm constructors share a module namespace"
)]
pub enum DeviceFileGeodataPreviewStatus {
    #[serde(rename = "idle")]
    GeodataIdle,
    #[serde(rename = "queued")]
    GeodataQueued,
    #[serde(rename = "running")]
    GeodataRunning,
    #[serde(rename = "retry_wait")]
    GeodataRetryWait,
    #[serde(rename = "ready")]
    GeodataReady,
    #[serde(rename = "failed")]
    GeodataFailed,
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
pub struct DeviceFileGeodataPreviewRsp {
    pub file_id: Uuid,
    pub revision: i64,
    pub generation: Option<Uuid>,
    pub status: DeviceFileGeodataPreviewStatus,
    pub retryable: bool,
    pub retry_after_ms: Option<i64>,
    pub result_size_bytes: Option<i64>,
    pub result_url: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
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
pub struct RetryDeviceFileGeodataPreviewReq {
    pub expected_generation: Uuid,
}
