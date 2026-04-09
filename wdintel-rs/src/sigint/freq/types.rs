use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::FromQueryResult;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Freq {
    pub locations: BTreeSet<String>,
    pub freq: String,
    pub message_count: i64,
    pub network_ids: Vec<i64>,
    pub created_at: Option<i64>,
    pub is_new: bool,
    pub last_updated_at: Option<i64>,
    pub last_updated_by: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct FreqV2 {
    pub locations: BTreeSet<String>,
    pub freq: String,
    pub message_count: i64,
    pub network_ids: Vec<i64>,
    pub created_at: Option<i64>,
    pub is_new: bool,
    pub last_updated_at: Option<i64>,
    pub last_updated_by: Option<String>,
    pub post_id: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListFreqsReq {
    pub since_date_inclusive_ms: i64,
    pub till_date_noninclusive_ms: i64,
    pub new_only: bool,
    pub include_non_active: bool,
    pub filter_freq: Option<String>,
    pub filter_unit: Option<String>,
    pub filter_callsigns: Option<Vec<String>>,
    pub sort_by: Option<Vec<ListFreqsSortBy>>,
    pub after_freq_nonincl: Option<String>,
    pub filter_group_master_keys: Option<Vec<String>>,
    pub filter_sender_profile_ids: Option<Vec<String>>,
    /// filter_further_investigation - to filter freqs that does not have any unit assigned to them yet
    pub filter_further_investigation: Option<bool>,
    pub filter_unknown_network: Option<bool>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct FreqStatsReq {
    pub since_date_inclusive_ms: i64,
    pub till_date_inclusive_ms: Option<i64>,
    pub freq: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum ListFreqsSortBy {
    FreqAsc,
    FreqDesc,
    MessageCountAsc,
    MessageCountDesc,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListFreqsRsp {
    pub show_load_more: bool,
    pub freqs: Vec<Freq>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListFreqsV2Rsp {
    pub show_load_more: bool,
    pub freqs: Vec<FreqV2>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct FreqUnitStatsRsp {
    pub units: Vec<FreqUnitStatRow>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct FreqUnitStatRow {
    pub unit_id: i64,
    pub count: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct FreqInfoBatchReq {
    pub freqs: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListAltUnitByFreqsReq {
    pub freqs: Vec<String>,
    pub since_date_inclusive_ms: i64,
    pub till_date_noninclusive_ms: i64,
    pub filter_group_master_keys: Option<Vec<String>>,
    pub filter_sender_profile_ids: Option<Vec<String>>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListPointsByFreqReq {
    pub freq: String,
    pub since_date_inclusive_ms: i64,
    pub till_date_noninclusive_ms: i64,
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
pub struct FreqPoint {
    pub lat: f64,
    pub lng: f64,
    pub body: String,
    pub id: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListPointsByFreqRsp {
    pub points: Vec<FreqPoint>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListCallsignsByFreqsReq {
    pub freqs: Vec<String>,
    pub since_date_inclusive_ms: i64,
    pub till_date_noninclusive_ms: i64,
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
pub struct FreqCallsignsMessage {
    pub freq: String,
    pub callsign: String,
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
pub struct FreqAltUnitMessageCount {
    pub freq: String,
    pub unit: String,
    pub count: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct FreqDailyGroupActivityCount {
    pub count_by_group_name: BTreeMap<String, i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct FreqDailyActivityCount {
    pub data_per_date: BTreeMap<String, FreqDailyGroupActivityCount>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListGroupsByFreqsPerDayReq {
    pub freqs: Vec<String>,
    pub since_date_inclusive_ms: i64,
    pub till_date_noninclusive_ms: i64,
}

pub struct CallsignStats {
    pub callsign: String,
    pub position: String,
    pub comment: String,
    pub last_update: i64,
    pub freqs: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CallsignsForFreqReq {
    pub freq: Option<String>,
    pub unit: Option<String>,
    pub since_date_inclusive_ms: i64,
    pub till_date_noninclusive_ms: i64,
    pub callsign: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CallsignsForFreqRsp {
    pub callsigns: Vec<FreqCallsign>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct FreqCallsign {
    pub callsign: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct FreqExistsReq {
    pub freq: String,
    pub since_date_inclusive_ms: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListFreqsForPeriodReq {
    pub since_date_inclusive_ms: i64,
    pub till_date_noninclusive_ms: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListFreqsForPeriodRsp {
    pub freqs: Vec<String>,
}

#[derive(FromQueryResult)]
pub struct FreqGroupsMessageCountByDay {
    pub freq: String,
    pub count: i64,
    pub group: String,
    pub day: i64,
}
