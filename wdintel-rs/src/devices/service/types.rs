use super::super::access::DeviceFieldGroups;
use crate::types::{BTreeMap, NaiveDateTime, Uuid};

#[derive(Debug, Default, PartialEq, Eq)]
pub(in crate::devices) enum DevicePatchField<T> {
    #[default]
    Missing,
    Value(T),
}

#[derive(Debug, PartialEq, Eq)]
pub(in crate::devices) struct CreateDeviceCommand {
    pub(in crate::devices) source_label: String,
    pub(in crate::devices) external_url: Option<String>,
    pub(in crate::devices) custom_fields: Option<BTreeMap<String, String>>,
}

#[derive(Debug, PartialEq, Eq)]
pub(in crate::devices) struct UpdateDeviceCommand {
    pub(in crate::devices) device_id: Uuid,
    pub(in crate::devices) source_label: DevicePatchField<String>,
    pub(in crate::devices) external_url: DevicePatchField<Option<String>>,
    pub(in crate::devices) custom_fields:
        DevicePatchField<BTreeMap<String, Option<String>>>,
    pub(in crate::devices) name: DevicePatchField<Option<String>>,
    pub(in crate::devices) aor_ids: DevicePatchField<Vec<i64>>,
    pub(in crate::devices) unit_id: DevicePatchField<Option<i64>>,
}

impl UpdateDeviceCommand {
    pub(in crate::devices) fn field_groups(&self) -> DeviceFieldGroups {
        DeviceFieldGroups {
            source_data: matches!(
                &self.source_label,
                DevicePatchField::Value(_)
            ) || matches!(
                &self.external_url,
                DevicePatchField::Value(_)
            ) || matches!(
                &self.custom_fields,
                DevicePatchField::Value(_)
            ),
            analytical_data: matches!(&self.name, DevicePatchField::Value(_))
                || matches!(&self.aor_ids, DevicePatchField::Value(_))
                || matches!(&self.unit_id, DevicePatchField::Value(_)),
        }
    }

    pub(in crate::devices) fn is_structurally_empty(&self) -> bool {
        matches!(&self.source_label, DevicePatchField::Missing)
            && matches!(&self.external_url, DevicePatchField::Missing)
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
    pub(in crate::devices) needs_analytical_name: Option<bool>,
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
    pub(in crate::devices) source_label: String,
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
