use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
#[serde(rename_all = "camelCase")]
pub struct RoleMessageSettings {
    pub role: String,
    pub unit_required: bool,
    pub device_required: bool,
    pub allow_unit_creation: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
#[serde(rename_all = "camelCase")]
pub struct RoleMessageSettingsKey {
    pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
#[serde(rename_all = "camelCase")]
pub struct RoleMessageSettingsListRsp {
    pub settings: Vec<RoleMessageSettings>,
    pub roles: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
#[serde(rename_all = "camelCase")]
pub struct MessageCreationSettings {
    pub unit_required: bool,
    pub device_required: bool,
    pub allow_unit_creation: bool,
}
