use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct OrganismKeywordSetDto {
    pub id: i64,
    pub name: String,
    pub words: Vec<String>,
    pub author_login: Option<String>,
    pub is_system_default: bool,
    pub can_edit: bool,
    pub can_delete: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct OrganismKeywordSetUpsertReq {
    pub id: Option<i64>,
    pub name: String,
    pub words: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct OrganismKeywordSetInflectReq {
    pub lemmas: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct OrganismKeywordSetInflectRsp {
    pub words: Vec<String>,
}
