use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::de::Deserializer;
use serde::{Deserialize, Serialize};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Callsign {
    pub id: i64,
    pub callsign: String,
    pub position: String,
    pub comment: String,
    #[serde(default)]
    pub full_name: String,
    pub unit_id: i64,
    pub active: bool,
    pub source_id: Option<i32>,
    #[serde(default)]
    pub callsign_additional_sources: Vec<i64>,
    pub created_at: i64,
    pub developing: bool,
    /// Set when source_id points to "radio" (id=2)
    pub radio_freq: Option<String>,
}

#[derive(Elm, ElmEncode, ElmDecode, Debug, Serialize, PartialEq, Clone)]
pub struct UpdateCallsignReq {
    pub id: i64,
    pub callsign: String,
    pub position: String,
    pub comment: String,
    pub full_name: Option<String>,
    #[serde(skip)]
    pub full_name_is_missing: bool,
    pub unit_id: i64,
    pub active: bool,
    pub source_id: Option<i32>,
    #[serde(default)]
    pub callsign_additional_sources: Vec<i64>,
    pub created_at: i64,
    pub developing: bool,
    /// Set when source_id points to "radio" (id=2)
    pub radio_freq: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UpdateCallsignReqRaw {
    id: i64,
    callsign: String,
    position: String,
    comment: String,
    full_name: Option<String>,
    unit_id: i64,
    active: bool,
    source_id: Option<i32>,
    #[serde(default)]
    callsign_additional_sources: Vec<i64>,
    created_at: i64,
    developing: bool,
    radio_freq: Option<String>,
}

impl<'de> Deserialize<'de> for UpdateCallsignReq {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        let full_name_is_missing = value.get("full_name").is_none();
        let raw = UpdateCallsignReqRaw::deserialize(value)
            .map_err(serde::de::Error::custom)?;

