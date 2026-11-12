use crate::types::{Deserialize, Serialize, Uuid};
use elm_rs::{Elm, ElmDecode, ElmEncode};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
#[derive(sea_orm::FromQueryResult)]
pub struct AiPositionEngineItem {
    pub id: String,
    pub name: String,
    pub model_name: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiPositionWorkerSettingsItem {
    pub enabled: bool,
    pub ai_engine_id: Option<String>,
    pub fallback_ai_engine_id: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiPositionPageRsp {
    pub prompt: String,
    pub prompt_overridden: bool,
    pub engines: Vec<AiPositionEngineItem>,
    pub worker: AiPositionWorkerSettingsItem,
    pub pending_jobs: i64,
    /// Mention feedback whose sources were not re-run since.
    pub open_feedback: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct SaveAiPositionPromptReq {
    pub prompt: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiPositionPromptState {
    pub prompt: String,
    pub prompt_overridden: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct SaveAiPositionWorkerSettingsReq {
    pub enabled: bool,
    pub ai_engine_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "crate::ai_worker::deserialize_fallback_update"
    )]
    pub fallback_ai_engine_id: Option<Option<String>>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct TestAiPositionReq {
    pub prompt: String,
    pub ai_engine_id: String,
    pub text: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct TestAiPositionRsp {
    pub positions: Vec<AiPositionFound>,
    pub response_text: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiPositionSpan {
    pub begin: i32,
    pub end: i32,
}

/// A position grounded in the source text: every occurrence, and the
/// coordinates the text ties to it.
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiPositionFound {
    pub name: String,
    pub name_key: String,
    /// `position`, `crew` or `callsign`.
    pub kind: String,
    pub spans: Vec<AiPositionSpan>,
    pub coordinates: Vec<AiPositionCoordinateItem>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiPositionCoordinateItem {
    pub text: String,
    pub system: String,
    pub mgrs: String,
    pub lat: f64,
    pub lng: f64,
    /// `high`, `medium` or `low`.
    pub certainty: String,
    pub evidence: String,
    pub span: Option<AiPositionSpan>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueAiPositionBackfillReq {
    pub days: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueAiPositionBackfillRsp {
    /// Queueing continues in the background.
    pub started: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiPositionColumnFilter {
    pub id: String,
    pub value: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiPositionListCursor {
    /// Microseconds since the epoch: the full precision rows are ordered by.
    pub at_micros: i64,
    pub id: Uuid,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiPositionMentionListReq {
    pub limit: Option<i64>,
    pub after: Option<AiPositionListCursor>,
    pub global_filter: Option<String>,
    pub column_filters: Vec<AiPositionColumnFilter>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiPositionMentionItem {
    pub id: Uuid,
    /// `message` or `document`.
    pub source_kind: String,
    pub message_id: Option<i64>,
    /// For `/rer-analysis-neo?m=…` links.
    pub message_uuid: Option<String>,
    pub media_id: Option<String>,
    pub media_name: Option<String>,
    pub name: String,
    pub name_key: String,
    /// `position`, `crew` or `callsign`.
    pub kind: String,
    pub context_before: String,
    pub context_match: String,
    pub context_after: String,
    pub message_at: i64,
    pub model_name: String,
    pub group_is_secret: bool,
    pub coordinates: Vec<AiPositionCoordinateItem>,
    /// Newest first.
    pub feedback: Vec<AiPositionFeedbackItem>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiPositionKnowledgeListReq {
    pub limit: Option<i64>,
    pub after: Option<AiPositionListCursor>,
    pub global_filter: Option<String>,
    pub column_filters: Vec<AiPositionColumnFilter>,
}

/// Where a position is, consolidated per area of responsibility or group.
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiPositionKnowledgeItem {
    pub id: Uuid,
    /// `aor` or `group`.
    pub scope_kind: String,
    /// AOR id or group master key.
    pub scope_key: String,
    pub scope_name: String,
    pub scope_is_secret: bool,
    pub name: String,
    pub name_key: String,
    /// `position`, `crew` or `callsign`.
    pub kind: String,
    pub mgrs: String,
    pub lat: f64,
    pub lng: f64,
    pub certainty: String,
    pub fact_count: i32,
    pub conflicting: bool,
    pub first_fact_at: i64,
    pub last_fact_at: i64,
    /// Newest first.
    pub feedback: Vec<AiPositionFeedbackItem>,
}

/// A reviewer's verdict on a mention or a consolidated location.
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiPositionFeedbackItem {
    pub id: Uuid,
    /// `mention` or `knowledge`.
    pub target_kind: String,
    /// `correct`, `not_position`, `wrong_name`, `wrong_coordinates`,
    /// `missed`, `wrong_kind` or `other`.
    pub verdict: String,
    pub expected: String,
    pub comment: String,
    pub created_by: Option<String>,
    pub created_at: i64,
    pub reparsed_at: Option<i64>,
}

/// All feedback, including rejections whose mentions are gone.
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiPositionFeedbackListReq {
    pub verdict: Option<String>,
    pub limit: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiPositionFeedbackListItem {
    pub feedback: AiPositionFeedbackItem,
    pub name: String,
    pub name_key: String,
    pub kind: Option<String>,
    pub message_id: Option<i64>,
    pub message_uuid: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiPositionFeedbackListRsp {
    pub items: Vec<AiPositionFeedbackListItem>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct SaveAiPositionFeedbackReq {
    /// Exactly one of `mention_id` and `knowledge_id`.
    pub mention_id: Option<Uuid>,
    pub knowledge_id: Option<Uuid>,
    pub verdict: String,
    pub expected: String,
    pub comment: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiPositionIdReq {
    pub id: Uuid,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiPositionReparseReq {
    /// One mention's source; `None` re-runs every source with feedback not
    /// yet re-run.
    pub mention_id: Option<Uuid>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiPositionReparseRsp {
    pub queued: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiPositionKnowledgeListRsp {
    pub items: Vec<AiPositionKnowledgeItem>,
    pub next_cursor: Option<AiPositionListCursor>,
}

/// A position lookup: by name, by coordinates (any supported format) with a
/// radius, or both.
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
#[derive(schemars::JsonSchema)]
pub struct AiPositionLookupReq {
    pub name: Option<String>,
    pub coordinates: Option<String>,
    pub radius_meters: Option<f64>,
    /// How far back to look; default 30.
    pub days: Option<i64>,
    /// `position`, `crew` or `callsign`.
    pub kind: Option<String>,
    pub limit: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiPositionLookupKnown {
    pub name: String,
    pub kind: String,
    pub mgrs: String,
    pub lat: f64,
    pub lng: f64,
    pub certainty: String,
    pub conflicting: bool,
    pub fact_count: i32,
    pub first_fact_at: String,
    pub last_fact_at: String,
    pub scope: String,
    pub scope_kind: String,
    pub scope_key: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiPositionLookupMention {
    pub message_id: Option<i64>,
    pub message_uuid: Option<String>,
    /// `message` or `document`.
    pub source: String,
    pub at: String,
    pub name: String,
    pub kind: String,
    pub coordinates: Vec<String>,
    /// The mention in brackets with surrounding text.
    pub context: String,
}

/// Known locations first, then mentions with coordinates, then other
/// mentions for broader context.
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiPositionLookupRsp {
    #[serde(default)]
    pub evidence_groups:
        Vec<crate::devices::documents::evidence::DevicePositionEvidenceGroup>,
    #[serde(default)]
    pub file_mentions:
        Vec<crate::devices::documents::positions::DevicePositionEvidence>,
    pub known: Vec<AiPositionLookupKnown>,
    pub located: Vec<AiPositionLookupMention>,
    pub other: Vec<AiPositionLookupMention>,
    pub note: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiPositionMentionListRsp {
    pub items: Vec<AiPositionMentionItem>,
    pub next_cursor: Option<AiPositionListCursor>,
}
