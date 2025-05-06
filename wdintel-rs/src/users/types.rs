use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct User {
    pub name: String,
    pub roles: Vec<String>,
    pub sigint_zone_id: Option<i64>,
    pub organism_id: Option<i64>,
    pub delta_login: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct LoginReq {
    pub user: String,
    pub password: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SettingsSaveReq {
    pub sigint_zone_id: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UserInfoReq {
    pub login: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Login {
    pub login: String,
    pub roles: Vec<String>,
    pub created_at: i64,
    pub deleted: bool,
    pub sigint_zone_id: Option<i64>,
    pub sigint_zone_name: Option<String>,
    pub organism_id: Option<i64>,
    pub organism_name: Option<String>,
    pub organism_enabled: Option<bool>,
    pub delta_login: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum ListLoginsSortBy {
    LoginCreatedAtDesc,
    LoginCreatedAtAsc,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListLoginsReq {
    pub sort_by: Option<ListLoginsSortBy>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListLoginsRsp {
    pub users: Vec<Login>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CreateLoginReq {
    pub login: String,
    pub password: String,
    pub roles: Vec<String>,
    pub sigint_zone_id: Option<i64>,
    pub organism_id: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CreateDeltaLoginReq {
    pub login: String,
    pub roles: Vec<String>,
    pub sigint_zone_id: Option<i64>,
    pub organism_id: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UpdateLoginReq {
    pub login: String,
    pub roles: Option<Vec<String>>,
    pub sigint_zone_id: Option<i64>,
    pub organism_id: Option<i64>,
    pub deleted: Option<bool>,
    pub password: Option<String>,
    pub delta_login: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct KeepAliveReq {
    pub page_id: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SigintGroupsReq {
    pub since_date_inclusive_ms: Option<i64>,
}
