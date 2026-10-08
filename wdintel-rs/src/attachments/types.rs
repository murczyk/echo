use crate::types::{Deserialize, Serialize};
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::FromQueryResult;

#[derive(
    Debug,
    Clone,
    Serialize,
    Deserialize,
    Elm,
    ElmEncode,
    ElmDecode,
    PartialEq,
    Default,
)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentSearchReq {
    pub query: Option<String>,
    pub selected_groups: Option<Vec<String>>,
    pub message_ids: Option<Vec<i64>>,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub format: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<i64>,
}

#[derive(
    Debug,
    Clone,
    Serialize,
    Deserialize,
    Elm,
    ElmEncode,
    ElmDecode,
    PartialEq,
    FromQueryResult,
)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentItem {
    pub media_id: String,
    pub message_id: i64,
    pub message_uuid: Option<String>,
    pub file_name: String,
    pub content_type: String,
    pub state: String,
    pub quality: Option<String>,
    pub complete: bool,
    pub revision: Option<String>,
    pub summary: Option<String>,
    pub summary_state: String,
    pub position_state: String,
    pub chunk_count: i32,
    pub last_error: Option<String>,
    pub snippet: Option<String>,
    pub citation: String,
}

#[derive(
    Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode, PartialEq,
)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentSearchRsp {
    pub documents: Vec<AttachmentItem>,
    pub next_cursor: Option<String>,
}

#[derive(
    Debug,
    Clone,
    Serialize,
    Deserialize,
    Elm,
    ElmEncode,
    ElmDecode,
    PartialEq,
    Default,
)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentReadReq {
    pub media_id: String,
    pub revision: Option<String>,
    pub member: Option<String>,
    pub after: Option<i32>,
    pub limit: Option<i64>,
    pub query: Option<String>,
}

#[derive(
    Debug,
    Clone,
    Serialize,
    Deserialize,
    Elm,
    ElmEncode,
    ElmDecode,
    PartialEq,
    FromQueryResult,
)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentSection {
    pub id: String,
    pub ordinal: i32,
    pub member: String,
    pub locator: String,
    pub text: String,
    pub markdown: String,
    pub html: String,
    pub summary: Option<String>,
}

#[derive(
    Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode, PartialEq,
)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentReadRsp {
    pub document: AttachmentItem,
    pub sections: Vec<AttachmentSection>,
    pub next_after: Option<i32>,
    pub warnings: Vec<String>,
    pub coordinates: Vec<crate::media_summary::types::MediaSummaryCoordinate>,
}

#[derive(
    Debug,
    Clone,
    Serialize,
    Deserialize,
    Elm,
    ElmEncode,
    ElmDecode,
    PartialEq,
    Default,
)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentSettings {
    pub enabled: bool,
    pub positions_enabled: bool,
    pub summaries_enabled: bool,
    pub ai_engine_id: Option<String>,
    pub position_engine_id: Option<String>,
    pub backfill_complete: bool,
}

#[derive(
    Debug,
    Clone,
    Serialize,
    Deserialize,
    Elm,
    ElmEncode,
    ElmDecode,
    PartialEq,
    FromQueryResult,
)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentQueueCount {
    pub kind: String,
    pub state: String,
    pub count: i64,
}

#[derive(
    Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode, PartialEq,
)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentAdminRsp {
    pub settings: AttachmentSettings,
    pub counts: Vec<AttachmentQueueCount>,
    pub documents: Vec<AttachmentItem>,
    pub engines: Vec<crate::ai_position::types::AiPositionEngineItem>,
}

#[derive(
    Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode, PartialEq,
)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInspectionReq {
    pub media_id: String,
    pub member: Option<String>,
    pub operation: String,
    pub locator: Option<String>,
}

#[derive(
    Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode, PartialEq,
)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInspectionRsp {
    pub id: String,
    pub state: String,
    pub result: Option<AttachmentReadRsp>,
    pub error: Option<String>,
}

#[derive(
    Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode, PartialEq,
)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentCoordinateStatus {
    pub revision: String,
    pub has_coordinates: bool,
}
