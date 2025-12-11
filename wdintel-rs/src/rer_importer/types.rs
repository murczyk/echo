use crate::location::SettlementDetails;
use crate::messenger::group::types::SignalGroupEntry;
use chrono::NaiveDateTime;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::FromQueryResult;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct InboxMessage {
    pub message_uid: Option<String>,
    pub text: String,
    pub media: Vec<MessageMediaInfo>,
    pub images: Vec<String>,
    pub image_recognized: Vec<String>,
    pub date: Option<String>,
    pub time: Option<String>,
    pub freq: Option<String>,
    pub coords: Option<String>,
    pub callsigns: Vec<String>,
    pub callsigns_alg2: Vec<String>,
    pub checked: bool,
    pub important: bool,
    pub bookmarked: bool,
    pub timestamp: Option<i64>,
    pub group_master_key: Option<String>,
    pub sender: Option<String>,
    pub extended_form: Option<String>,
    pub post: Option<String>,
    pub post_id: Option<i64>,
    pub unit: Option<String>,
    /// overwritten upon save (ignored upon submission)
    pub callsign_tokens:
        Option<Vec<crate::rer_importer::highlight::CNCallsign>>,
    /// overwritten upon save (ignored upon submission)
    pub signal_tokens: Option<Vec<crate::rer_importer::signals::CNSignal>>,

    pub no_headers_body:
        Option<crate::rer_importer::body_noheader::NoHeadersBody>,
    /// overwritten upon save (ignored upon submission)
    pub keyword_tokens:
        Option<Vec<crate::rer_importer::highlight::CNHighlight>>,
    /// generated on-the-fly
    pub text_marked: Option<Vec<crate::rer_importer::highlight::ContentNode>>,
    pub datasource_id: Option<i64>,
    pub location: Option<String>,
    pub tags: Option<Vec<i64>>,
    pub network_ids: Option<Vec<i64>>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessageMediaInfo {
    pub id: String,
    pub content_type: String,
    pub file_name: Option<String>,
    pub size_bytes: i64,
    pub href: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct InboxMapItem {
    pub id: i64,
    pub message_uid: Option<String>,
    pub freq: Option<String>,
    pub coords: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MapPointsReq {
    pub inbox_items_filter: InboxMessagesReq,
    pub map_filter: Option<MapPointsFilter>,
    pub page_id: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MapPointsRsp {
    pub network_units: Vec<NetworkUnit>,
    pub points: Vec<FreqDetailedPoint>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MapPointsFilter {
    pub network_units: Vec<NetworkUnit>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetworkUnit {
    pub name: String,
    pub frequencies: Vec<String>,
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
pub struct FreqDetailedPoint {
    pub message_id: i64,
    pub message_uid: Option<String>,
    pub id: i64,
    pub lat: f64,
    pub lng: f64,
    pub mgrs_coords: String,
    pub sk42_coords: String,
    pub freq: Option<String>,
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
    Copy,
)]
pub enum InboxMessagesSortBy {
    IMSDatetime,
    IMSTimestamp,
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
    Copy,
)]
pub enum TagFilterOption {
    OneOfTags,
    AllTags,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessageIdsReq {
    pub message_ids: Vec<i64>,
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
    Default,
)]
pub struct InboxMessagesReq {
    pub since_id_noninclusive: Option<i64>,
    pub before_id_noninclusive: Option<i64>,
    pub since_date_inclusive_ms: Option<i64>,
    pub till_date_inclusive_ms: Option<i64>,
    pub only_show_unprocessed: Option<bool>,
    pub checked_only: Option<bool>,
    pub selected_groups: Option<Vec<String>>,
    pub selected_senders: Option<Vec<String>>,
    pub denied_senders: Option<Vec<String>>,
    pub selected_freqs: Option<Vec<String>>,
    pub selected_posts: Option<Vec<String>>,
    pub denied_posts: Option<Vec<String>>,
    pub denied_freqs: Option<Vec<String>>,
    pub selected_callsigns: Option<Vec<String>>,
    pub selected_units: Option<Vec<String>>,
    pub selected_locations: Option<Vec<String>>,
    pub nolimit: Option<bool>,
    pub or_with_extended_form: Option<bool>,
    pub load_latest: Option<bool>,
    pub return_duplicates: Option<bool>,
    pub or_bookmarked: Option<bool>,
    pub or_important: Option<bool>,
    pub or_with_coords: Option<bool>,
    pub newest_first: Option<bool>,
    pub search: Option<String>,
    pub highlight_callsigns: Option<bool>,
    pub highlight_keywords: Option<bool>,
    pub highlight_searchres: Option<bool>,
    pub highlight_signals: Option<bool>,
    pub selected_tags: Option<Vec<i64>>,
    pub selected_aors: Option<Vec<i64>>,
    pub selected_networks: Option<Vec<i64>>,
    pub sort_by: Option<InboxMessagesSortBy>,
    /// report type "tags" specific param:
    pub report_tags_only_this_unit: Option<bool>,
    pub ignore_imported_coords: Option<bool>,
    pub include_peleng_locations: Option<bool>,
    /// Якщо вказано прапорець `units_exact_match_only`, то фільтрує ТІЛЬКИ по підрозділам, які вказані через прив'язку по Еталонці.
    /// інакше або по підрозділам, які було вказано в шапці повідомлення або по еталонній прив'язці
    pub units_exact_match_only: Option<bool>,
    pub calculate_freq_pelengs_summary: Option<bool>,
    pub skip_group_stats: Option<bool>,
    pub filter_tags_option: Option<TagFilterOption>,
    pub page_id: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct InboxMessagesRsp {
    pub inbox_items: Vec<(i64, InboxMessage)>,
    pub callsigns: Vec<CallsignInfoRes>,
    pub signal_profiles: BTreeMap<String, Option<SignalProfileEntry>>,
    pub signal_groups: Vec<SignalGroupEntry>,
    pub freq_pelengs_summary: Option<Vec<FreqPelengsEntry>>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessageIdsRsp {
    pub messages: Vec<(i64, InboxMessage)>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct InboxDeleteReq {
    pub id: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct InboxSubmitReq {
    pub messages: Vec<(i64, InboxMessage)>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct RerImporterCallsignsReq {
    pub filter: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CallsignWithFrequencies {
    pub callsign: String,
    pub frequencies: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CallsignsAlchemyNode {
    pub id: String,
    pub cluster: String,
    pub title: String,
    pub relatedness: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CallsignAlchemyEdge {
    pub source: String,
    pub target: String,
    pub relatedness: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CallsignsAlchemyRsp {
    pub nodes: Vec<CallsignsAlchemyNode>,
    pub edges: Vec<CallsignAlchemyEdge>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct InboxMessagesDigestRsp {
    pub quantity: i64,
    pub first_element_ts: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct InboxByGroupDigestRsp {
    pub stats_per_minute: Vec<InboxGroupStatsByMinute>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct InboxGroupStatsByMinute {
    pub timestamp: String,
    pub stats: BTreeMap<String, InboxGroupStats>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct InboxGroupStats {
    pub group_name: Option<String>,
    pub count: i32,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UpdateCursorReq {
    pub cursor: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UnreadCountersReq {
    pub last_id: i64,
    pub only_show_unprocessed: Option<bool>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UnreadCountersRsp {
    pub newer_msg_count: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SignalGroupReq {
    pub master_key: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct BatchSignalGroupReq {
    pub groups: Vec<SignalGroupReq>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SignalGroupRsp {
    pub name: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SignalGroupsRsp {
    pub data: Vec<SignalGroupEntry>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SignalProfileReq {
    pub uuid: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct BatchSignalProfileReq {
    pub profiles: Vec<SignalProfileReq>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SignalProfileRsp {
    pub given_name: Option<String>,
    pub family_name: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SignalProfileEntry {
    pub given_name: Option<String>,
    pub family_name: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SignalProfilesRsp {
    pub data: BTreeMap<String, Option<SignalProfileEntry>>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SignalProfileSaveReq {
    pub uuid: String,
    pub given_name: Option<String>,
    pub family_name: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AnalysisStatsReq {
    pub since_date_inclusive_ms: i64,
    pub till_date_noninclusive_ms: i64,
    pub selected_groups: Option<Vec<String>>,
    pub selected_senders: Option<Vec<String>>,
    pub selected_freqs: Option<Vec<String>>,
    pub selected_posts: Option<Vec<String>>,
    pub selected_callsigns: Option<Vec<String>>,
    pub selected_units: Option<Vec<String>>,
    pub selected_locations: Option<Vec<String>>,
    pub selected_aors: Option<Vec<i64>>,
    pub or_with_extended_form: Option<bool>,
    pub or_bookmarked: Option<bool>,
    pub or_important: Option<bool>,
    pub or_with_coords: Option<bool>,
    pub search: Option<String>,
    pub selected_tags: Option<Vec<i64>>,
    pub selected_networks: Option<Vec<i64>>,
    pub include_peleng_locations: Option<bool>,
    pub units_exact_match_only: Option<bool>,
    pub filter_tags_option: Option<TagFilterOption>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CallsignsGraphReq {
    pub since_date_inclusive_ms: i64,
    pub till_date_noninclusive_ms: i64,
    pub selected_groups: Option<Vec<String>>,
    pub selected_senders: Option<Vec<String>>,
    pub selected_freqs: Option<Vec<String>>,
    pub selected_posts: Option<Vec<String>>,
    pub selected_callsigns: Option<Vec<String>>,
    pub selected_units: Option<Vec<String>>,
    pub selected_locations: Option<Vec<String>>,
    pub or_with_extended_form: Option<bool>,
    pub or_bookmarked: Option<bool>,
    pub or_important: Option<bool>,
    pub or_with_coords: Option<bool>,
    pub nolimit: Option<bool>,
    pub search: Option<String>,
    pub selected_tags: Option<Vec<i64>>,
    pub selected_aors: Option<Vec<i64>>,
    pub selected_networks: Option<Vec<i64>>,
    pub include_peleng_locations: Option<bool>,
    pub units_exact_match_only: Option<bool>,
    pub filter_tags_option: Option<TagFilterOption>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AnalysisStatsGroup {
    pub master_key: String,
    pub count: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AnalysisStatsSender {
    pub uuid: String,
    pub count: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AnalysisStatsFreqCallsign {
    pub callsign: String,
    pub num_messages: i64,
    // pub corresponded_with: Vec<String>,
    /// color like "#ff00ff"
    pub highlight_css_color: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AnalysisStatsFreq {
    pub freq: String,
    pub count: i64,
    pub is_new: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AnalysisStatsPost {
    pub post: String,
    pub count: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AnalysisStatsCallsign {
    pub callsign: String,
    pub count: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AnalysisStatsUnit {
    pub unit: String,
    pub count: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AnalysisStatsLocation {
    pub location: String,
    pub count: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AnalysisStatsTag {
    pub tag_id: i64,
    pub count: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AnalysisStatsNetwork {
    pub network_id: i64,
    pub count: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct GroupStatsRsp {
    pub groups: Vec<AnalysisStatsGroup>,
    pub group_names: Vec<SignalGroupEntry>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SenderStatsRsp {
    pub senders: Vec<AnalysisStatsSender>,
    pub sender_names: BTreeMap<String, Option<SignalProfileRsp>>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct FreqStatsRsp {
    pub freqs: Vec<AnalysisStatsFreq>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct PostStatsRsp {
    pub posts: Vec<AnalysisStatsPost>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CallsignStatsRsp {
    pub callsigns: Vec<AnalysisStatsCallsign>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UnitStatsRsp {
    pub units: Vec<AnalysisStatsUnit>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct LocationStatsRsp {
    pub locations: Vec<AnalysisStatsLocation>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct TagStatsRsp {
    pub tags: Vec<AnalysisStatsTag>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AreaOfResponsibilityEntry {
    pub id: i64,
    pub name: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AnalysisStatsAor {
    pub aor_id: i64,
    pub count: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AreaOfResponsibilityStatsRsp {
    pub aors: Vec<AnalysisStatsAor>,
    pub aor_names: Vec<AreaOfResponsibilityEntry>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetworkStatsRsp {
    pub networks: Vec<AnalysisStatsNetwork>,
    pub network_names: Vec<NetworkEntry>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetworkEntry {
    pub id: i64,
    pub name: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CountStatsRsp {
    pub count_overall: i64,
    pub count_selected: i64,
    pub groups_count: i64,
    pub senders_count: i64,
    pub freqs_count: i64,
    pub posts_count: i64,
    pub callsigns_count: i64,
    pub units_count: i64,
    pub locations_count: i64,
    pub tags_count: i64,
    pub aors_count: i64,
    pub networks_count: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AnalysisStatsRsp {
    pub count_overall: i64,
    pub count_selected: i64,
    pub groups: Vec<AnalysisStatsGroup>,
    pub senders: Vec<AnalysisStatsSender>,
    pub freqs: Vec<AnalysisStatsFreq>,
    pub posts: Vec<AnalysisStatsPost>,
    pub callsigns: Vec<AnalysisStatsCallsign>,
    pub units: Vec<AnalysisStatsUnit>,
    pub locations: Vec<AnalysisStatsLocation>,
    pub tags: Vec<AnalysisStatsTag>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct D3GraphNodeProperties {
    pub label: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetJSONNodeProperties {
    pub freqs: Option<Vec<String>>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetJSONNode {
    pub id: String,
    pub name: String,
    pub count: i64,
    pub properties: Option<NetJSONNodeProperties>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetJSONLinkProperties {
    pub freq: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetJSONLink {
    pub source: String,
    pub target: String,
    pub cost: f64,
    pub category: Option<String>,
    pub properties: Option<NetJSONLinkProperties>,
}

/// See [neo4jd3](https://github.com/eisman/neo4jd3)
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetJSONGraph {
    #[serde(rename = "type")]
    pub type_: String,
    pub date: String,
    pub nodes: Vec<NetJSONNode>,
    pub links: Vec<NetJSONLink>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetJSONLinkCategoryLinkStyle {
    pub color: Option<String>,
    pub opacity: Option<f64>,
    pub width: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetJSONLinkCategory {
    pub name: String,
    #[serde(rename = "linkStyle")]
    pub link_style: NetJSONLinkCategoryLinkStyle,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NetJSONGraphAndMeta {
    pub graph: NetJSONGraph,
    #[serde(rename = "linkCategories")]
    pub link_categories: Option<Vec<NetJSONLinkCategory>>,
    pub overall_count: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct LatLng {
    pub lat: f64,
    pub lng: f64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct LocalityCoords {
    pub locality: String,
    pub count: i64,
    pub coords: Vec<LatLng>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SummaryTableFreqRow {
    pub freq: String,
    pub count: i64,
    pub callsigns: Vec<String>,
    pub units: Vec<String>,
    pub locations: Vec<String>,
    pub coords: Vec<LatLng>,
    pub locality_coords: Vec<LocalityCoords>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SummaryTableFreq {
    pub rows: Vec<SummaryTableFreqRow>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CorrelatedFreq {
    pub freq: String,
    pub common_callsigns: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CorrelatedFreqsRsp {
    pub freqs: Vec<CorrelatedFreq>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct RerAnalysisQueryState {
    pub date_from_str: String,
    pub time_from_str: String,
    pub date_to_str: String,
    pub time_to_str: String,
    pub groups_selected: Vec<String>,
    pub senders_selected: Vec<String>,
    pub freqs_selected: Vec<String>,
    pub callsigns_selected: Vec<String>,
    pub units_selected: Vec<String>,
    pub locations_selected: Vec<String>,
    pub or_with_extended_form: bool,
    pub or_bookmarked: bool,
    pub or_important: bool,
    pub or_with_coords: bool,
    pub search: String,
    pub tags: Vec<i64>,
    pub include_peleng_locations: bool,
    pub units_exact_match_only: bool,
    pub adjacent_freqs_range: f64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct EditFreqUnitNameReq {
    pub analysis_stats_req: AnalysisStatsReq,
    pub freq: String,
    pub unit: String,
    pub unit_new: String,
    pub search: Option<String>,
    pub filter_tags_option: Option<TagFilterOption>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SavedFilter {
    pub id: i64,
    pub name: String,
    pub req: AnalysisStatsReq,
}
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SavedFilterDuty {
    pub id: i64,
    pub name: String,
    pub req: RerDutyQueryStateWf,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SavedFilterUpsertReq {
    pub name: String,
    pub req: AnalysisStatsReq,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SavedFilterDutyUpsertReq {
    pub name: String,
    pub req: RerDutyQueryStateWf,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SavedFilterRenameReq {
    pub id: i64,
    pub name: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct RerDutyQueryState {
    pub waterfalls: Option<Vec<(String, RerDutyQueryStateWf)>>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct RerDutyQueryStateWf {
    pub groups_selected: Option<Vec<String>>,
    pub senders_selected: Option<Vec<String>>,
    pub denied_senders: Option<Vec<String>>,
    pub freqs_selected: Option<Vec<String>>,
    pub freqs_denied: Option<Vec<String>>,
    pub posts_selected: Option<Vec<String>>,
    pub posts_denied: Option<Vec<String>>,
    pub last_viewed_message_id: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct NewCallsignsRes {
    pub not_seen_24h: Vec<String>,
    pub not_seen_7days: Vec<String>,
    pub not_seen_30days: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct RerCallsignInfoReq {
    pub callsign: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct RerCallsignInfoBatchReq {
    pub callsigns: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CallsignInfo {
    pub id: i64,
    pub callsign: String,
    pub position: String,
    pub comment: String,
    pub unit_1: String,
    pub unit_2: String,
    /// will always be filled for in-system callsigns, but not GDocs-based sheet
    pub unit_id: Option<i64>,
    /// which networks IDs the callsign is present in
    pub network_ids_reported_in: Vec<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CallsignInfoRes {
    pub callsign: String,
    pub res: Vec<CallsignInfo>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessageCommentsReq {
    pub message_id: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct BatchMessageCommentsReq {
    pub messages: Vec<MessageCommentsReq>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DraftCommentEvent {
    pub id: String,
    pub message_id: i64,
    pub value: String,
    pub created_at_ms: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DraftCommentEventsReq {
    pub events: Vec<DraftCommentEvent>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessageComments {
    pub data: Vec<MessageCommentEntry>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessageCommentEntry {
    pub message_id: i64,
    pub comments: Vec<MessageComment>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessageComment {
    pub id: i64,
    pub message_id: i64,
    pub comment: String,
    pub login: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct UnitAndLoc {
    pub unit: Option<String>,
    pub locality: Option<String>,
    pub locality_v2: Option<Vec<SettlementDetails>>,
}

#[derive(Debug, Deserialize, PartialEq, Clone)]
pub struct MessagesReq {
    pub freq: Option<String>,
    #[serde(deserialize_with = "crate::utils::grafana::deserialize_datetime")]
    pub from: Option<NaiveDateTime>,
    #[serde(deserialize_with = "crate::utils::grafana::deserialize_datetime")]
    pub to: Option<NaiveDateTime>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone, FromQueryResult)]
pub struct MessageRsp {
    pub id: i64,
    pub timestamp: NaiveDateTime,
    pub lat: f64,
    pub lng: f64,
    pub coordinates: String,
    pub freq: String,
    pub body: String,
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
pub struct FreqPelengsEntry {
    pub freq: String,
    pub pelengs_count: i64,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone, FromQueryResult)]
pub struct MessageTimestampPerGroupStat {
    pub group_master_key: String,
    pub timestamp: NaiveDateTime,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct FreqPelengsActivityRsp {
    pub freq_pelengs_summary: Vec<FreqPelengsEntry>,
}
