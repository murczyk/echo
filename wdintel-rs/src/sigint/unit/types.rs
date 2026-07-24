use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Unit {
    pub id: i64,
    pub company: String,
    pub battalion: String,
    pub regiment: String,
    pub division: String,
    pub army: String,
    pub comment: String,
    pub name: String,
    pub active: bool,
    pub created_at: i64,
    pub created_by_login_id: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum ListUnitsSortBy {
    CreatedAtDesc,
    CreatedAtAsc,
    NaturalMilitarySortAsc,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListUnitsReq {
    pub sort_by: Option<ListUnitsSortBy>,
    pub after_unit_id: Option<i64>,
    pub before_unit_id: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListUnitsRsp {
    pub show_load_more: bool,
    pub units: Vec<Unit>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListUnitsByIdReq {
    pub ids: Option<Vec<i64>>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListUnitsByIdRsp {
    pub units: Vec<Unit>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CreateUnitReq {
    pub company: String,
    pub battalion: String,
    pub regiment: String,
    pub division: String,
    pub army: String,
    pub active: bool,
    pub comment: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CreateUnitWithAutoNetworkReq {
    pub unit: CreateUnitReq,
    pub skip_network_creation: bool,
    pub locations: Vec<String>,
    pub unit_mask: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CreateUnitWithAutoNetworkRsp {
    pub unit: Unit,
    pub network_id: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DeleteUnitDuplicateReq {
    pub clone_to_delete_id: i64,
    pub original_id: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UnitSearchReq {
    pub search: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UnitDetailsReq {
    pub unit_id: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UnitAttachmentAor {
    pub id: i64,
    pub name: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UnitAttachment {
    pub id: i64,
    pub unit_id: i64,
    pub file_name: String,
    pub content_type: String,
    pub size_bytes: i64,
    pub short_description: String,
    pub full_description: String,
    pub aors: Vec<UnitAttachmentAor>,
    pub created_at: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UnitDetailsRsp {
    pub unit: Unit,
    pub attachments: Vec<UnitAttachment>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UnitAttachmentUnitIdsRsp {
    pub unit_ids: Vec<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UnitAttachmentDownloadReq {
    pub attachment_id: i64,
}
