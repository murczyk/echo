use crate::location::SettlementDetails;
use crate::messenger::group::types::SignalGroupEntry;
use chrono::NaiveDateTime;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::FromQueryResult;
use serde::de;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use uuid::Uuid;

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct InboxMessageSummary {
    pub id: i64,
    #[serde(default)]
    pub is_accessible: bool,
    #[serde(default)]
    pub is_deleted: bool,
    pub text: String,
    #[serde(default)]
    pub attachments_count: i64,
    pub timestamp: Option<i64>,
    pub date: Option<String>,
    pub time: Option<String>,
    #[serde(default)]
    pub group_name: Option<String>,
    pub group_master_key: Option<String>,
    #[serde(default)]
    pub coords: Option<String>,
    #[serde(default)]
    pub media_file_names: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct InboxMessage {
    pub message_uuid: Option<String>,
    pub message_uid: Option<String>,
    pub text: String,
    pub media: Vec<MessageMediaInfo>,
    pub images: Vec<String>,
    pub image_recognized: Vec<String>,
    pub date: Option<String>,
    pub time: Option<String>,
    pub freq: Option<String>,
    pub coords: Option<String>,
    #[serde(default)]
    pub coords_with_locality: Vec<crate::location::CoordinateWithLocality>,
    pub callsigns: Vec<String>,
    pub callsigns_alg2: Vec<String>,
    pub checked: bool,
    pub important: bool,
    pub bookmarked: bool,
    pub timestamp: Option<i64>,
    pub group_master_key: Option<String>,
    pub sender: Option<String>,
    pub extended_form: Option<String>,
    #[serde(default)]
    pub message_comments: Vec<MessageComment>,
    pub post: Option<String>,
    pub post_id: Option<i64>,
    pub unit: Option<String>,
    #[serde(default)]
    pub unit_ids: Vec<i64>,
    /// overwritten upon save (ignored upon submission)
    pub callsign_tokens:
        Option<Vec<crate::rer_importer::highlight::CNCallsign>>,
    /// overwritten upon save (ignored upon submission)
    pub signal_tokens: Option<Vec<crate::rer_importer::signals::CNSignal>>,
    pub point_tokens: Option<Vec<crate::rer_importer::highlight::CNPoint>>,
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
    pub network_name: Option<String>,
    pub device_name: Option<String>,
    pub inbox_tags: Option<Vec<InboxMessageTag>>,
    pub metadata: Vec<InboxMessageMetadata>,
    #[serde(default)]
    pub parent_messages: Vec<InboxMessageSummary>,
    #[serde(default)]
    pub intelligence_reports: Vec<InboxMessageSummary>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Default,
    Serialize,
    Deserialize,
    PartialEq,
    Clone,
)]
pub struct InboxInsertPayload {
    pub text: String,
    #[serde(default)]
    pub media: Vec<MessageMediaInfo>,
    #[serde(default)]
    pub images: Vec<String>,
    #[serde(default)]
    pub image_recognized: Vec<String>,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub time: Option<String>,
    #[serde(default)]
    pub freq: Option<String>,
    #[serde(default)]
    pub coords: Option<String>,
    #[serde(default)]
    pub callsigns: Vec<String>,
    #[serde(default)]
    pub callsigns_alg2: Vec<String>,
    #[serde(default = "default_checked")]
    pub checked: bool,
    #[serde(default)]
    pub important: bool,
    #[serde(default)]
    pub bookmarked: bool,
    #[serde(default)]
    pub timestamp: Option<i64>,
    #[serde(default)]
    pub group_master_key: Option<String>,
    #[serde(default)]
    pub sender: Option<String>,
    #[serde(default)]
    pub extended_form: Option<String>,
    #[serde(default)]
    pub post: Option<String>,
    #[serde(default)]
    pub post_id: Option<i64>,
    #[serde(default)]
    pub unit: Option<String>,
    #[serde(default)]
    pub point_tokens: Option<Vec<crate::rer_importer::highlight::CNPoint>>,
    #[serde(default)]
    pub no_headers_body:
        Option<crate::rer_importer::body_noheader::NoHeadersBody>,
    #[serde(default)]
    pub datasource_id: Option<i64>,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<i64>>,
    #[serde(default)]
    pub network_ids: Option<Vec<i64>>,
    #[serde(default)]
    pub inbox_tags: Option<Vec<InboxMessageTag>>,
    #[serde(default)]
    pub metadata: Vec<InboxMessageMetadata>,
}

