use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
#[serde(rename_all = "camelCase")]
pub struct MessengerAlertSettings {
    pub enabled: bool,
    pub sender_datasource_ids: Vec<i64>,
}

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
#[serde(rename_all = "camelCase")]
pub struct MessengerAlertPreference {
    pub receive_alerts_in_messenger: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
#[serde(rename_all = "camelCase")]
pub struct MessengerAlertHistoryReq {
    pub before_id: Option<Uuid>,
}

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
#[serde(rename_all = "camelCase")]
pub struct MessengerAlertHistoryEntry {
    pub id: Uuid,
    pub recipient_login: String,
    pub recipient_profile_id: String,
    pub message_url: String,
    pub status: String,
    pub sender_name: Option<String>,
    pub attempted_sender_ids: Vec<i64>,
    pub error: Option<String>,
    pub created_at: i64,
    pub sent_at: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
#[serde(rename_all = "camelCase")]
pub struct MessengerAlertHistoryRsp {
    pub entries: Vec<MessengerAlertHistoryEntry>,
    pub next_before_id: Option<Uuid>,
}
