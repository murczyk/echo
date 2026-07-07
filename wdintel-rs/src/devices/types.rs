use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::de::Error as DeError;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DeviceCustomField {
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
pub enum DeviceDeletedFilter {
    #[serde(rename = "active_only")]
    DeviceActiveOnly,
    #[serde(rename = "deleted_only")]
    DeviceDeletedOnly,
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
    pub name: String,
    pub created_by: String,
    pub aor_id: Option<i64>,
    pub aor_name: Option<String>,
    pub unit_id: Option<i64>,
    pub unit_name: Option<String>,
    pub external_url: Option<String>,
    pub deleted: bool,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub deleted_at_ms: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DeviceDetails {
    pub id: String,
    pub name: String,
    pub created_by: String,
    pub aor_id: Option<i64>,
    pub aor_name: Option<String>,
    pub unit_id: Option<i64>,
    pub unit_name: Option<String>,
    pub custom_fields: Vec<DeviceCustomField>,
    pub external_url: Option<String>,
    pub deleted: bool,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub deleted_at_ms: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DeviceFileEntry {
    pub file_id: String,
    pub device_id: String,
    pub original_name: Option<String>,
    pub original_absolute_path: Option<String>,
    pub original_created_at_ms: Option<i64>,
    pub original_modified_at_ms: Option<i64>,
    pub deleted: bool,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub deleted_at_ms: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListDevicesReq {
    pub filter_text: Option<String>,
    pub deleted_filter: Option<DeviceDeletedFilter>,
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
pub struct ListDevicesRsp {
    pub list: Vec<DeviceListItem>,
    pub total: u64,
    pub has_more: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DeviceDetailReq {
    pub device_id: String,
    pub include_deleted: Option<bool>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CreateDeviceReq {
    pub name: String,
    pub aor_id: Option<i64>,
    pub unit_id: Option<i64>,
    #[serde(default)]
    pub custom_fields: Vec<DeviceCustomField>,
    pub external_url: Option<String>,
    pub files: Option<Vec<CreateDeviceFileItem>>,
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
pub struct UpdateDeviceReq {
    pub device_id: String,
    #[serde(
        default,
        skip_serializing_if = "DeviceUpdateRequiredField::is_missing"
    )]
    pub name: DeviceUpdateRequiredField<String>,
    #[serde(
        default,
        skip_serializing_if = "DeviceUpdateNullableField::is_missing"
    )]
    pub aor_id: DeviceUpdateNullableField<i64>,
    #[serde(
        default,
        skip_serializing_if = "DeviceUpdateNullableField::is_missing"
    )]
    pub unit_id: DeviceUpdateNullableField<i64>,
    #[serde(
        default,
        skip_serializing_if = "DeviceUpdateRequiredField::is_missing"
    )]
    pub custom_fields: DeviceUpdateRequiredField<Vec<DeviceCustomField>>,
    #[serde(
        default,
        skip_serializing_if = "DeviceUpdateNullableField::is_missing"
    )]
    pub external_url: DeviceUpdateNullableField<String>,
    pub files: Option<Vec<CreateDeviceFileItem>>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DeleteDeviceReq {
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
pub struct ListDeviceFilesReq {
    pub device_id: String,
    pub deleted_filter: Option<DeviceDeletedFilter>,
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

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CreateDeviceFileItem {
    pub original_name: Option<String>,
    pub original_absolute_path: Option<String>,
    pub original_created_at_ms: Option<i64>,
    pub original_modified_at_ms: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CreateDeviceFilesReq {
    pub device_id: String,
    pub files: Vec<CreateDeviceFileItem>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CreateDeviceFilesRsp {
    pub list: Vec<DeviceFileEntry>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct RestoreDeviceFileReq {
    pub device_id: String,
    pub file_id: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DeleteDeviceFileReq {
    pub device_id: String,
    pub file_id: String,
}
