use crate::rer_importer::InboxMessagesReq;
use elm_rs::{Elm, ElmDecode, ElmEncode};
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
    Reo(ReoReportSettings),
    Digest,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ReportPreviewReq {
    /// `tags`, `mouse`
    pub kind: String,
    pub req: InboxMessagesReq,
    pub report_type: Option<ReportType>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ReoReportSettings {
    pub adjacent_freqs_distance: f64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SenderReportSettings {
    pub aggregation: ReportAggregation,
}
