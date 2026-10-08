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
    #[serde(default)]
    pub file_sources:
        Vec<crate::devices::documents::types::AiAgentFileCitation>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentMapRecord {
    #[serde(default)]
    pub id: String,
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
    #[serde(default)]
    pub file_sources:
        Vec<crate::devices::documents::types::AiAgentFileCitation>,
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
    #[serde(default)]
    pub revision: Option<i32>,
}

/// A symbol drawn by the browser (milsymbol) for KMZ export.
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiAgentMapIcon {
    pub sidc: String,
    pub png_base64: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiAgentMapKmzReq {
    pub request_id: String,
    pub map_id: String,
    #[serde(default)]
    pub revision: Option<i32>,
    #[serde(default)]
    pub icons: Vec<AiAgentMapIcon>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentMapEditTarget {
    pub request_id: String,
    pub map_id: String,
    pub revision: i32,
    #[serde(default)]
    pub selected_point_ids: Vec<String>,
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
    Default,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiAgentMapSelector {
    #[serde(default)]
    pub ids: Vec<String>,
    #[serde(default)]
    pub names: Vec<String>,
    #[serde(default)]
    pub sidc: Option<String>,
    #[serde(default)]
    pub all: bool,
    #[serde(default)]
    pub expect: Option<String>,
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
    Default,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiAgentMapFieldPatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub observation_datetime: Option<String>,
    #[serde(default)]
    pub clear_observation_datetime: bool,
    #[serde(default)]
    pub comments: Option<Vec<String>>,
    #[serde(default)]
    pub coordinate_system: Option<String>,
    #[serde(default)]
    pub x: Option<String>,
    #[serde(default)]
    pub y: Option<String>,
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
    Default,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiAgentMapSidcComponents {
    #[serde(default)]
    pub group1: Option<String>,
    #[serde(default)]
    pub context: Option<String>,
    #[serde(default)]
    pub identity: Option<String>,
    #[serde(default)]
    pub symbol_set: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub headquarters_or_task_force: Option<String>,
    #[serde(default)]
    pub echelon: Option<String>,
    #[serde(default)]
    pub main_icon: Option<String>,
    #[serde(default)]
    pub modifier1: Option<String>,
    #[serde(default)]
    pub modifier2: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiAgentMapPatchOp {
    pub op: String,
    #[serde(default)]
    pub selector: Option<AiAgentMapSelector>,
    #[serde(default)]
    pub record: Option<AiAgentMapRecordInput>,
    #[serde(default)]
    pub fields: Option<AiAgentMapFieldPatch>,
    #[serde(default)]
    pub components: Option<AiAgentMapSidcComponents>,
    #[serde(default)]
    pub sidc: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiAgentMapEditReq {
    pub request_id: String,
    pub map_id: String,
    pub expected_revision: i32,
    pub idempotency_key: String,
    #[serde(default)]
    pub summary: Option<String>,
    pub operations: Vec<AiAgentMapPatchOp>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiAgentMapRevisionReq {
    pub request_id: String,
    pub map_id: String,
    pub expected_revision: i32,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentMapRevisionInfo {
    pub revision: i32,
    pub parent_revision: Option<i32>,
    pub origin: String,
    pub summary: String,
    pub created_at: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentMapFieldChange {
    pub field: String,
    pub before: String,
    pub after: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentMapEditChange {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub fields: Vec<AiAgentMapFieldChange>,
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
    Default,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentMapEditDiff {
    pub added_count: usize,
    pub updated_count: usize,
    pub removed_count: usize,
    pub changes: Vec<AiAgentMapEditChange>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiAgentMapWorkspaceReq {
    pub request_id: String,
    pub map_id: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentMapWorkspaceRsp {
    pub revision: i32,
    pub can_undo: bool,
    pub can_redo: bool,
    pub document: AiAgentMapDocument,
    /// Difference between the head revision and its parent.
    pub changes: AiAgentMapEditDiff,
    pub revisions: Vec<AiAgentMapRevisionInfo>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentMapEditRsp {
    pub revision: i32,
    pub matched_ids: Vec<String>,
    pub added_count: usize,
    pub updated_count: usize,
    pub removed_count: usize,
    pub total_count: usize,
    pub truncated: bool,
    pub changes: Vec<AiAgentMapEditChange>,
    pub can_undo: bool,
    pub can_redo: bool,
}
