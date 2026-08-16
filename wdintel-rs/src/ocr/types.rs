use crate::types::{Deserialize, Serialize};
use elm_rs::{Elm, ElmDecode, ElmEncode};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct OcrMediaSummary {
    pub state: String,
    pub quality_status: Option<String>,
    pub processed_pages: i32,
    pub total_pages: i32,
    pub last_error: Option<String>,
    pub queue_size: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct OcrSettingsItem {
    pub worker_enabled: bool,
    pub configured: bool,
    pub extractor_ready: bool,
    pub readiness_error: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct OcrCounts {
    pub queued: i64,
    pub submitted: i64,
    pub retry_wait: i64,
    pub completed: i64,
    pub failed: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct OcrJobItem {
    pub media_id: String,
    pub signal_message_id: i64,
    pub file_name: Option<String>,
    pub content_type: String,
    pub size_bytes: i64,
    pub source_created_at: i64,
    pub state: String,
    pub quality_status: Option<String>,
    pub processed_pages: i32,
    pub total_pages: i32,
    pub attempts: i32,
    pub last_error: Option<String>,
    pub duration_ms: Option<i64>,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
    pub preview_url: Option<String>,
    pub summary: Option<crate::media_summary::types::MediaSummaryStatus>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct OcrPageRsp {
    pub settings: OcrSettingsItem,
    pub media_summary_settings:
        crate::media_summary::types::MediaSummarySettingsItem,
    pub counts: OcrCounts,
    pub jobs: Vec<OcrJobItem>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct OcrPageReq {
    pub limit: Option<u64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct SaveOcrSettingsReq {
    pub worker_enabled: bool,
}
