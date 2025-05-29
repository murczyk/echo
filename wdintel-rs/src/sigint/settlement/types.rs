use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Settlement {
    pub id: i64,
    pub name: String,
    pub lat: f64,
    pub lng: f64,
    pub alternative_names: Vec<String>,
    pub post_ids: Vec<i64>,
    pub created_at: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum SettlementSorting {
    ByName,
    ByCreatedAt,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListSettlementsReq {
    pub sorting: SettlementSorting,
    pub offset: Option<u64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListSettlementsRsp {
    pub show_load_more: bool,
    pub settlements: Vec<Settlement>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CreateSettlementReq {
    pub name: String,
    pub lat: f64,
    pub lng: f64,
    pub alternative_names: Vec<String>,
    pub post_id: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UpdateSettlementReq {
    pub id: i64,
    pub name: String,
    pub lat: f64,
    pub lng: f64,
    pub alternative_names: Vec<String>,
    pub post_id: Option<i64>,
}
