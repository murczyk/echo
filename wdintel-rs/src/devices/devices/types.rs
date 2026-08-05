use crate::devices::types::{
    deserialize_canonical_uuid, NullablePatch, RequiredPatch,
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
)]
#[serde(deny_unknown_fields)]
pub struct AorSummary {
    pub id: i64,
    pub name: String,
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
pub struct UnitSummary {
    pub id: i64,
    pub name: String,
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
    pub name: Option<String>,
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
    #[serde(default, skip_serializing_if = "NullablePatch::is_missing")]
    pub external_url: NullablePatch<String>,
    #[serde(default, skip_serializing_if = "RequiredPatch::is_missing")]
    pub custom_fields: RequiredPatch<BTreeMap<String, Option<String>>>,
    #[serde(default, skip_serializing_if = "RequiredPatch::is_missing")]
    pub name: RequiredPatch<String>,
    #[serde(default, skip_serializing_if = "RequiredPatch::is_missing")]
    pub aor_ids: RequiredPatch<Vec<i64>>,
    #[serde(default, skip_serializing_if = "NullablePatch::is_missing")]
    pub unit_id: NullablePatch<i64>,
}

mod domain {
    use crate::devices::access::DeviceFieldGroups;
    use crate::types::{BTreeMap, NaiveDateTime, Uuid};

    #[derive(Debug, Default, PartialEq, Eq)]
    pub(in crate::devices) enum DevicePatchField<T> {
        #[default]
        Missing,
        Value(T),
    }

    #[derive(Debug, PartialEq, Eq)]
    pub(in crate::devices) struct CreateDeviceCommand {
        pub(in crate::devices) name: Option<String>,
        pub(in crate::devices) external_url: Option<String>,
        pub(in crate::devices) custom_fields: Option<BTreeMap<String, String>>,
    }

    #[derive(Debug, PartialEq, Eq)]
    pub(in crate::devices) struct UpdateDeviceCommand {
        pub(in crate::devices) device_id: Uuid,
        pub(in crate::devices) external_url: DevicePatchField<Option<String>>,
        pub(in crate::devices) custom_fields:
            DevicePatchField<BTreeMap<String, Option<String>>>,
        pub(in crate::devices) name: DevicePatchField<String>,
        pub(in crate::devices) aor_ids: DevicePatchField<Vec<i64>>,
        pub(in crate::devices) unit_id: DevicePatchField<Option<i64>>,
    }

    impl UpdateDeviceCommand {
        pub(in crate::devices) fn field_groups(&self) -> DeviceFieldGroups {
            DeviceFieldGroups {
                source_data: matches!(
                    &self.external_url,
                    DevicePatchField::Value(_)
                ) || matches!(
                    &self.custom_fields,
                    DevicePatchField::Value(_)
                ),
                analytical_data: matches!(
                    &self.name,
                    DevicePatchField::Value(_)
                ) || matches!(
                    &self.aor_ids,
                    DevicePatchField::Value(_)
                ) || matches!(
                    &self.unit_id,
                    DevicePatchField::Value(_)
                ),
            }
        }

        pub(in crate::devices) fn is_structurally_empty(&self) -> bool {
            matches!(&self.external_url, DevicePatchField::Missing)
                && matches!(&self.name, DevicePatchField::Missing)
                && matches!(&self.aor_ids, DevicePatchField::Missing)
                && matches!(&self.unit_id, DevicePatchField::Missing)
                && match &self.custom_fields {
                    DevicePatchField::Missing => true,
                    DevicePatchField::Value(custom_fields) => {
                        custom_fields.is_empty()
                    }
                }
        }
    }
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(in crate::devices) enum DeviceArchivedScope {
        ActiveOnly,
        ArchivedOnly,
        All,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(in crate::devices) enum DeviceListSort {
        DisplayTitleAsc,
        DisplayTitleDesc,
        CreatedAtAsc,
        CreatedAtDesc,
        UpdatedAtAsc,
        UpdatedAtDesc,
    }

    #[derive(Debug, PartialEq, Eq)]
    pub(in crate::devices) struct ListDevicesCommand {
        pub(in crate::devices) filter_text: Option<String>,
        pub(in crate::devices) archived_scope: DeviceArchivedScope,
        pub(in crate::devices) aor_ids: Vec<i64>,
        pub(in crate::devices) unit_ids: Vec<i64>,
        pub(in crate::devices) limit: Option<u64>,
        pub(in crate::devices) offset: Option<u64>,
        pub(in crate::devices) sort_by: Vec<DeviceListSort>,
    }

    #[derive(Debug, PartialEq, Eq)]
    pub(in crate::devices) struct DeviceStatusCounts {
        pub(in crate::devices) active: i64,
        pub(in crate::devices) archived: i64,
    }

    #[derive(Debug, PartialEq, Eq)]
    pub(in crate::devices) struct ListDevicesResult {
        pub(in crate::devices) devices: Vec<DeviceCurrentState>,
        pub(in crate::devices) total: u64,
        pub(in crate::devices) has_more: bool,
        pub(in crate::devices) status_counts: DeviceStatusCounts,
    }

    #[derive(Debug, PartialEq, Eq)]
    pub(in crate::devices) struct DeviceUnitStat {
        pub(in crate::devices) unit: DeviceUnitReference,
        pub(in crate::devices) count: i64,
    }

    #[derive(Debug, PartialEq, Eq)]
    pub(in crate::devices) struct DeviceAorReference {
        pub(in crate::devices) id: i64,
        pub(in crate::devices) name: String,
    }

    #[derive(Debug, PartialEq, Eq)]
    pub(in crate::devices) struct DeviceUnitReference {
        pub(in crate::devices) id: i64,
        pub(in crate::devices) name: String,
    }

    #[derive(Debug, PartialEq, Eq)]
    pub(in crate::devices) struct DeviceCurrentState {
        pub(in crate::devices) id: Uuid,
        pub(in crate::devices) name: Option<String>,
        pub(in crate::devices) aors: Vec<DeviceAorReference>,
        pub(in crate::devices) unit: Option<DeviceUnitReference>,
        pub(in crate::devices) external_url: Option<String>,
        pub(in crate::devices) custom_fields: BTreeMap<String, String>,
        pub(in crate::devices) created_by: String,
        pub(in crate::devices) archived: bool,
        pub(in crate::devices) archived_at: Option<NaiveDateTime>,
        pub(in crate::devices) created_at: NaiveDateTime,
        pub(in crate::devices) updated_at: NaiveDateTime,
    }
}

pub(in crate::devices) use domain::{
    CreateDeviceCommand, DeviceAorReference, DeviceArchivedScope,
    DeviceCurrentState, DeviceListSort, DevicePatchField,
    DeviceStatusCounts as DomainDeviceStatusCounts, DeviceUnitReference,
    DeviceUnitStat as DomainDeviceUnitStat, ListDevicesCommand,
    ListDevicesResult, UpdateDeviceCommand,
};
