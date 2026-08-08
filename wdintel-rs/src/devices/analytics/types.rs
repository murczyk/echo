use chrono::{DateTime, FixedOffset};
use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use uuid::Uuid;

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Clone,
    Copy,
    Debug,
    Deserialize,
    Eq,
    PartialEq,
    Serialize,
)]
#[serde(rename_all = "snake_case")]
pub enum RuleField {
    FileName,
    DirectoryPath,
    FullPath,
    Extension,
}

impl RuleField {
    pub(super) fn is_path(self) -> bool {
        matches!(self, Self::DirectoryPath | Self::FullPath)
    }
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Clone,
    Copy,
    Debug,
    Deserialize,
    Eq,
    PartialEq,
    Serialize,
)]
#[serde(rename_all = "snake_case")]
pub enum RuleMatcher {
    Equals,
    Contains,
    ContainsToken,
    Regex,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Clone,
    Debug,
    Deserialize,
    Eq,
    PartialEq,
    Serialize,
)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum RuleExpression {
    #[serde(rename = "all")]
    RuleAll { children: Vec<RuleExpression> },
    #[serde(rename = "any")]
    RuleAny { children: Vec<RuleExpression> },
    #[serde(rename = "not")]
    Not { child: Box<RuleExpression> },
    #[serde(rename = "match")]
    Match {
        field: RuleField,
        matcher: RuleMatcher,
        values: Vec<String>,
    },
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Clone,
    Debug,
    Deserialize,
    Eq,
    PartialEq,
    Serialize,
)]
#[serde(deny_unknown_fields)]
pub struct RuleValidationError {
    pub path: String,
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(in crate::devices) struct TagRuleDefinition {
    pub tag_id: Uuid,
    pub rule_expression: RuleExpression,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(in crate::devices) struct FileAnalysisInput<'a> {
    pub name: &'a str,
    pub absolute_path: &'a str,
    pub extension: Option<&'a str>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(in crate::devices) struct AnalysisResult {
    pub matched_tags: Vec<Uuid>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Clone,
    Debug,
    Deserialize,
    Eq,
    PartialEq,
    Serialize,
)]
#[serde(deny_unknown_fields)]
pub struct AnalyticsTag {
    pub id: String,
    pub name: String,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Clone,
    Debug,
    Deserialize,
    Eq,
    PartialEq,
    Serialize,
)]
#[serde(deny_unknown_fields)]
pub struct AdminAnalyticsTag {
    pub id: String,
    pub name: String,
    pub rule_expression: Option<RuleExpression>,
    pub archived_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Clone,
    Debug,
    Deserialize,
    Eq,
    PartialEq,
    Serialize,
)]
#[serde(deny_unknown_fields)]
pub struct ListAnalyticsTagsRsp {
    pub tags: Vec<AdminAnalyticsTag>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Clone,
    Debug,
    Deserialize,
    Eq,
    PartialEq,
    Serialize,
)]
#[serde(deny_unknown_fields)]
pub struct CreateAnalyticsTagReq {
    pub name: String,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Clone,
    Debug,
    Deserialize,
    Eq,
    PartialEq,
    Serialize,
)]
#[serde(deny_unknown_fields)]
pub struct UpdateAnalyticsTagReq {
    pub id: String,
    pub name: String,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Clone,
    Debug,
    Deserialize,
    Eq,
    PartialEq,
    Serialize,
)]
#[serde(deny_unknown_fields)]
pub struct AnalyticsTagIdReq {
    pub id: String,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Clone,
    Debug,
    Deserialize,
    Eq,
    PartialEq,
    Serialize,
)]
#[serde(deny_unknown_fields)]
pub struct SaveAnalyticsTagRuleReq {
    pub id: String,
    pub rule_expression: Option<RuleExpression>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Clone,
    Debug,
    Deserialize,
    Eq,
    PartialEq,
    Serialize,
)]
#[serde(deny_unknown_fields)]
pub struct RuleTestFile {
    pub absolute_path: String,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Clone,
    Debug,
    Deserialize,
    Eq,
    PartialEq,
    Serialize,
)]
#[serde(deny_unknown_fields)]
pub struct TestAnalyticsTagRuleReq {
    pub id: String,
    pub rule_expression: Option<RuleExpression>,
    pub files: Vec<RuleTestFile>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Clone,
    Debug,
    Deserialize,
    Eq,
    PartialEq,
    Serialize,
)]
#[serde(deny_unknown_fields)]
pub struct ListAnalyticsTagTestFilesRsp {
    pub files: Vec<RuleTestFile>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Clone,
    Debug,
    Deserialize,
    Eq,
    PartialEq,
    Serialize,
)]
#[serde(deny_unknown_fields)]
pub struct RuleTestFileResult {
    pub index: usize,
    pub matched: bool,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Clone,
    Debug,
    Deserialize,
    Eq,
    PartialEq,
    Serialize,
)]
#[serde(deny_unknown_fields)]
pub struct TestAnalyticsTagRuleRsp {
    pub results: Vec<RuleTestFileResult>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Clone,
    Debug,
    Deserialize,
    Eq,
    PartialEq,
    Serialize,
)]
#[serde(deny_unknown_fields)]
pub struct ReanalyzeDeviceReq {
    pub device_id: String,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Clone,
    Debug,
    Deserialize,
    Eq,
    PartialEq,
    Serialize,
)]
#[serde(deny_unknown_fields)]
pub struct ReanalysisRsp {
    pub scheduled_file_count: u64,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Clone,
    Debug,
    Deserialize,
    Eq,
    PartialEq,
    Serialize,
)]
#[serde(deny_unknown_fields)]
pub struct DeviceAnalyticsReq {
    pub device_id: String,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Clone,
    Debug,
    Deserialize,
    Eq,
    PartialEq,
    Serialize,
)]
#[serde(deny_unknown_fields)]
pub struct DeviceAnalyticsTagsRsp {
    pub tags: Vec<AnalyticsTag>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Clone,
    Debug,
    Deserialize,
    Eq,
    PartialEq,
    Serialize,
)]
#[serde(deny_unknown_fields)]
pub struct DeviceAnalyticsSummaryItem {
    pub tag: AnalyticsTag,
    pub file_count: u64,
    pub latest_file_entry_created_at: String,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Clone,
    Debug,
    Deserialize,
    Eq,
    PartialEq,
    Serialize,
)]
#[serde(deny_unknown_fields)]
pub struct DeviceAnalyticsSummaryRsp {
    pub items: Vec<DeviceAnalyticsSummaryItem>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Clone,
    Debug,
    Deserialize,
    Eq,
    PartialEq,
    Serialize,
)]
#[serde(deny_unknown_fields)]
pub struct DeviceAnalyticsFilesReq {
    pub device_id: String,
    pub tag_id: String,
    pub limit: Option<u64>,
    pub cursor: Option<String>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Clone,
    Debug,
    Deserialize,
    Eq,
    PartialEq,
    Serialize,
)]
#[serde(deny_unknown_fields)]
pub struct DeviceAnalyticsFile {
    pub file_id: String,
    pub name: String,
    pub absolute_path: String,
    pub file_entry_created_at: String,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Clone,
    Debug,
    Deserialize,
    Eq,
    PartialEq,
    Serialize,
)]
#[serde(deny_unknown_fields)]
pub struct DeviceAnalyticsFilesRsp {
    pub files: Vec<DeviceAnalyticsFile>,
    pub next_cursor: Option<String>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Clone,
    Copy,
    Debug,
    Deserialize,
    Eq,
    PartialEq,
    Serialize,
)]
#[serde(rename_all = "snake_case")]
pub enum TagMatch {
    #[serde(rename = "any")]
    TagAny,
    #[serde(rename = "all")]
    TagAll,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(in crate::devices) struct TagFilter {
    pub tag_ids: Vec<Uuid>,
    pub tag_match: TagMatch,
    pub untagged: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(in crate::devices) struct DeviceAnalyticsSummary {
    pub tag_id: Uuid,
    pub tag_name: String,
    pub file_count: u64,
    pub latest_file_entry_created_at: DateTime<FixedOffset>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(in crate::devices) struct DeviceAnalyticsFileLink {
    pub file_entry_id: Uuid,
    pub file_entry_created_at: DateTime<FixedOffset>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(in crate::devices) struct ActiveTagRule {
    pub tag_id: Uuid,
    pub rule_expression: JsonValue,
}
