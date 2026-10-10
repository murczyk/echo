use crate::types::{Deserialize, Serialize};
use elm_rs::{Elm, ElmDecode, ElmEncode};

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Clone,
    sea_orm::FromQueryResult,
)]
#[serde(rename_all = "camelCase")]
pub struct SettlementAliasSettlement {
    pub id: i32,
    pub name: String,
    pub district: Option<String>,
    pub region: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct SettlementAliasItem {
    pub id: String,
    pub settlement: SettlementAliasSettlement,
    pub text: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct ListSettlementAliasesReq {
    pub after_id: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct ListSettlementAliasesRsp {
    pub items: Vec<SettlementAliasItem>,
    pub next_id: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct SearchAliasSettlementsReq {
    pub query: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct SaveSettlementAliasReq {
    pub id: Option<String>,
    pub settlement_id: i32,
    pub text: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct SettlementAliasIdReq {
    pub id: String,
}

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
    pub groups_except: bool,
    pub group_master_keys: Vec<String>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Clone,
    sea_orm::FromQueryResult,
)]
#[serde(rename_all = "camelCase")]
pub struct AiSettlementGroupItem {
    pub master_key: String,
    pub name: Option<String>,
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
    pub groups: Vec<AiSettlementGroupItem>,
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
    #[serde(default)]
    pub groups_except: bool,
    #[serde(default)]
    pub group_master_keys: Vec<String>,
}
