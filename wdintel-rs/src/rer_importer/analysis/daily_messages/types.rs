use super::{DailyMessageSenderKey, DailyMessageStatsReq};
use crate::sigint::unit::types::UnitHierarchyRsp;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::FromQueryResult;
use serde::{Deserialize, Serialize};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DailyMessageStatsCatalogReq {
    pub known_hierarchy_revision: Option<String>,
    pub selected_senders: Vec<DailyMessageSenderKey>,
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
pub struct DailyMessageStatsGroupLabel {
    pub key: String,
    pub label: String,
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
pub struct DailyMessageStatsSenderLabel {
    pub key: Option<String>,
    pub label: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DailyMessageStatsCatalogRsp {
    pub access_revision: String,
    pub groups: Vec<DailyMessageStatsGroupLabel>,
    pub unit_hierarchy: Option<UnitHierarchyRsp>,
    pub sender_labels: Vec<DailyMessageStatsSenderLabel>,
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
pub enum DailyMessageStatsFacet {
    #[serde(rename = "Groups")]
    DailyGroupsFacet,
    #[serde(rename = "Units")]
    DailyUnitsFacet,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DailyMessageStatsFacetReq {
    pub facet: DailyMessageStatsFacet,
    pub filter: DailyMessageStatsReq,
    pub include_children: bool,
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
pub struct DailyMessageStatsFacetCount {
    pub value: String,
    pub count: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DailyMessageStatsFacetRsp {
    pub counts: Vec<DailyMessageStatsFacetCount>,
    pub access_revision: String,
    pub hierarchy_revision: Option<String>,
    pub generated_at_ms: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DailyMessageStatsSendersReq {
    pub filter: DailyMessageStatsReq,
    pub search: Option<String>,
    pub cursor: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DailyMessageStatsSendersRsp {
    pub options: Vec<DailyMessageStatsSenderLabel>,
    pub next_cursor: Option<String>,
    pub total: i64,
    pub access_revision: String,
    pub generated_at_ms: i64,
}
