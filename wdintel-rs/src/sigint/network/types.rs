use crate::sigint::etalonka::types::*;
use chrono::NaiveDateTime;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::FromQueryResult;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, FromQueryResult)]
pub struct NetworkDesc {
    pub id: i64,
    pub kind: String,
    pub name: String,
    pub location: String,
    pub comment: String,
    pub radio_station: Option<String>,
    pub confirmation: Option<String>,
    pub created_at: NaiveDateTime,
    pub purpose: Option<String>,
    pub operation_mode: Option<String>,
    pub operation_type: Option<String>,
    pub operation_period: Option<String>,
    pub signs: Option<String>,
    pub unit_name: String,
    pub updated_by: Option<String>,
    pub updated_at: NaiveDateTime,
    pub active_from: NaiveDateTime,
    pub active_to: Option<NaiveDateTime>,
    pub modulation_id: Option<i32>,
    pub modulation_name: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Network {
    pub id: i64,
    pub freqs: Vec<String>,
    pub unit_ids: Vec<i64>,
    pub kind: String,
    pub name: String,
    pub location: String,
    pub comment: String,
    pub radio_station: Option<String>,
    pub confirmation: Option<String>,
    pub created_at: i64,
    pub purpose: Option<String>,
    pub operation_mode: Option<String>,
    pub operation_type: Option<String>,
    pub operation_period: Option<String>,
    pub signs: Option<String>,
    pub last_updated_at: i64,
    pub last_updated_by: Option<String>,
    pub active_from: i64,
    pub active_to: Option<i64>,
    pub modulation_id: Option<i32>,
    pub modulation_name: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UpdateFreqNetworksReq {
    pub freq: String,
    pub networks: Vec<UpdFreqNetwork>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CreateNetworkReq {
    pub freqs: Option<Vec<String>>,
    pub unit_ids: Vec<i64>,
    pub kind: String,
    pub name: String,
    pub location: String,
    pub comment: String,
    pub radio_station: Option<String>,
    pub confirmation: Option<String>,
    pub purpose: Option<String>,
    pub operation_mode: Option<String>,
    pub operation_type: Option<String>,
    pub operation_period: Option<String>,
    pub signs: Option<String>,
    pub active_from: Option<i64>,
    pub active_to: Option<i64>,
    pub modulation_id: Option<i32>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UpdateNetworkReq {
    pub id: i64,
    // use a separate API to add/remove freqs and units
    // pub freqs: Option<Vec<String>>,
    // pub unit_ids: Vec<i64>,
    pub kind: String,
    pub name: String,
    pub location: String,
    pub comment: String,
    pub radio_station: Option<String>,
    pub confirmation: Option<String>,
    pub purpose: Option<String>,
    pub operation_mode: Option<String>,
    pub operation_type: Option<String>,
    pub operation_period: Option<String>,
    pub signs: Option<String>,
    pub active_from: i64,
    pub active_to: Option<i64>,
    pub modulation_id: Option<i32>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MergeNetworkReq {
    pub network_id_from: i64,
    pub network_id_to: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetworkCallsignsReq {
    pub network_ids: Vec<i64>,
    pub since_date_inclusive_ms: Option<i64>,
    pub till_date_noninclusive_ms: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetworkGroupsActivityOneReq {
    pub network_id: i64,
    pub till_date_noninclusive_ms: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetworkGroupsActivityReq {
    pub network_ids: Vec<i64>,
    pub till_date_noninclusive_ms: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListNetworkPointsReq {
    pub network_id: i64,
    pub since_date_inclusive_ms: i64,
    pub till_date_noninclusive_ms: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetworkUnitStatsRsp {
    pub units: Vec<NetworkUnitStatRow>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetworkUnitStatRow {
    pub unit_id: i64,
    pub count: i64,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Clone,
    FromQueryResult,
)]
pub struct NetworkPoint {
    pub lat: f64,
    pub lng: f64,
    pub body: String,
    pub id: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListNetworkPointsRsp {
    pub points: Vec<NetworkPoint>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UpdFreqNetwork {
    pub id: Option<i64>,
    pub unit_ids: Vec<i64>,
    pub kind: String,
    pub name: String,
    pub location: String,
    pub comment: String,
    pub radio_station: Option<String>,
    pub confirmation: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListNetworksReq {
    pub since_date_inclusive_ms: Option<i64>,
    pub till_date_noninclusive_ms: Option<i64>,
    pub filter_freq: Option<String>,
    pub filter_unit: Option<String>,
    pub sort_by: Option<Vec<ListNetworksSortBy>>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum ListNetworksSortBy {
    NameAsc,
    NameDesc,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AddNetworkFreqReq {
    pub network_id: i64,
    pub freq: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DeleteNetworkFreqReq {
    pub network_id: i64,
    pub freq: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SingleNetworkCallsignsReq {
    pub network_id: i64,
}
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SingleNetworkCallsignsListRsp {
    pub callsigns: Vec<CallsignRes>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SingleNetworkFreqsReq {
    pub network_id: i64,
}
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SingleNetworkFreqsListRsp {
    pub freqs: Vec<NetworkFreqsRes>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ModulationRec {
    pub id: i32,
    pub name: String,
    pub left: i32,
    pub right: i32,
    pub enabled: bool,
}
