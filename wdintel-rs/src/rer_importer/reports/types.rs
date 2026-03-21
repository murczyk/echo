use crate::rer_importer::InboxMessagesReq;
use chrono::NaiveDateTime;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::FromQueryResult;
use serde::{Deserialize, Serialize};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]

pub enum ReportAggregation {
    ByProfile,
    ByPost,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum ReportType {
    Tags,
    Interception,
    Babak,
    Mouse,
    Pelengs,
    Senders(SenderReportSettings),
    Naushnom,
    Reo(ReoReportSettings, ReoReportFileType),
    Digest,
    ActiveNetworks(ActiveNetworksReportSettings),
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ReportPreviewReq {
    /// `tags`, `mouse`
    pub kind: String,
    pub req: InboxMessagesReq,
    pub report_type: Option<ReportType>,
    pub report_tags_only_this_unit: Option<bool>,
    pub without_comments: Option<bool>,
    pub digest_omit_exo_id: Option<bool>,
    pub digest_form_1_2_17: Option<bool>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ReoReportSettings {
    pub adjacent_freqs_distance: f64,
    #[serde(default)]
    pub no_comments: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum ReoReportFileType {
    Docx,
    Xlsx,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SenderReportSettings {
    pub aggregation: ReportAggregation,
    #[serde(default)]
    pub advanced_freqs: bool,
}
#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ActiveNetworksReportSettings {
    pub aor_ids: Vec<i64>,
}

pub struct AreaOfResponsibilityNetworkComments {
    pub area_of_responsibility: AreaOfResponsibility,
    pub network_unit_comments: Vec<NetworkUnitComments>,
}

pub struct NetworkUnitComments {
    pub network: SigintNetwork,
    pub units: Vec<NetworkUnit>,
    pub comments: Vec<SigintComment>,
}

#[derive(Debug, Clone, FromQueryResult)]
pub struct AreaOfResponsibility {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, FromQueryResult)]
pub struct SigintNetwork {
    pub id: i64,
    pub name: String,
    pub active_from: Option<NaiveDateTime>,
}

#[derive(Debug, Clone, FromQueryResult)]
pub struct NetworkUnit {
    pub name: String,
}

#[derive(Debug, Clone, FromQueryResult)]
pub struct SigintComment {
    pub comment: String,
    pub created_at: NaiveDateTime,
}
