use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};

#[derive(
    Debug,
    Clone,
    PartialEq,
    Eq,
    Serialize,
    Deserialize,
    Elm,
    ElmEncode,
    ElmDecode,
)]
#[serde(deny_unknown_fields)]
pub struct DeviceAudioForwardingChange {
    pub version: Option<String>,
    pub enabled: bool,
    pub add_groups: Vec<String>,
    pub remove_groups: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct DeviceAudioForwardingGroup {
    pub master_key: String,
    pub name: String,
    pub selected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct DeviceAudioForwardingSettings {
    pub version: Option<String>,
    pub enabled: bool,
    pub groups: Vec<DeviceAudioForwardingGroup>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct DeviceAudioForwardingEntry {
    pub device_id: String,
    pub device_name: String,
    pub device_archived: bool,
    pub group_master_key: String,
    pub group_name: String,
    pub enabled: bool,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct ListDeviceAudioForwardingReq {
    pub cursor: Option<(String, String)>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct ListDeviceAudioForwardingRsp {
    pub items: Vec<DeviceAudioForwardingEntry>,
    pub next_cursor: Option<(String, String)>,
    pub total_count: u64,
    pub page_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
#[serde(deny_unknown_fields)]
pub struct RemoveDeviceAudioForwardingReq {
    pub device_id: String,
    pub group_master_key: String,
    pub version: String,
}
