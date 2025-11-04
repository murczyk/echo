use crate::entities::signal_message;
use crate::messenger::group::types::SignalGroupStats;
use crate::sigint::aor::types::AreaOfResponsibility;
use chrono::NaiveDateTime;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};
use std::fmt::Debug;

#[derive(Debug)]
pub struct Message {
    pub body: String,
    pub group_id: String,
    pub sender: Option<String>,
    pub timestamp: NaiveDateTime,
    pub datasource_id: i64,
}

#[derive(Debug, Serialize, Clone, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct EchoAccountF1 {
    pub id: i64,
    pub area_of_responsibility: Option<AreaOfResponsibility>,
    pub status: String,
    pub created_at: i64,
    pub client_id: Option<i32>,
    pub display_name: String,
    pub system_service_name: Option<String>,
    pub description: Option<String>,
    pub messenger: String,
    pub phone_number: String,
    pub api_login: Option<String>,
    pub api_endpoint: Option<String>,
    pub is_linked: bool,
    pub is_imported: bool,
}

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct EchoAreaOfResponsibilityF1 {
    pub id: i64,
    pub aor_id: Option<i64>,
    pub status: String,
    pub created_at: i64,
    pub client_id: Option<i32>,
    pub display_name: String,
    pub system_service_name: Option<String>,
    pub description: Option<String>,
    pub messenger: String,
    pub phone_number: String,
    pub is_linked: bool,
    pub is_imported: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct GroupEntryF1 {
    pub master_key: String,
    pub name: String,
    pub ignore_operativny: bool,
    pub short_note: Option<String>,
    pub long_note: Option<String>,
    pub group_stats: SignalGroupStats,
    pub areas_of_responsibility: Option<Vec<AreaOfResponsibility>>,
}

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct QrCodeReq {
    pub account_id: i64,
}

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct QrCodeRsp {
    pub qr_code_base64: String,
}

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct AccountsRsp {
    pub accounts: Vec<EchoAccountF1>,
}

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct IsAccountLinkedReq {
    pub account_id: i64,
}

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct IsAccountLinkedRsp {
    pub is_linked: bool,
}

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct AccountStatusReq {
    pub account_id: i64,
    pub aor_id: Option<i64>,
    pub is_active: bool,
    pub display_name: String,
    pub description: Option<String>,
    pub api_login: Option<String>,
    pub api_endpoint: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct DeleteAccountReq {
    pub account_id: i64,
}

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct LinkAccountReq {
    pub phone: String,
    pub messenger: String,
    pub display_name: String,
    pub system_service_name: String,
    pub description: Option<String>,
    pub aor_id: i64,
}

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct LinkEchoOperatorReq {
    pub api_login: String,
    pub api_endpoint: String,
    pub display_name: String,
    pub description: Option<String>,
    pub aor_id: i64,
}

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct LinkAccountRsp {
    pub account: EchoAccountF1,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct GroupUpdateReq {
    pub master_key: String,
    pub short_note: Option<String>,
    pub long_note: Option<String>,
    /// Deprecated - use area_of_responsibility_ids instead
    pub area_of_responsibility_id: Option<i64>,
    pub area_of_responsibility_ids: Option<Vec<i64>>,
}

pub struct UnstageResult {
    pub message: signal_message::Model,
    pub is_duplicate: bool,
}

pub struct WorkerStatus {
    pub datasource_id: i64,
    pub failed: bool,
}

pub struct SyncResult {
    pub is_healthy: bool,
    pub num_synced_inbox_messages: usize,
}

#[derive(Default)]
pub struct AccountSyncResult {
    pub is_linked: bool,
    pub client_name: Option<String>,
}
