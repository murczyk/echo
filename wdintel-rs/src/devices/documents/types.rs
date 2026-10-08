use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::FromQueryResult;
use serde::{Deserialize, Serialize};

#[derive(
    Debug,
    Clone,
    Default,
    Serialize,
    Deserialize,
    Elm,
    ElmEncode,
    ElmDecode,
    PartialEq,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceDocumentSearchReq {
    pub query: Option<String>,
    pub device_ids: Option<Vec<String>>,
    pub include_archived: Option<bool>,
    pub history: Option<bool>,
    pub scope: Option<String>,
    pub path_prefix: Option<String>,
    pub format: Option<String>,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub cursor: Option<String>,
    pub limit: Option<i64>,
}

#[derive(
    Debug,
    Clone,
    Default,
    Serialize,
    Deserialize,
    Elm,
    ElmEncode,
    ElmDecode,
    PartialEq,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceDocumentReadReq {
    pub device_id: String,
    pub file_id: String,
    pub revision: i64,
    pub extraction_revision: Option<String>,
    pub member: Option<String>,
    pub query: Option<String>,
    pub after: Option<i32>,
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
pub struct DeviceDocumentItem {
    pub device_id: String,
    pub file_id: String,
    pub revision: i64,
    pub file_name: String,
    pub path: String,
    pub format: Option<String>,
    pub modified_at: Option<i64>,
    pub current: bool,
    pub has_content: bool,
    pub state: String,
    pub extraction_revision: Option<String>,
    pub complete: bool,
    pub summary: Option<String>,
    pub summary_state: String,
    pub position_state: String,
    pub snippet: Option<String>,
    pub citation: String,
}

#[derive(
    Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode, PartialEq,
)]
#[serde(rename_all = "camelCase")]
pub struct DeviceDocumentSearchRsp {
    pub documents: Vec<DeviceDocumentItem>,
    pub next_cursor: Option<String>,
}

#[derive(
    Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode, PartialEq,
)]
#[serde(rename_all = "camelCase")]
pub struct DeviceDocumentReadRsp {
    pub document: DeviceDocumentItem,
    pub sections: Vec<crate::attachments::types::AttachmentSection>,
    pub next_after: Option<i32>,
    pub warnings: Vec<String>,
    pub coordinates: Vec<crate::media_summary::types::MediaSummaryCoordinate>,
    pub positions: Vec<crate::ai_position::types::AiPositionFound>,
}

#[derive(
    Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode, PartialEq,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceDocumentInspectionReq {
    pub device_id: String,
    pub file_id: String,
    pub revision: i64,
    pub operation: String,
    pub member: Option<String>,
    pub locator: Option<String>,
}

#[derive(
    Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode, PartialEq,
)]
#[serde(rename_all = "camelCase")]
pub struct DeviceDocumentInspectionRsp {
    pub id: String,
    pub state: String,
    pub result: Option<DeviceDocumentReadRsp>,
    pub error: Option<String>,
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
pub struct DeviceDocumentSettings {
    pub enabled: bool,
    pub summaries_enabled: bool,
    pub positions_enabled: bool,
    pub ai_engine_id: Option<String>,
    pub position_engine_id: Option<String>,
}

#[derive(
    Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode, PartialEq,
)]
#[serde(rename_all = "camelCase")]
pub struct DeviceDocumentAdminRsp {
    pub available: bool,
    pub settings: DeviceDocumentSettings,
    pub backfill_complete: bool,
    pub discovered: i64,
    pub counts: Vec<crate::attachments::types::AttachmentQueueCount>,
    pub documents: Vec<DeviceDocumentItem>,
    pub engines: Vec<crate::ai_position::types::AiPositionEngineItem>,
}

#[derive(
    Debug,
    Clone,
    Default,
    Serialize,
    Deserialize,
    Elm,
    ElmEncode,
    ElmDecode,
    PartialEq,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentDeviceSearchReq {
    pub query: Option<String>,
    pub include_archived: Option<bool>,
    pub aor_ids: Option<Vec<i64>>,
    pub unit_ids: Option<Vec<i64>>,
    pub cursor: Option<String>,
    pub limit: Option<u64>,
}

#[derive(
    Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode, PartialEq,
)]
#[serde(rename_all = "camelCase")]
pub struct AgentDeviceItem {
    pub id: String,
    pub name: Option<String>,
    pub archived: bool,
    pub unit_id: Option<i64>,
    pub aor_ids: Vec<i64>,
}

#[derive(
    Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode, PartialEq,
)]
#[serde(rename_all = "camelCase")]
pub struct AgentDeviceSearchRsp {
    pub devices: Vec<AgentDeviceItem>,
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
    Eq,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiAgentFileCitation {
    pub device_id: String,
    pub file_id: String,
    pub revision: i64,
    pub extraction_revision: Option<String>,
    pub section: Option<i32>,
}

impl AiAgentFileCitation {
    pub fn href(&self) -> String {
        let mut query = url::form_urlencoded::Serializer::new(String::new());
        query
            .append_pair("file", &self.file_id)
            .append_pair("revision", &self.revision.to_string());
        if let Some(revision) = &self.extraction_revision {
            query.append_pair("extraction", revision);
        }
        if let Some(section) = self.section {
            query.append_pair("section", &section.to_string());
        }
        format!("/devices/{}?{}", self.device_id, query.finish())
    }
}
