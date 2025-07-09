use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Organism {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub name: String,
    pub created_at: i64,
    pub group_auto_link: bool,
    pub roles: Vec<String>,
    pub groups: Vec<String>,
    pub enabled: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum ListOrganismsSortBy {
    OrganismCreatedAtDesc,
    OrganismCreatedAtAsc,
    OrganismNameAsc,
    OrganismNameDesc,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListOrganismsReq {
    pub sort_by: Option<ListOrganismsSortBy>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CreateOrganismReq {
    pub name: String,
    pub parent_id: Option<i64>,
    pub roles: Vec<String>,
    pub group_auto_link: Option<bool>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UpdateOrganismReq {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub name: Option<String>,
    pub roles: Option<Vec<String>>,
    pub group_auto_link: Option<bool>,
    pub enabled: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AddGroupToOrganismReq {
    pub organism_id: i64,
    pub group_name: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct RemoveGroupFromOrganismReq {
    pub organism_id: i64,
    pub group_name: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SignalGroupFull {
    pub name: String,
    pub master_key: String,
    pub datasource_id: i64,
}
