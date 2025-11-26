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
    pub roles: Vec<String>,
    pub enabled: bool,
    pub aor_ids: Vec<i64>,
    pub logins_count: i64,
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
    pub aor_ids: Option<Vec<i64>>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UpdateOrganismReq {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub name: Option<String>,
    pub roles: Option<Vec<String>>,
    pub enabled: bool,
    pub aor_ids: Option<Vec<i64>>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AddGroupToOrganismReq {
    pub organism_id: i64,
    /// Used to be group name, now it's master key
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
    pub origin_datasource_id: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct OrganismGroup {
    pub master_key: String,
    pub organism_id: i64,
}

#[derive(Debug)]
pub struct OrganismGroups {
    /// Group master keys available to the organism
    pub available_keys: Vec<String>,
    pub selected_keys: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct MyOrganism {
    pub id: i64,
    pub name: String,
}
