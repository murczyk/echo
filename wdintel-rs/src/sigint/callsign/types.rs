use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Callsign {
    pub id: i64,
    pub callsign: String,
    pub position: String,
    pub comment: String,
    pub unit_id: i64,
    pub active: bool,
    pub source_id: i32,
    pub created_at: i64,
    pub developing: bool,
    /// Set when source_id points to "radio" (id=2)
    pub radio_freq: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum ListCallsignsSortBy {
    CallsignAsc,
    CallsignDesc,
    CallsignCreatedAtAsc,
    CallsignCreatedAtDesc,
    CallsignUnitAsc,
    CallsignUnitDesc,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListCallsignsReq {
    pub after_id: Option<i64>,
    pub before_id: Option<i64>,
    pub filter_callsign: Option<String>,
    pub filter_position: Option<String>,
    pub filter_comment: Option<String>,
    pub filter_unit: Option<String>,
    pub since_date_inclusive_ms: Option<i64>,
    pub till_date_inclusive_ms: Option<i64>,
    pub limit: Option<i64>,
    pub sort_by: Option<Vec<ListCallsignsSortBy>>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListCallsignsRsp {
    pub show_load_more: bool,
    pub callsigns: Vec<Callsign>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CreateCallsignReq {
    pub callsign: String,
    pub position: String,
    pub comment: String,
    pub unit_id: i64,
    pub source_id: i32,
    pub developing: bool,
    pub radio_freq: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CallsignReportingItem {
    pub callsign: String,
    pub is_reported: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CallsignUnitStatsRsp {
    pub units: Vec<CallsignUnitStatRow>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CallsignUnitStatRow {
    pub unit_id: i64,
    pub count: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct GetCallsignsWithUnitsFromInboxReq {
    pub since_date_inclusive_ms: i64,
    pub till_date_inclusive_ms: i64,
    pub callsigns: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct GetCallsignsWithUnitsFromInboxRsp {
    pub callsigns_with_units: Vec<(String, Vec<String>)>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetworkCallsign {
    pub id: i64,
    pub network_id: i64,
    pub callsign: String,
    pub known_callsign_id: Option<i64>,
    pub known_callsign: Option<Callsign>,
    pub position: Option<String>,
    pub comment: Option<String>,
    pub source_id: Option<i64>,
    pub created_at: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum ListNetworkCallsignsSortBy {
    NetworkCallsignAsc,
    NetworkCallsignDesc,
    NetworkCallsignCreatedAtAsc,
    NetworkCallsignCreatedAtDesc,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListNetworkCallsignsReq {
    pub network_id: i64,
    pub sort_by: Option<Vec<ListNetworkCallsignsSortBy>>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListNetworkCallsignsRes {
    pub network_callsigns: Vec<NetworkCallsign>,
}

