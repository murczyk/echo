use crate::types::{Deserialize, Serialize};
use elm_rs::{Elm, ElmDecode, ElmEncode};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiIntelReportSettingsItem {
    pub quick_suggestion_enabled: bool,
    pub quick_ai_engine_id: Option<String>,
    pub legacy_comment_cutoff: i64,
    pub updated_at: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct SaveAiIntelReportSettingsReq {
    pub quick_suggestion_enabled: bool,
    pub quick_ai_engine_id: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct QuickIntelReportSuggestionReq {
    pub message_id: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct QuickIntelReportSuggestionRsp {
    pub suggestions: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiIntelReportAttemptItem {
    pub id: String,
    pub login_id: String,
    pub login: String,
    pub ai_engine_id: Option<String>,
    pub ai_engine_name: Option<String>,
    pub source_message_id: i64,
    pub outcome: String,
    pub suggestions: Vec<String>,
    pub raw_response: Option<String>,
    pub error: Option<String>,
    pub duration_ms: i64,
    pub created_at: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiIntelReportAttemptListRsp {
    pub items: Vec<AiIntelReportAttemptItem>,
}
