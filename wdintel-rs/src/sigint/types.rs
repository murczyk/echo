use crate::types::*;

use elm_rs::{Elm, ElmDecode, ElmEncode};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SigintZone {
    pub name: String,
    pub created_at: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ZoneDatasourceGroupsReq {
    pub zone_id: i64,
    pub datasource_id: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ZoneDatasourceGroup {
    pub sigint_zone_datasource_id: i64,
    pub group_master_key: String,
    pub is_group_secret: bool,
    pub allowed_users: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ZoneDatasourceGroupListRsp {
    pub zone_datasource_groups: Vec<ZoneDatasourceGroup>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ZoneDatasourceGroupUpdateReq {
    pub id: i64,
    pub is_secret: bool,
    pub user_logins: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ZoneDatasourceGroupAddReq {
    pub zone_id: i64,
    pub datasource_id: i64,
    pub is_secret: bool,
    pub master_key: String,
    pub user_logins: Vec<String>,
}