        Ok(Self {
            id: raw.id,
            callsign: raw.callsign,
            position: raw.position,
            comment: raw.comment,
            full_name: raw.full_name,
            full_name_is_missing,
            unit_id: raw.unit_id,
            active: raw.active,
            source_id: raw.source_id,
            callsign_additional_sources: raw.callsign_additional_sources,
            created_at: raw.created_at,
            developing: raw.developing,
            radio_freq: raw.radio_freq,
        })
    }
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum ListCallsignsSortBy {
    CallsignAsc,
    CallsignDesc,
    CallsignPositionAsc,
    CallsignPositionDesc,
    CallsignFullNameAsc,
    CallsignFullNameDesc,
    CallsignCommentAsc,
    CallsignCommentDesc,
    CallsignSourceAsc,
    CallsignSourceDesc,
    CallsignRadioFreqAsc,
    CallsignRadioFreqDesc,
    CallsignCreatedAtAsc,
    CallsignCreatedAtDesc,
    CallsignUnitAsc,
    CallsignUnitDesc,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum DevelopingFilter {
    OnlyDeveloping,
    OnlyNonDeveloping,
    All,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListCallsignsReq {
    pub after_id: Option<i64>,
    pub before_id: Option<i64>,
    pub filter_text: Option<String>,
    pub filter_callsign: Option<String>,
    pub filter_position: Option<String>,
    pub filter_full_name: Option<String>,
    pub filter_comment: Option<String>,
    pub filter_unit: Option<String>,
    pub filter_unit_army_region: Option<String>,
    pub filter_unit_military_district: Option<String>,
    pub filter_unit_army: Option<String>,
    pub filter_unit_corps: Option<String>,
    pub filter_unit_division: Option<String>,
    pub filter_unit_brigade: Option<String>,
    pub filter_unit_regiment: Option<String>,
    pub filter_unit_battalion: Option<String>,
    pub filter_unit_company: Option<String>,
    pub filter_unit_platoon: Option<String>,
    pub filter_unit_squad: Option<String>,
    pub filter_unit_section: Option<String>,
    pub filter_unit_team_or_crew: Option<String>,
    pub filter_unit_other: Option<String>,
    pub filter_developing: Option<DevelopingFilter>,
    pub since_date_inclusive_ms: Option<i64>,
    pub till_date_inclusive_ms: Option<i64>,
    pub limit: Option<u64>,
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
    #[serde(default)]
    pub full_name: String,
    pub unit_id: i64,
    pub source_id: Option<i32>,
    #[serde(default)]
    pub callsign_additional_sources: Vec<i64>,
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
    pub position: Option<String>,
    pub comment: Option<String>,
    pub full_name: Option<String>,
    pub unit_id: Option<i64>,
    pub unit_name: Option<String>,
    pub source_id: Option<i64>,
    // pub source_name: Option<String>,
    /// Set when source_id points to "radio" (id=2)
    pub radio_freq: Option<String>,
    pub created_at: i64,
    pub active: bool,
    pub developing: bool,
    pub message_count: i64,
    pub last_datetime: Option<i64>,
    pub freqs: Option<Vec<String>>,
    pub unit_developing: bool,
    pub main_radio_station: bool,
    pub command_control: bool,
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
    pub period:
        Option<crate::sigint::network::types::NetworkFreqCallsignsPeriod>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListNetworkCallsignsRes {
    pub network_callsigns: Vec<NetworkCallsign>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CreateNetworkCallsignReq {
    pub network_id: i64,
    pub callsign: String,
    pub position: Option<String>,
    pub comment: Option<String>,
    pub full_name: Option<String>,
    pub source_id: Option<i64>,
    pub radio_freq: Option<String>,
    pub unit_id: Option<i64>,
    pub unit_developing: bool,
    pub developing: bool,
    pub main_radio_station: bool,
    pub command_control: bool,
}

#[derive(Elm, ElmEncode, ElmDecode, Debug, Serialize, PartialEq, Clone)]
pub struct UpdateNetworkCallsignReq {
    pub id: i64,
    pub network_id: i64,
    pub callsign: String,
    pub position: Option<String>,
    pub comment: Option<String>,
    pub full_name: Option<String>,
    #[serde(skip)]
    pub full_name_is_missing: bool,
    pub source_id: Option<i64>,
    pub radio_freq: Option<String>,
    pub unit_id: Option<i64>,
    pub unit_developing: bool,
    pub developing: bool,
    pub main_radio_station: bool,
    pub command_control: bool,
}

#[derive(Debug, Deserialize)]
struct UpdateNetworkCallsignReqRaw {
    id: i64,
    network_id: i64,
    callsign: String,
    position: Option<String>,
    comment: Option<String>,
    full_name: Option<String>,
    source_id: Option<i64>,
    radio_freq: Option<String>,
    unit_id: Option<i64>,
    unit_developing: bool,
    developing: bool,
    main_radio_station: bool,
    command_control: bool,
}

impl<'de> Deserialize<'de> for UpdateNetworkCallsignReq {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        let full_name_is_missing = value.get("full_name").is_none();
        let raw = UpdateNetworkCallsignReqRaw::deserialize(value)
            .map_err(serde::de::Error::custom)?;

        Ok(Self {
            id: raw.id,
            network_id: raw.network_id,
            callsign: raw.callsign,
            position: raw.position,
            comment: raw.comment,
            full_name: raw.full_name,
            full_name_is_missing,
            source_id: raw.source_id,
            radio_freq: raw.radio_freq,
            unit_id: raw.unit_id,
            unit_developing: raw.unit_developing,
            developing: raw.developing,
            main_radio_station: raw.main_radio_station,
            command_control: raw.command_control,
        })
    }
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AddAsKnownNetworkCallsignReq {
    pub network_id: i64,
    pub known_callsign_ids: Vec<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetworkCallsignsActivityReq {
    pub network_id: i64,
    pub callsigns: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetworkCallsignsActivityRsp {
    pub callsigns_activity: Vec<CallsignActivityRecord>,
}
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CallsignActivityRecord {
    pub callsign: String,
    pub activity: CallsignActivityItem,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CallsignActivityItem {
    pub message_count: i64,
    pub last_datetime: Option<i64>,
    pub freqs: Option<Vec<String>>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CallsignSearchReq {
    pub search: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CallsignSearchResult {
    pub id: i64,
    pub name: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CallsignSearchRsp {
    pub callsigns: Vec<CallsignSearchResult>,
}
