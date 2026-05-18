use crate::sigint::network::types::{ListNetworksReq, ListNetworksSortBy};
use crate::sigint::signal::types::Signal;
use chrono::NaiveDateTime;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::FromQueryResult;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum EtalonkaReportType {
    AccordingToTheForm(EtalonkaSettings),
    ExtendedReport(EtalonkaExtendedSettings),
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct EtalonkaJimForksReq {
    pub req: ListNetworksReq,
    pub etalonka_type: EtalonkaReportType,
}

#[derive(
    Debug, Elm, ElmEncode, ElmDecode, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct EtalonkaNetworkBatchReq {
    pub network_ids: Vec<i64>,
    pub sort_by: Option<Vec<ListNetworksSortBy>>,
    pub etalonka_type: EtalonkaReportType,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct EtalonkaSettings {
    pub active_freqs_only: bool,
    pub include_sigint_signs: bool,
    pub include_confirmation: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct EtalonkaExtendedSettings {
    pub since_date_inclusive_ms: i64,
    pub till_date_inclusive_ms: Option<i64>,
    pub active_freqs_only: bool,
    pub include_unit_callsigns: bool,
    pub include_sigint_signs: bool,
    pub include_confirmation: bool,
    pub include_pelengs_map: bool,
}

#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct NetworkEtalonkaUnitKey {
    pub unit_army: Option<String>,
    pub unit_division: Option<String>,
    pub unit_regiment: Option<String>,
    pub unit_battalion: Option<String>,
    pub unit_company: Option<String>,
    pub unit_name: String,
}

#[derive(Debug, FromQueryResult)]
pub struct NetworkEtalonkaResult {
    pub id: i64,
    pub network_full_name: String,
    pub location: Option<String>,
    pub purpose: Option<String>,
    pub freqs: Option<String>,
    pub operation_mode: Option<String>,
    pub operation_type: Option<String>,
    pub operation_period: Option<String>,
    pub unit_name: Option<String>,
    pub unit_regiment: Option<String>,
    pub unit_battalion: Option<String>,
    pub unit_company: Option<String>,
    pub unit_division: Option<String>,
    pub unit_army: Option<String>,
    pub active_from: Option<NaiveDateTime>,
    pub active_to: Option<NaiveDateTime>,
}

#[derive(Debug)]
pub struct NetworkFreqFilter {
    pub active_freqs_only: bool,
    pub since_date_inclusive_ms: Option<i64>,
    pub till_date_inclusive_ms: Option<i64>,
}

#[derive(Debug, FromQueryResult, Default)]
pub struct FreqStatsRes {
    pub freq: String,
    pub name: String,
    pub unit: Option<String>,
    pub kind: Option<String>,
    pub kind_updated: Option<String>,
    pub location: Option<String>,
    pub radio_station: Option<String>,
    pub confirmation: Option<String>,
    pub first_time: Option<NaiveDateTime>,
    pub message_count: i64,
}

#[derive(
    Debug, Elm, ElmEncode, ElmDecode, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetworkFreqsRes {
    pub network_freq_id: i64,
    pub freq: String,
    pub signal_type: String,
    pub modulation_id: Option<i32>,
    pub modulation: Option<String>,
    pub encryption_key_ids: Vec<i64>,
    pub encryption_keys: Vec<String>,
    pub encryption_type: Option<String>,
    pub message_count: i64,
    pub callsigns: Option<Vec<String>>,
    pub last_datetime: Option<i64>,
    pub last_datetime_in_aor: Option<i64>,
    pub created_at: i64,
    pub is_active: bool,
    pub command_control: bool,
    pub active_from: i64,
    pub active_to: Option<i64>,
    pub kind: Option<String>,
}

#[derive(
    Debug, Elm, ElmEncode, ElmDecode, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CallsignRes {
    pub callsign: String,
    pub known_callsigns: Option<Vec<KnownCallsignShortRes>>,
    pub message_count: i64,
    pub last_datetime: Option<i64>,
    pub freqs: Option<Vec<String>>,
    pub network_names: Option<Vec<String>>,
    pub is_old: bool,
}

#[derive(
    Debug,
    Elm,
    ElmEncode,
    ElmDecode,
    Serialize,
    Deserialize,
    PartialEq,
    Clone,
    Eq,
)]
pub struct KnownCallsignShortRes {
    pub id: i64,
    pub callsign: String,
    pub position: String,
    pub comment: String,
    pub unit_id: i64,
    pub unit_name: String,
    pub source_name: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, FromQueryResult)]
pub struct KnownCallsignRes {
    pub id: i64,
    pub callsign: String,
    pub position: String,
    pub comment: String,
    pub unit_id: i64,
    pub unit_name: String,
    pub regiment: Option<String>,
    pub division: Option<String>,
    pub army: Option<String>,
    pub source_name: Option<String>,
    pub created_at: NaiveDateTime,
}

#[derive(Debug, Clone, FromQueryResult)]
pub struct CallsignQueryResult {
    pub callsign: String,
    pub unit_id: Option<i64>,
    pub unit_name: Option<String>,
    pub regiment: Option<String>,
    pub division: Option<String>,
    pub army: Option<String>,
}

#[derive(Debug, FromQueryResult)]
pub struct SignalRes {
    pub text: String,
    pub meaning: String,
}

#[derive(
    Debug, Elm, ElmEncode, ElmDecode, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetworkSignalsListReq {
    pub network_id: i64,
}

#[derive(
    Debug, Elm, ElmEncode, ElmDecode, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetworkSignalsListRes {
    pub signals: Vec<NetworkSignalsRes>,
}

#[derive(
    Debug, Elm, ElmEncode, ElmDecode, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetworkSignalsRes {
    pub network_id: i64,
    pub unit_id: i64,
    pub unit_name: String,
    pub signals: Vec<Signal>,
}

#[derive(Debug, FromQueryResult)]
pub struct UnregistredNetworksRes {
    pub freq: String,
    pub message_count: i64,
    pub callsigns: Option<String>,
    pub locations: Option<String>,
}

#[derive(Debug, FromQueryResult)]
pub struct NetworkPointQueryRes {
    pub id: i64,
    pub freq: String,
    pub lat: f64,
    pub lng: f64,
    pub body: String,
}

#[derive(Debug, Clone, FromQueryResult, PartialEq, Eq, PartialOrd, Ord)]
pub struct PelengsQueryRes {
    pub freq: String,
    pub lat: String,
    pub lng: String,
}

#[derive(Debug, Clone)]
pub struct EtalonkaFilter {
    pub since_date_inclusive_ms: Option<i64>,
    pub till_date_noninclusive_ms: Option<i64>,
    /// filter_further_investigation - to filter freqs that does not have any unit assigned to them yet
    pub filter_further_investigation: Option<bool>,
    pub network_id: i64,
}

#[derive(
    Debug, Elm, ElmEncode, ElmDecode, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct FreqActivityHistoryRec {
    pub id: i64,
    pub active_from: i64,
    pub active_to: Option<i64>,
}

impl Ord for KnownCallsignShortRes {
    fn cmp(&self, other: &Self) -> Ordering {
        self.callsign.cmp(&other.callsign)
    }
}

impl PartialOrd for KnownCallsignShortRes {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
