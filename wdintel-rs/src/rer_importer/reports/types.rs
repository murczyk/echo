use crate::rer_importer::InboxMessagesReq;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};

pub const NO_RANGE_VALUE: f64 = 0.0;
pub const SHORT_RANGE_VALUE: f64 = 0.0005;
pub const MEDIUM_RANGE_VALUE: f64 = 0.0020;
pub const LONG_RANGE_VALUE: f64 = 0.0050;

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Clone,
    Copy,
    Serialize,
    Deserialize,
    PartialEq,
)]
pub enum AdjacentFreqDistance {
    NoRange,
    ShortRange,
    MediumRange,
    LongRange,
}


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
    pub adjacent_freqs_distance: Option<AdjacentFreqDistance>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SenderReportSettings {
    pub aggregation: ReportAggregation,
}
