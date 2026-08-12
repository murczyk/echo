use crate::types::{Deserialize, Serialize};
use elm_rs::{Elm, ElmDecode, ElmEncode};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiEngineItem {
    pub id: String,
    pub name: String,
    pub url: String,
    pub model_name: String,
    pub enabled: bool,
    pub has_token: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiEngineListRsp {
    pub items: Vec<AiEngineItem>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiEngineIdReq {
    pub id: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct CreateAiEngineReq {
    pub name: String,
    pub url: String,
    pub token: Option<String>,
    pub model_name: String,
    pub enabled: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAiEngineReq {
    pub id: String,
    pub name: String,
    pub url: String,
    pub token: Option<String>,
    pub clear_token: bool,
    pub model_name: String,
    pub enabled: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiChatSummary {
    pub id: String,
    pub title: String,
    pub created_by: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiChatListReq {
    pub ai_engine_id: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiChatListRsp {
    pub items: Vec<AiChatSummary>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiChatGetReq {
    pub ai_engine_id: String,
    pub chat_id: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiChatMessageItem {
    pub id: String,
    pub role: String,
    pub content: String,
    pub created_at: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiChatDetail {
    pub id: String,
    pub title: String,
    pub created_by: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub messages: Vec<AiChatMessageItem>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct SendAiChatMessageReq {
    pub ai_engine_id: String,
    pub chat_id: Option<String>,
    pub prompt: String,
}
