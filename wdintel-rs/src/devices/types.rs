use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::de::Error as DeError;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::BTreeMap;

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DeviceTag {
    pub label: String,
    pub value: String,
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
pub enum DeviceArchivedFilter {
    #[serde(rename = "active_only")]
    DeviceActiveOnly,
    #[serde(rename = "archived_only")]
    DeviceArchivedOnly,
    #[serde(rename = "all")]
    DeviceAll,
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
pub enum DeviceListSortBy {
    #[serde(rename = "name_asc")]
    DeviceNameAsc,
    #[serde(rename = "name_desc")]
    DeviceNameDesc,
    #[serde(rename = "updated_at_asc")]
    DeviceUpdatedAtAsc,
    #[serde(rename = "updated_at_desc")]
    DeviceUpdatedAtDesc,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DeviceListItem {
    pub id: String,
    pub source_label: String,
    pub name: String,
    pub created_by: String,
    pub aor_ids: Vec<i64>,
    pub aor_names: Vec<String>,
    pub unit_id: Option<i64>,
    pub unit_name: Option<String>,
    pub external_url: Option<String>,
    pub custom_fields: BTreeMap<String, String>,
    pub archived: bool,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub archived_at_ms: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DeviceDetails {
    pub id: String,
    pub source_label: String,
    pub name: String,
    pub created_by: String,
    pub aor_ids: Vec<i64>,
    pub aor_names: Vec<String>,
    pub unit_id: Option<i64>,
    pub unit_name: Option<String>,
    pub tags: Vec<DeviceTag>,
    pub external_url: Option<String>,
    pub custom_fields: BTreeMap<String, String>,
    pub archived: bool,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub archived_at_ms: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListDevicesReq {
    pub filter_text: Option<String>,
    pub archived_filter: Option<DeviceArchivedFilter>,
    pub aor_ids: Option<Vec<i64>>,
    pub unit_ids: Option<Vec<i64>>,
    pub created_by: Option<String>,
    pub ids: Option<Vec<String>>,
    pub limit: Option<u64>,
    pub offset: Option<u64>,
    #[serde(default)]
    pub sort_by: Vec<DeviceListSortBy>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DeviceStatusCountsRsp {
    pub active: i64,
    pub archived: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListDevicesRsp {
    pub list: Vec<DeviceListItem>,
    pub total: u64,
    pub has_more: bool,
    pub status_counts: DeviceStatusCountsRsp,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DeviceUnitStatsRsp {
    pub units: Vec<DeviceUnitStatRow>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DeviceUnitStatRow {
    pub unit_id: i64,
    pub count: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DeviceDetailReq {
    pub device_id: String,
    pub include_archived: Option<bool>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(deny_unknown_fields)]
pub struct CreateDeviceReq {
    pub source_label: String,
    pub name: String,
    #[serde(default)]
    pub aor_ids: Vec<i64>,
    pub unit_id: Option<i64>,
    #[serde(default)]
    pub tags: Vec<DeviceTag>,
    pub external_url: Option<String>,
    #[serde(default)]
    pub custom_fields: BTreeMap<String, String>,
}

#[derive(Debug, PartialEq, Clone, Default)]
pub enum DeviceUpdateRequiredField<T> {
    #[default]
    Missing,
    Value(T),
}

impl<T> DeviceUpdateRequiredField<T> {
    pub fn is_missing(&self) -> bool {
        matches!(self, Self::Missing)
    }
}

impl<T> Elm for DeviceUpdateRequiredField<T>
where
    T: Elm,
{
    fn elm_type() -> String {
        format!("Maybe ({})", T::elm_type())
    }

    fn elm_definition() -> Option<String> {
        None
    }
}

impl<T> ElmEncode for DeviceUpdateRequiredField<T>
where
    T: Elm + ElmEncode,
{
    fn encoder_type() -> String {
        format!(
            "Maybe.withDefault Json.Encode.null << Maybe.map ({})",
            T::encoder_type()
        )
    }

    fn encoder_definition() -> Option<String> {
        None
    }
}

impl<T> ElmDecode for DeviceUpdateRequiredField<T>
where
    T: Elm + ElmDecode,
{
    fn decoder_type() -> String {
        format!("Json.Decode.nullable ({})", T::decoder_type())
    }

    fn decoder_definition() -> Option<String> {
        None
    }
}

impl<T> Serialize for DeviceUpdateRequiredField<T>
where
    T: Serialize,
{
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Missing => serializer.serialize_none(),
            Self::Value(value) => value.serialize(serializer),
        }
    }
}

impl<'de, T> Deserialize<'de> for DeviceUpdateRequiredField<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Option::<T>::deserialize(deserializer)?
            .map(Self::Value)
            .ok_or_else(|| D::Error::custom("field cannot be null"))
    }
}

#[derive(Debug, PartialEq, Clone, Default)]
pub enum DeviceUpdateNullableField<T> {
    #[default]
    Missing,
    Null,
    Value(T),
}

impl<T> DeviceUpdateNullableField<T> {
    pub fn is_missing(&self) -> bool {
        matches!(self, Self::Missing)
    }
}

impl<T> Elm for DeviceUpdateNullableField<T>
where
    T: Elm,
{
    fn elm_type() -> String {
        format!("Maybe ({})", T::elm_type())
    }

    fn elm_definition() -> Option<String> {
        None
    }
}

impl<T> ElmEncode for DeviceUpdateNullableField<T>
where
    T: Elm + ElmEncode,
{
    fn encoder_type() -> String {
        format!(
            "Maybe.withDefault Json.Encode.null << Maybe.map ({})",
            T::encoder_type()
        )
    }

    fn encoder_definition() -> Option<String> {
        None
    }
}

impl<T> ElmDecode for DeviceUpdateNullableField<T>
where
    T: Elm + ElmDecode,
{
    fn decoder_type() -> String {
        format!("Json.Decode.nullable ({})", T::decoder_type())
    }

    fn decoder_definition() -> Option<String> {
        None
    }
}

impl<T> Serialize for DeviceUpdateNullableField<T>
where
    T: Serialize,
{
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Missing | Self::Null => serializer.serialize_none(),
            Self::Value(value) => value.serialize(serializer),
        }
    }
}

impl<'de, T> Deserialize<'de> for DeviceUpdateNullableField<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Ok(match Option::<T>::deserialize(deserializer)? {
            Some(value) => Self::Value(value),
            None => Self::Null,
        })
    }
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(deny_unknown_fields)]
pub struct UpdateDeviceReq {
    pub device_id: String,
    #[serde(
        default,
        skip_serializing_if = "DeviceUpdateRequiredField::is_missing"
    )]
    pub source_label: DeviceUpdateRequiredField<String>,
    #[serde(
        default,
        skip_serializing_if = "DeviceUpdateRequiredField::is_missing"
    )]
    pub name: DeviceUpdateRequiredField<String>,
    #[serde(
        default,
        skip_serializing_if = "DeviceUpdateRequiredField::is_missing"
    )]
    pub aor_ids: DeviceUpdateRequiredField<Vec<i64>>,
    #[serde(
        default,
        skip_serializing_if = "DeviceUpdateNullableField::is_missing"
    )]
    pub unit_id: DeviceUpdateNullableField<i64>,
    #[serde(
        default,
        skip_serializing_if = "DeviceUpdateRequiredField::is_missing"
    )]
    pub tags: DeviceUpdateRequiredField<Vec<DeviceTag>>,
    #[serde(
        default,
        skip_serializing_if = "DeviceUpdateNullableField::is_missing"
    )]
    pub external_url: DeviceUpdateNullableField<String>,
    #[serde(
        default,
        skip_serializing_if = "DeviceUpdateRequiredField::is_missing"
    )]
    pub custom_fields:
        DeviceUpdateRequiredField<BTreeMap<String, Option<String>>>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ArchiveDeviceReq {
    pub device_id: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct RestoreDeviceReq {
    pub device_id: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DeviceFileEntry {
    pub file_id: String,
    pub device_id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub path_syntax: Option<String>,
    pub absolute_path: Option<String>,
    pub mime_type: Option<String>,
    pub extension: Option<String>,
    pub file_metadata_created_at_ms: Option<i64>,
    pub file_metadata_modified_at_ms: Option<i64>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListDeviceFilesReq {
    pub device_id: String,
    pub limit: Option<u64>,
    pub offset: Option<u64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListDeviceFilesRsp {
    pub list: Vec<DeviceFileEntry>,
    pub total: u64,
    pub has_more: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_device_req_preserves_missing_null_and_value_fields() {
        let req: UpdateDeviceReq = serde_json::from_value(serde_json::json!({
            "device_id": "018f0000-0000-7000-8000-000000000000",
            "source_label": "source-device",
            "aor_ids": [],
            "unit_id": 7,
            "external_url": null,
            "custom_fields": {
                "inventory_id": "device.example",
                "source_port": null
            },
        }))
        .unwrap();

        assert!(
            matches!(&req.source_label, DeviceUpdateRequiredField::Value(label) if label == "source-device")
        );
        assert!(matches!(req.name, DeviceUpdateRequiredField::Missing));
        assert!(
            matches!(req.aor_ids, DeviceUpdateRequiredField::Value(ids) if ids.is_empty())
        );
        assert!(matches!(req.unit_id, DeviceUpdateNullableField::Value(7)));
        assert!(matches!(req.external_url, DeviceUpdateNullableField::Null));
        assert!(matches!(
            &req.custom_fields,
            DeviceUpdateRequiredField::Value(fields)
                if fields == &BTreeMap::from([
                    ("inventory_id".to_string(), Some("device.example".to_string())),
                    ("source_port".to_string(), None),
                ])
        ));
        assert!(matches!(req.tags, DeviceUpdateRequiredField::Missing));
    }

    #[test]
    fn update_device_req_rejects_null_required_patch_fields_and_unknown_fields()
    {
        let source_label_err =
            serde_json::from_value::<UpdateDeviceReq>(serde_json::json!({
                "device_id": "018f0000-0000-7000-8000-000000000000",
                "source_label": null
            }))
            .unwrap_err();
        assert!(source_label_err
            .to_string()
            .contains("field cannot be null"));

        let custom_fields_err =
            serde_json::from_value::<UpdateDeviceReq>(serde_json::json!({
                "device_id": "018f0000-0000-7000-8000-000000000000",
                "custom_fields": null
            }))
            .unwrap_err();
        assert!(custom_fields_err
            .to_string()
            .contains("field cannot be null"));

        let unexpected_field_err =
            serde_json::from_value::<UpdateDeviceReq>(serde_json::json!({
                "device_id": "018f0000-0000-7000-8000-000000000000",
                "unexpected": "value"
            }))
            .unwrap_err();
        assert!(unexpected_field_err.to_string().contains("unknown field"));
    }
}
