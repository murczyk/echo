use crate::types::{Deserialize, Serialize};
use elm_rs::{Elm, ElmDecode, ElmEncode};

/// A Word document the agent produced in a conversation, at its current
/// (head) revision.
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentDocumentSummary {
    pub id: String,
    pub conversation_id: String,
    pub title: String,
    pub file_name: String,
    pub head_revision: i32,
    pub size_bytes: i64,
    pub source_upload_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentDocumentRevisionInfo {
    pub revision: i32,
    pub parent_revision: Option<i32>,
    pub origin: String,
    pub summary: Option<String>,
    pub request_id: Option<String>,
    pub size_bytes: i64,
    pub created_at: i64,
}

/// One revision saved by a request; the payload of `document_artifact`
/// events and the `documents` of assistant messages.
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentDocumentArtifact {
    pub document_id: String,
    pub revision: i32,
    pub title: String,
    pub file_name: String,
    pub size_bytes: i64,
}

/// The document the user had open when sending a message.
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentDocumentTarget {
    pub document_id: String,
    pub revision: i32,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentDocumentListReq {
    pub conversation_id: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentDocumentListRsp {
    pub documents: Vec<AiAgentDocumentSummary>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentDocumentWorkspaceReq {
    pub document_id: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentDocumentWorkspaceRsp {
    pub document: AiAgentDocumentSummary,
    /// Newest first.
    pub revisions: Vec<AiAgentDocumentRevisionInfo>,
    pub undo_revision: Option<i32>,
    pub redo_revision: Option<i32>,
}

/// Moves the head to `revision` (undo, redo or restoring an older version).
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentDocumentHeadReq {
    pub document_id: String,
    pub expected_revision: i32,
    pub revision: i32,
}

// Agent routes (runner only, not exported to the front end).

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentDocument {
    pub document_id: String,
    pub title: String,
    pub file_name: String,
    pub head_revision: i32,
    pub size_bytes: i64,
    pub updated_at: String,
    pub source_upload_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentTemplate {
    pub upload_id: String,
    pub file_name: String,
    pub size_bytes: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSavedDocument {
    pub document_id: String,
    pub revision: i32,
    pub title: String,
    pub file_name: String,
    pub size_bytes: i64,
    pub created: bool,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentDocumentSourceQuery {
    pub upload_id: Option<String>,
    pub document_id: Option<String>,
    pub revision: Option<i32>,
}

#[derive(Debug, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentDocumentSaveQuery {
    pub idempotency_key: String,
    pub document_id: Option<String>,
    pub expected_revision: Option<i32>,
    pub title: Option<String>,
    pub file_name: Option<String>,
    pub summary: Option<String>,
    pub source_upload_id: Option<String>,
    pub source_document_id: Option<String>,
}
