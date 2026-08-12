use crate::types::{Deserialize, Serialize};
use elm_rs::{Elm, ElmDecode, ElmEncode};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiCallsignEngineItem {
    pub id: String,
    pub name: String,
    pub model_name: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiCallsignParseResultItem {
    pub test_message_id: String,
    pub ai_engine_id: String,
    pub callsigns: Vec<String>,
    pub error: Option<String>,
    pub response_text: String,
    pub updated_at: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiCallsignTestMessageItem {
    pub id: String,
    pub message: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub results: Vec<AiCallsignParseResultItem>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiCallsignWorkerSettingsItem {
    pub enabled: bool,
    pub ai_engine_id: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiCallsignPageRsp {
    pub prompt: String,
    pub prompt_overridden: bool,
    pub engines: Vec<AiCallsignEngineItem>,
    pub messages: Vec<AiCallsignTestMessageItem>,
    pub worker: AiCallsignWorkerSettingsItem,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiCallsignPromptState {
    pub prompt: String,
    pub prompt_overridden: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct CreateAiCallsignTestMessageReq {
    pub message: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAiCallsignTestMessageReq {
    pub id: String,
    pub message: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiCallsignTestMessageIdReq {
    pub id: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct RunAiCallsignParsingReq {
    pub prompt: String,
    pub ai_engine_ids: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiCallsignParsingRsp {
    pub results: Vec<AiCallsignParseResultItem>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct SaveAiCallsignParsingReq {
    pub prompt: String,
    pub results: Vec<AiCallsignParseResultItem>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct SaveAiCallsignWorkerSettingsReq {
    pub enabled: bool,
    pub ai_engine_id: Option<String>,
}
