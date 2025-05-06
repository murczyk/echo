use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};

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
pub struct ZoneDatasourceGroupsSaveReq {
    pub zone_id: i64,
    pub datasource_id: i64,
    pub groups: Vec<String>,
}
