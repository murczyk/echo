use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AreaOfResponsibility {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    pub is_top_level: bool,
    pub left_bound: f64,
    pub right_bound: f64,
    pub left_coordinates: Option<AorCoordinates>,
    pub right_coordinates: Option<AorCoordinates>,
    pub created_at: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AorCoordinates {
    pub latitude: f64,
    pub longitude: f64,
    pub settlement: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum ListAreasOfResponsibilitySortBy {
    AreaOfResponsibilityNameDesc,
    AreaOfResponsibilityNameAsc,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListAreasOfResponsibilityReq {
    pub is_top_level: Option<bool>,
    pub sort_by: Option<ListAreasOfResponsibilitySortBy>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct AreaOfResponsibilityInsert {
    pub name: String,
    pub description: Option<String>,
    pub is_top_level: bool,
    pub left_bound: f64,
    pub right_bound: f64,
    pub left_coordinates: Option<AorCoordinates>,
    pub right_coordinates: Option<AorCoordinates>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UpdateAreaOfResponsibilityReq {
    pub id: i64,
    pub insert: AreaOfResponsibilityInsert,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DeleteAreaOfResponsibilityReq {
    pub id: i64,
}
