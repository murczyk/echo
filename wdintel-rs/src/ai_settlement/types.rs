use crate::types::{Deserialize, Serialize};
use elm_rs::{Elm, ElmDecode, ElmEncode};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiSettlementEngineItem {
    pub id: String,
    pub name: String,
    pub model_name: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiSettlementParseResultItem {
    pub test_message_id: String,
    pub ai_engine_id: String,
    pub settlements: Vec<String>,
    pub error: Option<String>,
    pub response_text: String,
    pub updated_at: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiSettlementTestMessageItem {
    pub id: String,
    pub message: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub results: Vec<AiSettlementParseResultItem>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiSettlementTestMessageVersionItem {
    pub id: String,
    pub version: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiSettlementWorkerSettingsItem {
    pub enabled: bool,
    pub ai_engine_id: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiSettlementPageRsp {
    pub prompt: String,
    pub prompt_overridden: bool,
    pub engines: Vec<AiSettlementEngineItem>,
    pub messages: Vec<AiSettlementTestMessageItem>,
    pub worker: AiSettlementWorkerSettingsItem,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiSettlementPromptState {
    pub prompt: String,
    pub prompt_overridden: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct CreateAiSettlementTestMessageReq {
    pub message: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAiSettlementTestMessageReq {
    pub id: String,
    pub message: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiSettlementTestMessageIdReq {
    pub id: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct RunAiSettlementParsingReq {
    pub prompt: String,
    pub ai_engine_ids: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiSettlementParsingRsp {
    pub results: Vec<AiSettlementParseResultItem>,
    pub message_versions: Vec<AiSettlementTestMessageVersionItem>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct SaveAiSettlementParsingReq {
    pub prompt: String,
    pub results: Vec<AiSettlementParseResultItem>,
    pub message_versions: Vec<AiSettlementTestMessageVersionItem>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct SaveAiSettlementWorkerSettingsReq {
    pub enabled: bool,
    pub ai_engine_id: Option<String>,
}
