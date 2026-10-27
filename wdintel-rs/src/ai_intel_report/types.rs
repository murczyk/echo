use crate::types::{Deserialize, Serialize};
use elm_rs::{Elm, ElmDecode, ElmEncode};

fn deserialize_optional_update<'de, D, T>(
    deserializer: D,
) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiIntelReportEngineBudgetItem {
    pub ai_engine_id: String,
    pub max_tokens: i32,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiIntelReportSettingsItem {
    pub quick_suggestion_enabled: bool,
    pub quick_ai_engine_id: Option<String>,
    pub fallback_ai_engine_id: Option<String>,
    pub engine_budgets: Vec<AiIntelReportEngineBudgetItem>,
    pub primary_timeout_secs: i32,
    pub fallback_timeout_secs: i32,
    pub total_timeout_secs: i32,
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
    #[serde(default, deserialize_with = "deserialize_optional_update")]
    pub fallback_ai_engine_id: Option<Option<String>>,
    pub engine_budgets: Option<Vec<AiIntelReportEngineBudgetItem>>,
    pub primary_timeout_secs: Option<i32>,
    pub fallback_timeout_secs: Option<i32>,
    pub total_timeout_secs: Option<i32>,
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
pub struct AiIntelReportAttemptListReq {
    pub page_start_id: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiIntelReportAttemptListRsp {
    pub items: Vec<AiIntelReportAttemptItem>,
    pub page_size: i32,
    pub total: Option<i64>,
    pub page_start_ids: Option<Vec<String>>,
}
