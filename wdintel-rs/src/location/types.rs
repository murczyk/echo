use crate::types::{Deserialize, Serialize};
use elm_rs::{Elm, ElmDecode, ElmEncode};

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    Eq,
    PartialEq,
    Ord,
    PartialOrd,
    Clone,
    Default,
)]
pub enum Language {
    #[default]
    Ua,
    UaTranslit,
    Ru,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct FindSettlementReq {
    pub query: String,
    pub region: Option<String>,
    pub related_coordinates: Option<(f64, f64)>,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Clone,
    Default,
    Debug,
    PartialEq,
    Serialize,
    Deserialize,
)]
pub struct SettlementDetails {
    pub id: Option<i32>,
    pub name: String,
    pub region: String,
    pub language: Language,
    pub coords: Option<(f64, f64)>,
}

#[derive(Serialize, Deserialize)]
pub struct SettlementFileRow {
    pub id: Option<i32>,
    pub name: String,
    pub coords: Option<(f64, f64)>,
    pub language_details: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CreateSettlementReq {
    pub name: String,
    pub lat: f64,
    pub lng: f64,
    pub alternative_names: Vec<String>,
    pub post_id: Option<i64>,
    pub openstreetmap_id: Option<i32>,
}
