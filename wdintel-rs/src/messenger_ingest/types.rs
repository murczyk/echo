pub use crate::messenger_ingest::refs::MessengerIngestTelegramAccountId;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};

/// A full-state account snapshot from the collector. Fields left `None`
/// are cleared on update; the payload is authoritative for its entity.
/// Timestamps are epoch milliseconds.
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengerIngestAccountInput {
    pub external_id: String,
    pub display_name: String,
    pub phone: Option<String>,
    pub username: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub status: Option<String>,
    pub status_error: Option<String>,
    pub status_changed_at: Option<i64>,
    pub is_active: Option<bool>,
    pub is_paused: Option<bool>,
    pub notes: Option<String>,
    pub created_at: Option<i64>,
    pub last_sync: Option<i64>,
    pub telegram: MessengerIngestTelegramAccountId,
}

/// The stored account body, as Echo returns it. `id` is the echo UUIDv7;
/// `telegram.user_id` echoes the stored messenger id as a decimal string.
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengerIngestAccountItem {
    pub id: String,
    pub external_id: String,
    pub display_name: String,
    pub phone: Option<String>,
    pub username: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub status: Option<String>,
    pub status_error: Option<String>,
    pub status_changed_at: Option<i64>,
    pub is_active: Option<bool>,
    pub is_paused: Option<bool>,
    pub notes: Option<String>,
    pub created_at: Option<i64>,
    pub last_sync: Option<i64>,
    pub telegram: MessengerIngestTelegramAccountId,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengerIngestAccountsSyncReq {
    pub created: Vec<MessengerIngestAccountInput>,
    pub updated:
        std::collections::BTreeMap<String, MessengerIngestAccountInput>,
    pub deleted: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengerIngestAccountsSyncRsp {
    pub created: std::collections::BTreeMap<String, MessengerIngestAccountItem>,
    pub updated: std::collections::BTreeMap<String, MessengerIngestAccountItem>,
    pub deleted: Vec<String>,
}