fn default_checked() -> bool {
    true
}

impl From<InboxInsertPayload> for InboxMessage {
    fn from(payload: InboxInsertPayload) -> Self {
        Self {
            message_uuid: None,
            message_uid: None,
            text: payload.text,
            media: payload.media,
            images: payload.images,
            image_recognized: payload.image_recognized,
            date: payload.date,
            time: payload.time,
            freq: payload.freq,
            coords: payload.coords,
            coords_with_locality: vec![],
            callsigns: payload.callsigns,
            callsigns_alg2: payload.callsigns_alg2,
            checked: payload.checked,
            important: payload.important,
            bookmarked: payload.bookmarked,
            timestamp: payload.timestamp,
            group_master_key: payload.group_master_key,
            sender: payload.sender,
            extended_form: payload.extended_form,
            message_comments: vec![],
            post: payload.post,
            post_id: payload.post_id,
            unit: payload.unit,
            unit_ids: vec![],
            callsign_tokens: None,
            signal_tokens: None,
            point_tokens: payload.point_tokens,
            no_headers_body: payload.no_headers_body,
            keyword_tokens: None,
            text_marked: None,
            datasource_id: payload.datasource_id,
            location: payload.location,
            tags: payload.tags,
            network_ids: payload.network_ids,
            network_name: None,
            device_name: None,
            inbox_tags: payload.inbox_tags,
            metadata: payload.metadata,
            parent_messages: vec![],
            intelligence_reports: vec![],
        }
    }
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
    #[serde(default)]
    pub transcription: Option<String>,
    #[serde(default)]
    pub ocr: Option<crate::ocr::types::OcrMediaSummary>,
    #[serde(default)]
    pub summary: Option<crate::media_summary::types::MediaSummaryStatus>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct InboxMessageTag {
    pub id: i64,
    pub tag_id: i64,
    pub confidence: f64,
    pub login: Option<String>,
    pub model: Option<String>,
    pub organism_id: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct InboxMessageMetadata {
    pub color_code: Option<String>,
    pub color_code_start_index: Option<i32>,
    pub color_code_end_index: Option<i32>,
    pub call_group_id: Option<String>,
    pub call_group_id_start_index: Option<i32>,
    pub call_group_id_end_index: Option<i32>,
    pub call_group_name: Option<String>,
    pub call_group_name_start_index: Option<i32>,
    pub call_group_name_end_index: Option<i32>,
    pub sender_id: Option<String>,
    pub sender_id_start_index: Option<i32>,
    pub sender_id_end_index: Option<i32>,
    pub sender_name: Option<String>,
    pub sender_name_start_index: Option<i32>,
    pub sender_name_end_index: Option<i32>,
    pub hash_id: Option<String>,
    pub hash_id_start_index: Option<i32>,
    pub hash_id_end_index: Option<i32>,
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
    pub show_settlements: Option<bool>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MapPointsRsp {
    pub network_units: Vec<NetworkUnit>,
    pub points: Vec<FreqDetailedPoint>,
    pub settlements: Vec<MapSettlement>,
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
pub struct MapSettlement {
    pub settlement_id: i32,
    pub name: String,
    pub region: Option<String>,
    pub lat: f64,
    pub lon: f64,
    pub inbox_item_count: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MapSettlementMessagesReq {
    pub settlement_id: i32,
    pub inbox_items_filter: InboxMessagesReq,
    pub before_id_noninclusive: Option<i64>,
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
    pub battle_line_distance: Option<i32>,
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
pub enum TagPresenceFilter {
    WithTags,
    WithoutTags,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MessageIdsReq {
    pub message_ids: Vec<i64>,
    pub inbox_req: Option<InboxMessagesReq>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct MessageUuidsReq {
    pub message_uuids: Vec<Uuid>,
    pub inbox_req: Option<InboxMessagesReq>,
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
    pub around_message_ref: Option<String>,
    pub since_date_inclusive_ms: Option<i64>,
    pub till_date_inclusive_ms: Option<i64>,
    pub only_show_unprocessed: Option<bool>,
    pub checked_only: Option<bool>,
    pub selected_groups: Option<Vec<String>>,
    pub denied_groups: Option<Vec<String>>,
    pub selected_senders: Option<Vec<String>>,
    pub denied_senders: Option<Vec<String>>,
    pub selected_freqs: Option<Vec<String>>,
    pub selected_posts: Option<Vec<String>>,
    pub denied_posts: Option<Vec<String>>,
    pub denied_freqs: Option<Vec<String>>,
    pub selected_callsigns: Option<Vec<String>>,
    pub selected_units: Option<Vec<String>>,
    pub denied_units: Option<Vec<String>>,
    #[serde(default)]
    pub selected_unit_ids: Option<Vec<i64>>,
    #[serde(default)]
    pub denied_unit_ids: Option<Vec<i64>>,
    pub selected_locations: Option<Vec<String>>,
    #[serde(default)]
    pub selected_device_names: Option<Vec<String>>,
    pub nolimit: Option<bool>,
    pub or_with_extended_form: Option<bool>,
    pub load_latest: Option<bool>,
    pub return_duplicates: Option<bool>,
    pub or_bookmarked: Option<bool>,
    pub or_important: Option<bool>,
    pub or_with_coords: Option<bool>,
    pub or_without_coords: Option<bool>,
    pub newest_first: Option<bool>,
    pub search: Option<String>,
    pub highlight_callsigns: Option<bool>,
    pub highlight_keywords: Option<bool>,
    pub highlight_searchres: Option<bool>,
    pub highlight_signals: Option<bool>,
    pub highlight_points: Option<bool>,
    pub highlight_keyword_set_id: Option<i64>,
    pub selected_tags: Option<Vec<i64>>,
    pub denied_tags: Option<Vec<i64>>,
    pub tag_presence: Option<TagPresenceFilter>,
    pub selected_aors: Option<Vec<i64>>,
    pub selected_networks: Option<Vec<i64>>,
    pub without_network: Option<bool>,
    pub metadata_cc: Option<Vec<String>>,
    pub metadata_sender: Option<Vec<String>>,
    pub metadata_receiver: Option<Vec<String>>,
    pub metadata_hash: Option<Vec<String>>,
    pub only_with_metadata: Option<bool>,
    pub without_metadata: Option<bool>,
    pub only_with_media: Option<bool>,
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
    pub without_model_tags: Option<bool>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct InboxItemContextReq {
    pub message_uid: String,
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
pub struct InboxItemContextRsp {
    pub message: Option<(i64, InboxMessage)>,
    pub group_master_keys: Vec<String>,
    pub sigint_inbox_item_ids: Vec<i64>,
    #[serde(rename = "sinceTs")]
    pub since_ts: Option<i64>,
    #[serde(rename = "tillTs")]
    pub till_ts: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct InboxWindowRsp {
    pub target_message_id: i64,
    pub inbox: InboxMessagesRsp,
    pub has_more_before: bool,
    pub has_more_after: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct InboxMessagesRsp {
    pub inbox_items: Vec<(i64, InboxMessage)>,
    pub poll_cursor_id: Option<i64>,
    pub callsigns: Vec<CallsignInfoRes>,
    pub signal_profiles: BTreeMap<String, Option<SignalProfileEntry>>,
    pub signal_groups: Vec<SignalGroupEntry>,
    pub freq_pelengs_summary: Option<Vec<FreqPelengsEntry>>,
    pub page_limit: Option<i64>,
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

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq, Clone)]
pub struct InboxSubmitWarning {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Default, Serialize, Deserialize, PartialEq, Eq, Clone)]
pub struct InboxSubmitRsp {
    pub messages: Vec<InboxSubmitMessageRsp>,
    pub warnings: Vec<InboxSubmitWarning>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq, Clone)]
pub struct InboxSubmitMessageRsp {
    pub message_id: String,
}

#[derive(Debug, Default, Serialize, Deserialize, PartialEq, Clone)]
pub struct GenericInboxSubmitRsp {
    pub warnings: Vec<InboxSubmitWarning>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
#[serde(deny_unknown_fields)]
pub struct InboxSubmitItem {
    #[serde(default)]
    pub full_body: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub comment: Option<String>,
    #[serde(default)]
    pub freq: Option<String>,
    #[serde(default)]
    pub coords: Vec<GeoCoordinates>,
    #[serde(default, rename = "from")]
    pub from_callsign: Option<String>,
    #[serde(default)]
    pub to: Vec<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(deserialize_with = "deserialize_rfc3339_string")]
    pub timestamp: String,
    #[serde(default)]
    pub sender: Option<String>,
    #[serde(default)]
    pub post: Option<String>,
    #[serde(default)]
    pub unit: Option<String>,
    #[serde(default)]
    pub locations: Vec<String>,
    #[serde(default)]
    pub group_names: Option<Vec<String>>,
    #[serde(default)]
    pub network: Option<SubmitNetwork>,
    #[serde(default)]
    pub dmr: Vec<SubmitDmrMetadata>,
    #[serde(skip, default = "default_parse_body_coordinates")]
    pub parse_body_coordinates: bool,
}

fn default_parse_body_coordinates() -> bool {
    true
}

impl Default for InboxSubmitItem {
    fn default() -> Self {
        Self {
            full_body: None,
            text: None,
            comment: None,
            freq: None,
            coords: vec![],
            from_callsign: None,
            to: vec![],
            tags: None,
            timestamp: "1970-01-01T00:00:00Z".to_string(),
            sender: None,
            post: None,
            unit: None,
            locations: vec![],
            group_names: None,
            network: None,
            dmr: vec![],
            parse_body_coordinates: true,
        }
    }
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(deny_unknown_fields)]
pub struct GeoCoordinates {
    pub lat: f64,
    pub lon: f64,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
#[serde(deny_unknown_fields)]
pub struct SubmitNetwork {
    #[serde(default)]
    pub signal_name: Option<String>,
    #[serde(default)]
    pub cc: Option<i32>,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
#[serde(deny_unknown_fields)]
pub struct SubmitDmrMetadata {
    #[serde(deserialize_with = "deserialize_rfc3339_string")]
    pub timestamp: String,
    #[serde(default)]
    pub cc: Option<i32>,
    pub freq: String,
    pub signal_name: String,
    #[serde(default)]
    pub sender_id: Option<i64>,
    #[serde(default)]
    pub sender_name: Option<String>,
    #[serde(default)]
    pub call_group_id: Option<i64>,
    #[serde(default)]
    pub call_group_name: Option<String>,
    #[serde(default)]
    pub hash_id: Option<String>,
}

fn deserialize_rfc3339_string<'de, D>(
    deserializer: D,
) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    chrono::DateTime::parse_from_rfc3339(&value).map_err(|_| {
        de::Error::custom(format!("timestamp must be RFC 3339: {value}"))
    })?;
    Ok(value)
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct InboxCommentSaveReq {
    pub message_id: i64,
    pub comment: Option<String>,
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
    pub skip_group_stats: Option<bool>,
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
    #[serde(default)]
    pub selected_unit_ids: Option<Vec<i64>>,
    pub selected_locations: Option<Vec<String>>,
    #[serde(default)]
    pub selected_device_names: Option<Vec<String>>,
    pub selected_aors: Option<Vec<i64>>,
    pub or_with_extended_form: Option<bool>,
    pub or_bookmarked: Option<bool>,
    pub or_important: Option<bool>,
    pub or_with_coords: Option<bool>,
    pub or_without_coords: Option<bool>,
    pub search: Option<String>,
    pub selected_tags: Option<Vec<i64>>,
    pub denied_tags: Option<Vec<i64>>,
    pub tag_presence: Option<TagPresenceFilter>,
    pub selected_networks: Option<Vec<i64>>,
    pub without_network: Option<bool>,
    pub metadata_cc: Option<Vec<String>>,
    pub metadata_sender: Option<Vec<String>>,
    pub metadata_receiver: Option<Vec<String>>,
    pub metadata_hash: Option<Vec<String>>,
    pub only_with_metadata: Option<bool>,
    pub without_metadata: Option<bool>,
    pub include_peleng_locations: Option<bool>,
    pub units_exact_match_only: Option<bool>,
    pub filter_tags_option: Option<TagFilterOption>,
    pub without_model_tags: Option<bool>,
    pub report_tags_only_this_unit: Option<bool>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AnalysisCallsignFrequencyMatchesReq {
    pub req: AnalysisStatsReq,
    pub callsigns: Vec<String>,
    pub min_matches: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AnalysisCallsignFrequencyMatch {
    pub freq: String,
    pub callsigns: Vec<String>,
    pub message_count: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AnalysisCallsignFrequencyMatchesRsp {
    pub frequencies: Vec<AnalysisCallsignFrequencyMatch>,
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
    #[serde(default)]
    pub selected_unit_ids: Option<Vec<i64>>,
    pub selected_locations: Option<Vec<String>>,
    #[serde(default)]
    pub selected_device_names: Option<Vec<String>>,
    pub or_with_extended_form: Option<bool>,
    pub or_bookmarked: Option<bool>,
    pub or_important: Option<bool>,
    pub or_with_coords: Option<bool>,
    pub or_without_coords: Option<bool>,
    pub nolimit: Option<bool>,
    pub search: Option<String>,
    pub selected_tags: Option<Vec<i64>>,
    pub denied_tags: Option<Vec<i64>>,
    pub tag_presence: Option<TagPresenceFilter>,
    pub selected_aors: Option<Vec<i64>>,
    pub selected_networks: Option<Vec<i64>>,
    pub without_network: Option<bool>,
    pub metadata_cc: Option<Vec<String>>,
    pub metadata_sender: Option<Vec<String>>,
    pub metadata_receiver: Option<Vec<String>>,
    pub metadata_hash: Option<Vec<String>>,
    pub only_with_metadata: Option<bool>,
    pub without_metadata: Option<bool>,
    pub include_peleng_locations: Option<bool>,
    pub units_exact_match_only: Option<bool>,
    pub filter_tags_option: Option<TagFilterOption>,
    pub without_model_tags: Option<bool>,
    pub report_tags_only_this_unit: Option<bool>,
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
pub struct SenderFrequencyBreakdown {
    pub freq: Option<String>,
    pub post: Option<String>,
    pub count: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AnalysisStatsSender {
    pub uuid: String,
    pub count: i64,
    pub freq_breakdown: Vec<SenderFrequencyBreakdown>,
    pub per_day: BTreeMap<String, i64>,
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
    pub unit_id: i64,
    pub name: String,
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
pub struct AnalysisStatsMetadataValue {
    pub value: String,
    pub count: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MetadataStatsRsp {
    pub ccs: Vec<AnalysisStatsMetadataValue>,
    pub senders: Vec<AnalysisStatsMetadataValue>,
    pub receivers: Vec<AnalysisStatsMetadataValue>,
    pub hashes: Vec<AnalysisStatsMetadataValue>,
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
    pub units_exact_matches_count: i64,
    pub units_non_exact_matches_count: i64,
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
    pub aors_selected: Vec<String>,
    pub groups_selected: Vec<String>,
    pub senders_selected: Vec<String>,
    pub freqs_selected: Vec<String>,
    pub callsigns_selected: Vec<String>,
    pub units_selected: Vec<String>,
    pub locations_selected: Vec<String>,
    pub posts_selected: Vec<String>,
    pub networks_selected: Vec<String>,
    pub without_network: bool,
    pub or_with_extended_form: bool,
    pub or_bookmarked: bool,
    pub or_important: bool,
    pub or_with_coords: bool,
    pub or_without_coords: bool,
    pub search: String,
    pub metadata_cc: Vec<String>,
    pub metadata_sender: Vec<String>,
    pub metadata_receiver: Vec<String>,
    pub metadata_hash: Vec<String>,
    pub only_with_metadata: bool,
    pub without_metadata: bool,
    pub tags: Vec<i64>,
    pub include_peleng_locations: bool,
    pub units_exact_match_only: Option<bool>,
    pub adjacent_freqs_range: f64,
    pub without_model_tags: bool,
    pub filter_tags_option: Option<TagFilterOption>,
    pub report_tags_only_this_unit: Option<bool>,
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
    pub report_tags_only_this_unit: Option<bool>,
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
    pub groups_denied: Option<Vec<String>>,
    pub senders_selected: Option<Vec<String>>,
    pub denied_senders: Option<Vec<String>>,
    pub freqs_selected: Option<Vec<String>>,
    pub freqs_denied: Option<Vec<String>>,
    pub posts_selected: Option<Vec<String>>,
    pub posts_denied: Option<Vec<String>>,
    pub units_selected: Option<Vec<String>>,
    pub units_denied: Option<Vec<String>>,
    #[serde(default)]
    pub selected_unit_ids: Option<Vec<i64>>,
    #[serde(default)]
    pub denied_unit_ids: Option<Vec<i64>>,
    pub units_exact_match_only: Option<bool>,
    pub last_viewed_message_id: Option<i64>,
    pub highlight_keywords_enabled: Option<bool>,
    pub highlight_keyword_set_id: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct RerDutyShortStateCreateReq {
    pub state: RerDutyQueryState,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct RerDutyShortStateCreateRsp {
    pub id: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct RerDutyShortStateGetReq {
    pub id: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct RerDutyShortStateGetRsp {
    pub state: RerDutyQueryState,
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
    pub network_hints: Vec<CallsignNetworkHint>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CallsignNetworkHint {
    pub id: i64,
    pub network_id: i64,
    pub position: String,
    pub formation: String,
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
    pub sigint_post_name: Option<String>,
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

pub struct CallsignNetworks {
    pub callsign: String,
    pub network_ids: Vec<i64>,
}

#[derive(FromQueryResult, Clone)]
pub struct PalitraLexeme {
    pub palitra_id: i64,
    pub palitra_point_id: i64,
    pub label: String,
    pub lexeme: String,
}

#[derive(Clone)]
pub struct PalitraPattern {
    pub palitra_id: i64,
    pub matcher: Arc<HashMap<String, Vec<PalitraLexeme>>>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeSet;

    #[test]
    fn inbox_insert_payload_matches_inbox_message_json_spec() {
        let payload = InboxInsertPayload {
            text: "test message".to_string(),
            media: vec![],
            images: vec!["image.jpg".to_string()],
            image_recognized: vec!["ocr text".to_string()],
            date: Some("25.06.2026".to_string()),
            time: Some("12:34:56".to_string()),
            freq: Some("145.0260".to_string()),
            coords: Some("49.12345, 37.12345".to_string()),
            callsigns: vec!["ярус".to_string(), "светлый".to_string()],
            callsigns_alg2: vec!["ярус".to_string()],
            checked: true,
            important: false,
            bookmarked: false,
            timestamp: Some(1_782_369_296_000),
            group_master_key: Some("SC1".to_string()),
            sender: Some("chumak".to_string()),
            extended_form: Some("Сигнали: dmr".to_string()),
            post: Some("SC1".to_string()),
            post_id: Some(7),
            unit: Some("УКХ р/м вБпЛА 121 мсп 68 мсд 6 А".to_string()),
            point_tokens: None,
            no_headers_body: None,
            datasource_id: None,
            location: Some("ЛИМАН ПЕРШИЙ".to_string()),
            tags: Some(vec![1, 2]),
            network_ids: Some(vec![11, 12]),
            inbox_tags: None,
            metadata: vec![],
        };

        let message = InboxMessage::from(payload.clone());
        let payload_json = serde_json::to_value(payload).unwrap();
        let message_json = serde_json::to_value(message).unwrap();
        let payload_fields = payload_json.as_object().unwrap();
        let message_fields = message_json.as_object().unwrap();

        for (field, value) in payload_fields {
            assert_eq!(
                message_fields.get(field),
                Some(value),
                "insert payload field {field} must match InboxMessage"
            );
        }

        let payload_keys =
            payload_fields.keys().cloned().collect::<BTreeSet<_>>();
        let message_keys =
            message_fields.keys().cloned().collect::<BTreeSet<_>>();
        let omitted_keys = message_keys
            .difference(&payload_keys)
            .cloned()
            .collect::<BTreeSet<_>>();
        let expected_omitted_keys = BTreeSet::from([
            "callsign_tokens".to_string(),
            "coords_with_locality".to_string(),
            "device_name".to_string(),
            "intelligence_reports".to_string(),
            "keyword_tokens".to_string(),
            "message_comments".to_string(),
            "message_uid".to_string(),
            "network_name".to_string(),
            "parent_messages".to_string(),
            "signal_tokens".to_string(),
            "text_marked".to_string(),
            "unit_ids".to_string(),
        ]);

        assert_eq!(omitted_keys, expected_omitted_keys);
    }

    #[test]
    fn inbox_submit_item_flattens_v11_payload_fields() {
        let item_json = json!({
            "text": "рос абонент ЯРУС викликав СВЕТЛЫЙ на 145.026",
            "freq": "145.0260",
            "coords": [{ "lat": 49.12345, "lon": 37.12345 }],
            "from": "ярус",
            "to": ["светлый"],
            "tags": ["БпЛА", "Втрати"],
            "timestamp": "2026-06-25T12:34:56Z",
            "full_body": "Повне повідомлення",
            "comment": "Сигнали: dmr",
            "locations": ["ЛИМАН ПЕРШИЙ", "КОПАНІ"],
            "group_names": ["SC1"],
            "network": {
                "signal_name": "dmr",
                "cc": 5,
                "name": "УКХ р/м управління 3 мсб 291 мсп 42 мсд 58 А"
            },
            "dmr": [{
                "timestamp": "2026-06-25T12:34:56Z",
                "cc": 5,
                "freq": "145.0260",
                "signal_name": "dmr",
                "sender_id": 2977001,
                "sender_name": "ЯРУС",
                "call_group_id": 2977002,
                "call_group_name": "СВЕТЛЫЙ",
                "hash_id": "2324d327"
            }]
        });

        let item: InboxSubmitItem = serde_json::from_value(item_json).unwrap();

        assert_eq!(
            item.text.as_deref(),
            Some("рос абонент ЯРУС викликав СВЕТЛЫЙ на 145.026")
        );
        assert_eq!(item.freq.as_deref(), Some("145.0260"));
        assert_eq!(
            item.tags,
            Some(vec!["БпЛА".to_string(), "Втрати".to_string()])
        );
        assert_eq!(item.from_callsign.as_deref(), Some("ярус"));
        assert_eq!(item.to, vec!["светлый".to_string()]);
        assert_eq!(
            item.coords,
            vec![GeoCoordinates {
                lat: 49.12345,
                lon: 37.12345,
            }]
        );
        assert_eq!(item.full_body.as_deref(), Some("Повне повідомлення"));
        assert_eq!(item.comment.as_deref(), Some("Сигнали: dmr"));
        assert_eq!(
            item.locations,
            vec!["ЛИМАН ПЕРШИЙ".to_string(), "КОПАНІ".to_string()]
        );
        assert_eq!(item.group_names, Some(vec!["SC1".to_string()]));
        assert_eq!(item.dmr[0].sender_id, Some(2_977_001));
        assert_eq!(item.dmr[0].call_group_id, Some(2_977_002));
        assert_eq!(item.dmr[0].sender_name.as_deref(), Some("ЯРУС"));
        assert_eq!(item.dmr[0].call_group_name.as_deref(), Some("СВЕТЛЫЙ"));

        let encoded = serde_json::to_value(item).unwrap();
        let encoded = encoded.as_object().unwrap();
        assert_eq!(
            encoded.get("text"),
            Some(&json!("рос абонент ЯРУС викликав СВЕТЛЫЙ на 145.026"))
        );
        assert!(encoded.get("message_uid").is_none());
        assert!(encoded.get("message_id").is_none());
        assert!(encoded.get("source").is_none());
        assert!(encoded.get("integration").is_none());
        assert!(encoded.get("location").is_none());
        assert!(encoded.get("callsigns").is_none());
        assert_eq!(encoded.get("from"), Some(&json!("ярус")));
        assert_eq!(encoded.get("to"), Some(&json!(["светлый"])));
        let dmr = encoded["dmr"].as_array().unwrap()[0].as_object().unwrap();
        assert_eq!(dmr.get("sender_id"), Some(&json!(2_977_001)));
        assert_eq!(dmr.get("call_group_id"), Some(&json!(2_977_002)));
    }

    #[test]
    fn inbox_submit_item_rejects_nested_batch_and_legacy_fields() {
        for field in [
            "message_id",
            "message",
            "payload",
            "existing_message_db_id",
            "messages",
            "checked",
            "extended_form",
            "date",
            "time",
            "media",
            "images",
            "image_recognized",
            "callsigns_alg2",
            "callsigns",
            "post_id",
            "source",
            "integration",
            "location",
        ] {
            let mut item = serde_json::Map::new();
            item.insert("text".to_string(), json!("рос абонент ЯРУС"));
            item.insert("timestamp".to_string(), json!("2026-06-25T12:34:56Z"));
            item.insert(field.to_string(), json!({ "text": "nested" }));

            assert!(
                serde_json::from_value::<InboxSubmitItem>(
                    serde_json::Value::Object(item)
                )
                .is_err(),
                "{field} must not be accepted in flattened submit shape"
            );
        }
    }

    #[test]
    fn inbox_submit_item_rejects_unknown_dmr_fields() {
        let result = serde_json::from_value::<InboxSubmitItem>(json!({
            "text": "рос абонент ЯРУС викликав СВЕТЛЫЙ",
            "timestamp": "2026-06-25T12:34:56Z",
            "dmr": [{
                "timestamp": "2026-06-25T12:34:56Z",
                "cc": 5,
                "freq": "145.0260",
                "signal_name": "dmr",
                "sender_id": 110,
                "abonent_id": 50
            }]
        }));

        assert!(result.is_err());
    }

    #[test]
    fn inbox_submit_item_accepts_network_without_signal_name() {
        let item = serde_json::from_value::<InboxSubmitItem>(json!({
            "text": "Повідомлення",
            "timestamp": "2026-06-25T12:34:56Z",
            "network": {
                "cc": 5,
                "name": "УКХ мережа"
            }
        }))
        .unwrap();

        assert_eq!(item.network.and_then(|network| network.signal_name), None);
    }

    #[test]
    fn inbox_submit_item_rejects_non_numeric_dmr_numbers() {
        let result = serde_json::from_value::<InboxSubmitItem>(json!({
            "text": "рос абонент ЯРУС викликав СВЕТЛЫЙ",
            "timestamp": "2026-06-25T12:34:56Z",
            "network": {
                "signal_name": "dmr",
                "cc": "НВ"
            }
        }));

        assert!(result.is_err());
    }

    #[test]
    fn inbox_submit_rsp_uses_message_id_and_warnings() {
        let rsp = InboxSubmitRsp {
            messages: vec![InboxSubmitMessageRsp {
                message_id: "msg-a1208-6734-2879".to_string(),
            }],
            warnings: vec![InboxSubmitWarning {
                code: "dmr_network_cc_conflict".to_string(),
                message: "using primary color code".to_string(),
            }],
        };

        let rsp = serde_json::to_value(rsp).unwrap();

        assert_eq!(
            rsp["messages"][0]["message_id"],
            json!("msg-a1208-6734-2879")
        );
        assert_eq!(
            rsp["warnings"][0]["code"],
            json!("dmr_network_cc_conflict")
        );
        assert!(rsp["messages"][0].get("message_uid").is_none());
    }

    #[test]
    fn generic_inbox_submit_rsp_uses_warnings() {
        let rsp = GenericInboxSubmitRsp {
            warnings: vec![InboxSubmitWarning {
                code: "dmr_network_cc_conflict".to_string(),
                message: "using primary color code".to_string(),
            }],
        };

        let rsp = serde_json::to_value(rsp).unwrap();

        assert!(rsp.get("message_uid").is_none());
        assert_eq!(
            rsp["warnings"][0]["code"],
            json!("dmr_network_cc_conflict")
        );
        assert!(rsp.get("message_id").is_none());
        assert!(rsp.get("messages").is_none());
    }

    #[test]
    fn inbox_submit_req_accepts_legacy_tuple_shape() {
        let message = InboxMessage::from(InboxInsertPayload {
            text: "legacy regular submit".to_string(),
            freq: Some("123.45".to_string()),
            callsigns: vec!["Alpha".to_string()],
            checked: true,
            ..Default::default()
        });

        let req: InboxSubmitReq = serde_json::from_value(json!({
            "messages": [[42, message]]
        }))
        .unwrap();

        assert_eq!(req.messages.len(), 1);
        assert_eq!(req.messages[0].0, 42);
        assert_eq!(req.messages[0].1.text, "legacy regular submit");
    }

    #[test]
    fn inbox_submit_item_accepts_flattened_single_generic_shape() {
        let req: InboxSubmitItem = serde_json::from_value(json!({
            "text": "рос абонент ЯРУС викликав СВЕТЛЫЙ",
            "freq": "145.0260",
            "from": "ярус",
            "to": ["светлый"],
            "timestamp": "2026-06-25T12:34:56Z",
            "group_names": ["SC1"],
            "network": {
                "signal_name": "dmr",
                "cc": 5,
                "name": "УКХ р/м управління 3 мсб 291 мсп 42 мсд 58 А"
            },
            "dmr": [{
                "timestamp": "2026-06-25T12:34:56Z",
                "cc": 5,
                "freq": "145.0260",
                "signal_name": "dmr",
                "sender_id": 110,
                "sender_name": "ЯРУС",
                "call_group_id": 50,
                "call_group_name": "СВЕТЛЫЙ"
            }]
        }))
        .unwrap();

        assert_eq!(
            req.text.as_deref(),
            Some("рос абонент ЯРУС викликав СВЕТЛЫЙ")
        );
        assert_eq!(req.from_callsign.as_deref(), Some("ярус"));
        assert_eq!(req.to, vec!["светлый".to_string()]);
        assert_eq!(req.group_names, Some(vec!["SC1".into()]));
        assert_eq!(req.dmr[0].sender_id, Some(110));
        assert_eq!(req.dmr[0].call_group_id, Some(50));
    }

    #[test]
    fn inbox_submit_item_rejects_non_rfc3339_timestamps() {
        for timestamp in
            [json!(1771404540000_i64), json!("2026-06-25T12:34:56")]
        {
            assert!(serde_json::from_value::<InboxSubmitItem>(json!({
                "text": "рос абонент ЯРУС",
                "timestamp": timestamp
            }))
            .is_err());
        }
    }
}
