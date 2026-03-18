use crate::types::{Deserialize, Serialize};
use elm_rs::{Elm, ElmDecode, ElmEncode};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SystemSettingsCurrentRsp {
    pub id: Option<i64>,
    pub rer_analysis_units_exact_match_only_default: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SystemSettingsItem {
    pub id: i64,
    pub rer_analysis_units_exact_match_only_default: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub updated_by: Option<String>,
    pub deleted: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SystemSettingsListRsp {
    pub items: Vec<SystemSettingsItem>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CreateSystemSettingsReq {
    pub rer_analysis_units_exact_match_only_default: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ActivateSystemSettingsReq {
    pub id: i64,
}
