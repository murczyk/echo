use crate::types::{Deserialize, Serialize};
use elm_rs::{Elm, ElmDecode, ElmEncode};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct MediaSummaryStatus {
    pub state: String,
    pub last_error: Option<String>,
    pub has_coordinates: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct MediaSummaryCoordinate {
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub planned_means: Option<String>,
    pub coordinate_system: String,
    pub value: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct MediaSummaryCoordinatesResult {
    pub coordinates: Vec<MediaSummaryCoordinate>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct MediaSummaryResult {
    pub state: String,
    pub summary: Option<String>,
    pub coordinates: Vec<MediaSummaryCoordinate>,
    pub last_error: Option<String>,
    pub source_kind: String,
    pub source_char_count: i32,
    pub ai_engine_name: String,
    pub model_name: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct MediaSummaryEngineItem {
    pub id: String,
    pub name: String,
    pub model_name: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct MediaSummarySettingsItem {
    pub enabled: bool,
    pub ai_engine_id: Option<String>,
    pub engines: Vec<MediaSummaryEngineItem>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct SaveMediaSummarySettingsReq {
    pub enabled: bool,
    pub ai_engine_id: Option<String>,
}
