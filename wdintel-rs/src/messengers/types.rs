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
    pub phone: Option<String>,
    pub status: Option<String>,
    pub is_active: Option<bool>,
    pub is_paused: Option<bool>,
    pub last_sync: Option<i64>,
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
