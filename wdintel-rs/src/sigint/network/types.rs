use crate::entities::sea_orm_active_enums::*;
use crate::sigint::etalonka::types::*;
use crate::sigint::key::EncryptionKeyData;
use chrono::NaiveDateTime;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::FromQueryResult;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, FromQueryResult)]
pub struct NetworkDetails {
    pub id: i64,
    pub name: String,
    pub location: String,
    pub radio_station: Option<String>,
    pub created_at: NaiveDateTime,
    pub purpose: Option<String>,
    pub operation_mode: Option<String>,
    pub operation_type: Option<String>,
    pub operation_period: Option<String>,
    pub updated_by: Option<String>,
    pub updated_at: NaiveDateTime,
    pub active_from: Option<NaiveDateTime>,
    pub active_to: Option<NaiveDateTime>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum NetworkStatus {
    NetworkActive,
    NetworkInactive,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum ListNetworksStatusFilter {
    ListNetworksActive,
    ListNetworksInactive,
    ListNetworksArchived,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListNetworksStatusCountsRsp {
    pub active: i64,
    pub inactive: i64,
    pub archived: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListNetworksRsp {
    pub list: Vec<Network>,
    pub status_counts: ListNetworksStatusCountsRsp,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Network {
    pub id: i64,
    pub freqs: Vec<NetworkFreq>,
    pub unit_ids: Option<Vec<i64>>,
    pub aor_ids: Vec<i64>,
    pub name: String,
    pub location: String,
    pub radio_station: Option<String>,
    pub created_at: i64,
    pub purpose: Option<String>,
    pub operation_mode: Option<String>,
    pub operation_type: Option<String>,
    pub operation_period: Option<String>,
    pub last_updated_at: i64,
    pub last_updated_by: Option<String>,
    pub active_from: Option<i64>,
    pub active_to: Option<i64>,
    pub post_ids: Vec<i64>,
    pub descriptions: Vec<NetworkDescription>,
    pub deleted: bool,
    pub do_not_archive: bool,
    pub status: NetworkStatus,
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
    pub freqs: Option<Vec<AddNetworkFreq>>,
    pub unit_ids: Option<Vec<i64>>,
    pub area_of_responsibility_ids: Option<Vec<i64>>,
    pub name: String,
    pub location: String,
    pub radio_station: Option<String>,
    pub purpose: Option<String>,
    pub operation_mode: Option<String>,
    pub operation_type: Option<String>,
    pub operation_period: Option<String>,
    pub post_ids: Vec<i64>,
    pub descriptions: Vec<AddNetworkDescription>,
    pub do_not_archive: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DeleteNetworkReq {
    pub network_id: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct RestoreNetworkReq {
    pub network_id: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UpdateNetworkReq {
    pub id: i64,
    // use a separate API to add/remove freqs, units, posts and descriptions
    // pub freqs: Option<Vec<String>>,
    // pub unit_ids: Vec<i64>,
    // pub post_ids: Vec<i64>,
    // pub descriptions: Vec<NetworkDescription>,
    pub restore_network: Option<bool>,
    pub area_of_responsibility_ids: Option<Vec<i64>>,
    pub name: String,
    pub location: String,
    pub radio_station: Option<String>,
    pub purpose: Option<String>,
    pub operation_mode: Option<String>,
    pub operation_type: Option<String>,
    pub operation_period: Option<String>,
    pub descriptions: Option<Vec<UpdateNetworkDescriptionReq>>,
    pub do_not_archive: bool,
    pub status: NetworkStatus,
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
    pub freq: String,
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
pub struct NetworkCallsignRelationsReq {
    pub network_id: i64,
    pub since_date_inclusive_ms: i64,
    pub till_date_noninclusive_ms: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetworkCallsignRelationMessagesReq {
    pub network_id: i64,
    pub since_date_inclusive_ms: i64,
    pub till_date_noninclusive_ms: i64,
    pub callsign: Option<String>,
    pub source: Option<String>,
    pub target: Option<String>,
    pub freqs: Vec<String>,
    pub limit: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetworkCallsignRelationMessage {
    pub id: i64,
    pub timestamp: Option<i64>,
    pub freq: Option<String>,
    pub text: String,
    pub callsigns: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetworkCallsignRelationMessagesRsp {
    pub messages: Vec<NetworkCallsignRelationMessage>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetworkCallsignRelationNode {
    pub id: String,
    pub label: String,
    pub weight: i64,
    pub relation_count: i64,
    pub activity_count: i64,
    pub main_radio_station: bool,
    pub command_control: bool,
    pub position: Option<String>,
    pub unit_name: Option<String>,
    pub known_callsign_id: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetworkCallsignRelationEdgeFreq {
    pub freq: String,
    pub weight: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetworkCallsignRelationEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    pub weight: i64,
    pub by_freq: Vec<NetworkCallsignRelationEdgeFreq>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetworkCallsignRelationFreq {
    pub freq: String,
    pub enabled_by_default: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetworkCallsignRelationsRsp {
    pub nodes: Vec<NetworkCallsignRelationNode>,
    pub edges: Vec<NetworkCallsignRelationEdge>,
    pub freqs: Vec<NetworkCallsignRelationFreq>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UpdFreqNetwork {
    pub id: Option<i64>,
    pub unit_ids: Vec<i64>,
    pub area_of_responsibility_ids: Option<Vec<i64>>,
    pub name: String,
    pub location: String,
    pub radio_station: Option<String>,
    pub confirmation: Option<String>,
    pub description: Option<UpdateNetworkDescriptionReq>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListNetworksReq {
    pub filter_freq: Option<String>,
    pub filter_unit: Option<String>,
    pub filter_unit_army: Option<String>,
    pub filter_unit_division: Option<String>,
    pub filter_unit_regiment: Option<String>,
    pub filter_unit_battalion: Option<String>,
    pub filter_text: Option<String>,
    pub filter_name: Option<String>,
    pub filter_location: Option<String>,
    /// show_only_further_inverstigation - to filter networks that does not have any unit assigned to them yet
    pub show_only_further_inverstigation: Option<bool>,
    pub show_inactive: Option<bool>,
    pub show_only_deleted: Option<bool>,
    pub status_filter: Option<ListNetworksStatusFilter>,
    /// Optional filter by Areas of Responsibility (AOR) IDs
    pub aor_ids: Option<Vec<i64>>,
    /// Optional list of network IDs to fetch
    pub ids: Option<Vec<i64>>,
    /// Optional limit, applied when no filters are provided
    pub limit: Option<i64>,
    /// Optional offset for pagination (0-based)
    pub offset: Option<i64>,
    pub sort_by: Option<Vec<ListNetworksSortBy>>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum ListNetworksSortBy {
    NameAsc,
    NameDesc,
    LastActivityAsc,
    LastActivityDesc,
    AorAsc,
    AorDesc,
    #[serde(rename = "FreqAsc")]
    NetworkFreqAsc,
    #[serde(rename = "FreqDesc")]
    NetworkFreqDesc,
    LocationAsc,
    LocationDesc,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AddNetworkFreqReq {
    pub network_id: i64,
    pub freq_rec: AddNetworkFreq,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct NetworkFreqMutationV2Rsp {
    pub network: Network,
    pub freq: Option<NetworkFreqsRes>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ReactivateNetworkFreqReq {
    pub network_id: i64,
    pub network_freq_id: i64,
}

/// You can either delete by setting explicit `id`, or set `network_id` and `freq` pair
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DeleteNetworkFreqReq {
    pub id: Option<i64>,
    pub network_id: Option<i64>,
    pub freq: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum SingleNetworkCallsignsSection {
    Everything,
    Catalog,
    Intercepted,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SingleNetworkCallsignsReq {
    pub network_id: i64,
    pub include_activity_info: Option<bool>,
    pub section: Option<SingleNetworkCallsignsSection>,
}
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SingleNetworkCallsignsListRsp {
    pub callsigns: Vec<NetworkCallsignRes>,
}

#[derive(
    Debug, Elm, ElmEncode, ElmDecode, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetworkCallsignRes {
    pub callsign: String,
    pub known_callsigns: Option<Vec<KnownCallsignShortRes>>,
    pub message_count: i64,
    pub last_datetime: Option<i64>,
    pub freqs: Option<Vec<String>>,
    pub network_names: Option<Vec<String>>,
    pub is_old: bool,
    pub is_in_dictionary: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SingleNetworkFreqsReq {
    pub network_id: i64,
    pub include_callsigns: Option<bool>,
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
pub struct NetworkFreqCallsignsReq {
    pub network_freq_id: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetworkFreqCallsignsRsp {
    pub network_freq_id: i64,
    pub callsigns: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetworkFreqCallsignsBatchReq {
    pub network_freq_ids: Vec<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetworkFreqCallsignsBatchRsp {
    pub callsigns_by_network_freq_id:
        std::collections::HashMap<String, Vec<String>>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct EncryptionRec {
    pub id: i32,
    pub name: String,
    pub enabled: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UpdateNetworkPostsReq {
    pub network_id: i64,
    pub post_ids: Vec<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum NetworkDescrType {
    Confirmation,
    Sign,
}

impl From<NetworkDescriptionType> for NetworkDescrType {
    fn from(db_enum: NetworkDescriptionType) -> Self {
        match db_enum {
            NetworkDescriptionType::Confirmation => {
                NetworkDescrType::Confirmation
            }
            NetworkDescriptionType::Sign => NetworkDescrType::Sign,
        }
    }
}

impl From<NetworkDescrType> for NetworkDescriptionType {
    fn from(db_enum: NetworkDescrType) -> Self {
        match db_enum {
            NetworkDescrType::Confirmation => {
                NetworkDescriptionType::Confirmation
            }
            NetworkDescrType::Sign => NetworkDescriptionType::Sign,
        }
    }
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetworkDescription {
    pub id: i64,
    pub network_id: i64,
    pub network_frequency_id: Option<i64>,
    pub descr_type: NetworkDescrType,
    pub topic: Option<String>,
    pub description: String,
    // pub comment: Option<String>,
    pub login: String,
    pub created_at: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AddNetworkDescription {
    pub descr_type: NetworkDescrType,
    pub topic: Option<String>,
    pub description: String,
    // pub comment: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AddNetworkFrequencyDescription {
    pub descr_type: NetworkDescrType,
    pub topic: Option<String>,
    pub description: String,
    pub freq: String,
    // pub comment: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AddNetworkDescriptionsReq {
    pub network_id: i64,
    pub network_descriptions: Vec<AddNetworkDescription>,
    pub frequency_descriptions: Vec<AddNetworkFrequencyDescription>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UpdateNetworkDescriptionReq {
    pub network_id: i64,
    pub network_freq_id: Option<i64>,
    pub description_id: i64,
    pub descr_type: NetworkDescrType,
    pub topic: Option<String>,
    pub description: String,
    // pub comment: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DeleteNetworkDescriptionReq {
    pub network_id: i64,
    pub description_id: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetworkFreq {
    pub id: i64,
    pub network_id: i64,
    pub freq: String,
    pub deleted: bool,
    pub active_from: i64,
    pub active_to: Option<i64>,
    pub created_at: i64,
    pub modulation: String,
    pub encryption_id: Option<i32>,
    pub encryption_keys: Vec<EncryptionKeyData>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AddNetworkFreq {
    pub freq: String,
    pub modulation: String,
    pub encryption_id: Option<i32>,
    pub encryption_key_ids: Vec<i64>,
    pub description: Option<AddNetworkFrequencyDescription>,
    pub active_from: Option<i64>,
    pub active_to: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UpdateNetworkFreqReq {
    pub network_id: i64,
    pub network_freq_id: i64,
    pub freq: String,
    pub modulation: String,
    pub encryption_id: Option<i32>,
    pub encryption_key_ids: Vec<i64>,
    pub active_from: i64,
    pub active_to: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
/// Параметри для оновлення списку підрозділів мережі
pub struct UpdateNetworkUnitsReq {
    /// відповідає `id` полю в [`crate::entities::sigint_network::Model::id`]
    pub network_id: i64,
    /// Список ітентифікаторів підрозділів мережі [`crate::entities::sigint_unit::Model`]
    pub unit_ids: Vec<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetworkFreqsActivityReq {
    pub network_id: i64,
}
