use crate::types::*;

use crate::sigint::area_of_responsibility::types::AreaOfResponsibility;
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
    pub short_note: Option<String>,
    pub long_note: Option<String>,
    pub area_of_responsibility: Option<AreaOfResponsibility>,
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
    pub short_note: Option<String>,
    pub long_note: Option<String>,
    pub area_of_responsibility_id: Option<i64>,
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
    pub short_note: Option<String>,
    pub long_note: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ZoneDatasourceGroupAddRsp {
    pub zone_id: i64,
    pub datasource_id: i64,
    pub group_master_key: String,
    pub group_name: Option<String>,
    pub zone_datasource_group: ZoneDatasourceGroup,
}
