use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersTelegramAccountId {
    pub user_id: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessengersAccountsListReq {}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersAccountsListRsp {
    pub items: Vec<MessengersAccountItem>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersAccountItem {
    pub id: String,
    pub messenger_type: String,
    pub external_id: String,
    pub display_name: String,
    pub username: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub phone: Option<String>,
    pub status: Option<String>,
    pub status_error: Option<String>,
    pub status_changed_at: Option<i64>,
    pub is_active: Option<bool>,
    pub is_paused: Option<bool>,
    pub created_at: Option<i64>,
    pub last_sync: Option<i64>,
    pub notes: Option<String>,
    pub telegram: Option<MessengersTelegramAccountId>,
    pub datasource_group: MessengersDatasourceGroup,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersDatasourceGroup {
    pub id: i64,
    pub group_master_key: String,
    pub datasource_id: i64,
    pub name: String,
    pub last_sync_at: i64,
    pub created_at: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersTelegramChatId {
    pub chat_id: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersChatsListReq {
    pub account_id: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersChatsListRsp {
    pub items: Vec<MessengersChatItem>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessengersChatItem {
    pub id: String,
    pub messenger_type: String,
    pub external_id: String,
    pub chat_type: Option<String>,
    pub title: Option<String>,
    pub username: Option<String>,
    pub members_count: Option<i32>,
    pub account_member_status: Option<String>,
    pub last_message_date: Option<i64>,
    pub telegram: Option<MessengersTelegramChatId>,
}
