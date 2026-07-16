use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Signal {
    pub id: i64,
    pub text: String,
    pub meaning: Option<String>,
    pub unit: Option<i64>,
    pub active: bool,
    pub coordinates: Option<String>,
    pub created_at: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum ListSignalsSortBy {
    SignalsCreatedAtAsc,
    SignalsCreatedAtDesc,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListSignalsReq {
    pub sort_by: Vec<ListSignalsSortBy>,
    pub filter_unit: Option<String>,
    pub filter_text: Option<String>,
    pub filter_meaning: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListSignalsRsp {
    pub show_load_more: bool,
    pub signals: Vec<Signal>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CreateSignalReq {
    pub text: String,
    pub meaning: Option<String>,
    pub unit: Option<i64>,
    pub coordinates: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UpdateSignalReq {
    pub id: i64,
    pub text: String,
    pub meaning: Option<String>,
    pub unit: Option<i64>,
    pub coordinates: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SignalUnitStatsRsp {
    pub units: Vec<SignalUnitStatRow>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SignalUnitStatRow {
    pub unit_id: i64,
    pub count: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SignalSearchReq {
    pub search: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SignalSearchResult {
    pub id: i64,
    pub name: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SignalSearchRsp {
    pub signals: Vec<SignalSearchResult>,
}
