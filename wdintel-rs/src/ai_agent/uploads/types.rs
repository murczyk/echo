use crate::types::{Deserialize, Serialize};
use elm_rs::{Elm, ElmDecode, ElmEncode};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentUploadItem {
    pub id: String,
    pub conversation_id: Option<String>,
    pub request_id: Option<String>,
    pub file_name: String,
    pub content_type: String,
    pub size_bytes: i64,
    pub state: String,
    pub is_image: bool,
    pub chunk_count: i32,
    pub last_error: Option<String>,
    pub created_at: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentUploadListReq {
    #[serde(default)]
    pub conversation_id: Option<String>,
    #[serde(default)]
    pub ids: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentUploadListRsp {
    pub uploads: Vec<AiAgentUploadItem>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentUploadIdReq {
    pub id: String,
}

/// Agent tool request: read sections of one conversation upload.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentUploadReadReq {
    pub upload_id: String,
    #[serde(default)]
    pub after: Option<i32>,
    #[serde(default)]
    pub limit: Option<i32>,
    #[serde(default)]
    pub query: Option<String>,
}

/// Agent tool request: full-text search across conversation uploads.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentUploadSearchReq {
    pub query: String,
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentUploadIdReq {
    pub upload_id: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct AgentUploadListReq {}
