use super::common::{
    deserialize_canonical_uuid, AorSummary, NullablePatch, RequiredPatch,
    UnitSummary,
};
use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
    Copy,
)]
#[serde(rename_all = "snake_case")]
pub enum DeviceArchivedFilter {
    ActiveOnly,
    ArchivedOnly,
    #[serde(rename = "all")]
    AllDevices,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
    Copy,
)]
#[serde(rename_all = "snake_case")]
pub enum DeviceListSortBy {
    DisplayTitleAsc,
    DisplayTitleDesc,
    #[serde(rename = "created_at_asc")]
    DeviceCreatedAtAsc,
    #[serde(rename = "created_at_desc")]
    DeviceCreatedAtDesc,
    UpdatedAtAsc,
    UpdatedAtDesc,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct ListDevicesReq {
    pub filter_text: Option<String>,
    pub archived_filter: Option<DeviceArchivedFilter>,
    pub needs_analytical_name: Option<bool>,
    pub aor_ids: Option<Vec<i64>>,
    pub unit_ids: Option<Vec<i64>>,
    pub limit: Option<u64>,
    pub offset: Option<u64>,
    #[serde(default)]
    pub sort_by: Vec<DeviceListSortBy>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct DeviceStatusCounts {
    pub active: i64,
    pub archived: i64,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct DeviceListItem {
    pub id: String,
    pub source_label: String,
    pub name: Option<String>,
    pub aors: Vec<AorSummary>,
    pub unit: Option<UnitSummary>,
    pub created_by: String,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct ListDevicesRsp {
    pub list: Vec<DeviceListItem>,
    pub total: u64,
    pub has_more: bool,
    pub status_counts: DeviceStatusCounts,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct DeviceDetails {
    pub id: String,
    pub source_label: String,
    pub name: Option<String>,
    pub aors: Vec<AorSummary>,
    pub unit: Option<UnitSummary>,
    pub external_url: Option<String>,
    pub custom_fields: BTreeMap<String, String>,
    pub created_by: String,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct DeviceUnitStat {
    pub unit: UnitSummary,
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
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct DeviceUnitStatsRsp {
    pub units: Vec<DeviceUnitStat>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct DeviceDetailReq {
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub device_id: String,
    pub include_archived: Option<bool>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct CreateDeviceReq {
    pub source_label: String,
    pub external_url: Option<String>,
    #[serde(default, skip_serializing_if = "RequiredPatch::is_missing")]
    pub custom_fields: RequiredPatch<BTreeMap<String, String>>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Eq,
    Clone,
)]
#[serde(deny_unknown_fields)]
pub struct UpdateDeviceReq {
    #[serde(deserialize_with = "deserialize_canonical_uuid")]
    pub device_id: String,
    #[serde(default, skip_serializing_if = "RequiredPatch::is_missing")]
    pub source_label: RequiredPatch<String>,
    #[serde(default, skip_serializing_if = "NullablePatch::is_missing")]
    pub external_url: NullablePatch<String>,
    #[serde(default, skip_serializing_if = "RequiredPatch::is_missing")]
    pub custom_fields: RequiredPatch<BTreeMap<String, Option<String>>>,
    #[serde(default, skip_serializing_if = "NullablePatch::is_missing")]
    pub name: NullablePatch<String>,
    #[serde(default, skip_serializing_if = "RequiredPatch::is_missing")]
    pub aor_ids: RequiredPatch<Vec<i64>>,
    #[serde(default, skip_serializing_if = "NullablePatch::is_missing")]
    pub unit_id: NullablePatch<i64>,
}
