use crate::types::{Deserialize, Serialize};
use elm_rs::{Elm, ElmDecode, ElmEncode};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentProviderItem {
    pub id: String,
    pub name: String,
    pub model_name: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentConfigurationRsp {
    pub feature_enabled: bool,
    pub default_ai_engine_id: Option<String>,
    pub providers: Vec<AiAgentProviderItem>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentConversationSummary {
    pub id: String,
    pub title: String,
    pub ai_engine_id: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentConversationListRsp {
    pub items: Vec<AiAgentConversationSummary>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentConversationCreateReq {
    pub ai_engine_id: Option<String>,
    pub title: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentConversationIdReq {
    pub id: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentConversationUpdateReq {
    pub id: String,
    pub title: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentMessageItem {
    pub request_id: String,
    pub request_state: String,
    pub role: String,
    pub content: String,
    pub created_at: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentConversationDetail {
    pub id: String,
    pub title: String,
    pub ai_engine_id: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub messages: Vec<AiAgentMessageItem>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentRequestCreateReq {
    pub conversation_id: Option<String>,
    pub ai_engine_id: Option<String>,
    pub prompt: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentRequestCreateRsp {
    pub request_id: String,
    pub conversation_id: String,
    pub state: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentRequestIdReq {
    pub request_id: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentRequestCancelRsp {
    pub state: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentBootstrapExchangeReq {
    pub token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentBootstrapExchangeRsp {
    pub correlation_id: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentAdminSettingsItem {
    pub feature_enabled: bool,
    pub template_login_id: String,
    pub default_ai_engine_id: Option<String>,
    pub reviewer_ai_engine_id: Option<String>,
    pub security_review_enabled: bool,
    pub mattermost_chat_enabled: bool,
    pub has_mattermost_webhook: bool,
    pub allowed_ai_engine_ids: Vec<String>,
    pub provider_runtime_profiles: Vec<AiAgentProviderRuntimeProfileItem>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentProviderRuntimeProfileItem {
    pub ai_engine_id: String,
    pub context_window_tokens: i32,
    pub max_output_tokens: i32,
    pub compaction_reserve_tokens: i32,
    pub compaction_keep_recent_tokens: i32,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentAdminSettingsUpdateReq {
    pub feature_enabled: bool,
    pub template_login_id: Option<String>,
    pub default_ai_engine_id: Option<String>,
    pub reviewer_ai_engine_id: Option<String>,
    pub security_review_enabled: bool,
    pub mattermost_chat_enabled: bool,
    pub mattermost_webhook_url: Option<String>,
    pub clear_mattermost_webhook: bool,
    pub allowed_ai_engine_ids: Vec<String>,
    pub provider_runtime_profiles: Vec<AiAgentProviderRuntimeProfileItem>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentDispatcherItem {
    pub configured: bool,
    pub host: String,
    pub ssh_port: i32,
    pub ssh_user: String,
    pub namespace: String,
    pub identity_file: String,
    pub known_hosts_file: String,
    pub identity_file_present: bool,
    pub known_hosts_file_present: bool,
    pub last_tested_at: Option<i64>,
    pub last_test_error: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentDispatcherUpdateReq {
    pub host: String,
    pub ssh_port: i32,
    pub ssh_user: String,
    pub namespace: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentEchoProxyItem {
    pub id: String,
    pub hostname: String,
    pub upstream_host: String,
    pub upstream_port: i32,
    pub enabled: bool,
    pub last_tested_at: Option<i64>,
    pub last_test_error: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentEchoProxyListRsp {
    pub items: Vec<AiAgentEchoProxyItem>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentEchoProxyUpsertReq {
    pub id: Option<String>,
    pub hostname: String,
    pub upstream_host: String,
    pub upstream_port: i32,
    pub enabled: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentIdReq {
    pub id: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentContainerItem {
    pub linked_agent_id: String,
    pub human_login_id: String,
    pub human_login: String,
    pub agent_login_id: String,
    pub agent_login: String,
    pub instance_name: String,
    pub state: String,
    pub last_error: Option<String>,
    pub stats_json: Option<String>,
    pub started_at: Option<i64>,
    pub stopped_at: Option<i64>,
    pub last_activity_at: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentContainerListRsp {
    pub items: Vec<AiAgentContainerItem>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentAdminRequestListReq {
    pub state: Option<String>,
    pub suspicious: Option<bool>,
    pub limit: Option<i32>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentSecurityReviewItem {
    pub state: String,
    pub suspicious: Option<bool>,
    pub severity: Option<String>,
    pub categories: Vec<String>,
    pub summary: Option<String>,
    pub attempt_count: i32,
    pub last_error: Option<String>,
    pub alert_state: Option<String>,
    pub alert_attempt_count: i32,
    pub alert_last_error: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentAdminRequestItem {
    pub id: String,
    pub conversation_id: String,
    pub human_login_id: String,
    pub human_login: String,
    pub ai_engine_id: String,
    pub ai_engine_name: String,
    pub prompt: String,
    pub response: Option<String>,
    pub state: String,
    pub error: Option<String>,
    pub queued_at: i64,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub review: Option<AiAgentSecurityReviewItem>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentAdminRequestListRsp {
    pub items: Vec<AiAgentAdminRequestItem>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentRequestEventItem {
    pub sequence: i64,
    pub event_type: String,
    pub payload_json: String,
    pub created_at: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentAdminRequestDetail {
    pub request: AiAgentAdminRequestItem,
    pub conversation: AiAgentConversationDetail,
    pub events: Vec<AiAgentRequestEventItem>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentAdminUserReq {
    pub login_id: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentAdminUserItem {
    pub human_login_id: String,
    pub human_login: String,
    pub linked_agent_id: Option<String>,
    pub agent_login_id: Option<String>,
    pub agent_login: Option<String>,
    pub linked_login_enabled: Option<bool>,
    pub roles: Vec<String>,
    pub organism_id: Option<i64>,
    pub organism_name: Option<String>,
    pub sigint_zone_id: Option<i64>,
    pub sigint_zone_name: Option<String>,
    pub direct_hidden_groups: Vec<String>,
    pub instance_name: Option<String>,
    pub container_state: Option<String>,
    pub container_last_error: Option<String>,
    pub stats_json: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct AiAgentConnectionTestRsp {
    pub ok: bool,
    pub message: String,
}
