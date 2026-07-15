use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Unit {
    pub id: i64,
    pub company: String,
    pub battalion: String,
    pub regiment: String,
    pub division: String,
    pub army: String,
    pub comment: String,
    pub name: String,
    pub active: bool,
    pub created_at: i64,
    pub created_by: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum ListUnitsSortBy {
    CreatedAtDesc,
    CreatedAtAsc,
    NaturalMilitarySortAsc,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListUnitsReq {
    pub sort_by: Option<ListUnitsSortBy>,
    pub after_unit_id: Option<i64>,
    pub before_unit_id: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListUnitsRsp {
    pub show_load_more: bool,
    pub units: Vec<Unit>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListUnitsByIdReq {
    pub ids: Option<Vec<i64>>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListUnitsByIdRsp {
    pub units: Vec<Unit>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CreateUnitReq {
    pub company: String,
    pub battalion: String,
    pub regiment: String,
    pub division: String,
    pub army: String,
    pub active: bool,
    pub comment: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CreateUnitWithAutoNetworkReq {
    pub unit: CreateUnitReq,
    pub skip_network_creation: bool,
    pub locations: Vec<String>,
    pub unit_mask: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CreateUnitWithAutoNetworkRsp {
    pub unit: Unit,
    pub network_id: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DeleteUnitDuplicateReq {
    pub clone_to_delete_id: i64,
    pub original_id: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UnitSearchReq {
    pub search: String,
}
