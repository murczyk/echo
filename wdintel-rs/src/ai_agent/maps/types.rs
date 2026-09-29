use crate::ai_agent::types::AiAgentMessageCitation;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiAgentMapRecordInput {
    pub sidc: String,
    pub name: String,
    pub observation_datetime: Option<String>,
    pub coordinate_system: String,
    pub x: String,
    pub y: String,
    #[serde(default)]
    pub comments: Vec<String>,
    #[serde(default)]
    pub sources: Vec<AiAgentMessageCitation>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentMapRecord {
    pub sidc: String,
    pub name: String,
    pub observation_datetime: Option<String>,
    pub platform_type: String,
    pub coordinate_system: String,
    pub original_x: String,
    pub original_y: String,
    pub x: String,
    pub y: String,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub comments: Vec<String>,
    pub sources: Vec<AiAgentMessageCitation>,
    pub warnings: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentMapDocument {
    pub id: String,
    pub title: String,
    pub is_main: bool,
    pub records: Vec<AiAgentMapRecord>,
    pub warnings: Vec<String>,
    pub total_count: usize,
    pub valid_count: usize,
    pub invalid_count: usize,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentMapSummary {
    pub id: String,
    pub request_id: String,
    pub title: String,
    pub is_main: bool,
    pub warnings: Vec<String>,
    pub total_count: usize,
    pub valid_count: usize,
    pub invalid_count: usize,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiAgentMapPrepareReq {
    pub records: Vec<AiAgentMapRecordInput>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentMapPrepareRsp {
    pub records: Vec<AiAgentMapRecord>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiAgentMapGetReq {
    pub request_id: String,
    pub map_id: String,
}
