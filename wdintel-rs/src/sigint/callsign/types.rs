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
pub struct ListCallsignBindsReq {
    pub callsign_ids: Vec<i64>,
    pub since_date_inclusive_ms: Option<i64>,
    pub till_date_inclusive_ms: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CallsignBind {
    pub id: i64,
    pub freq: String,
    pub comment: Option<String>,
    pub date: Option<String>,
    pub updated_by: String,
    pub updated_at: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CallsignBindOneReq {
    pub freq: String,
    pub comment: Option<String>,
    pub date: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CreateCallsignsBindReq {
    pub callsign_id: i64,
    pub bindings: Vec<CallsignBindOneReq>,
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
