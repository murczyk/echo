use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UnitMachineItem {
    pub id: i64,
    pub sigint_network_id: i64,
    pub network_display_name: String,
    pub machine_id: Option<String>,
    pub machine_tags: Vec<String>,
    pub deleted: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub updated_by: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UnitMachineListReq {
    pub include_archived: Option<bool>,
    pub sigint_network_id: Option<i64>,
    pub query: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UnitMachineListRsp {
    pub items: Vec<UnitMachineItem>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UnitMachineCreateReq {
    pub sigint_network_id: i64,
    pub machine_id: Option<String>,
    pub machine_tags: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UnitMachineUpdateReq {
    pub id: i64,
    pub sigint_network_id: i64,
    pub machine_id: Option<String>,
    pub machine_tags: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UnitMachineArchiveReq {
    pub id: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum UnitMachineWarningCode {
    ArchivedDuplicateMachineId,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UnitMachineWarning {
    pub code: UnitMachineWarningCode,
    pub message: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UnitMachineMutationRsp {
    pub item: UnitMachineItem,
    pub warning: Option<UnitMachineWarning>,
}
