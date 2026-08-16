use crate::types::{Deserialize, Serialize};
use elm_rs::{Elm, ElmDecode, ElmEncode};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct MediaSummaryStatus {
    pub state: String,
    pub last_error: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
#[serde(rename_all = "camelCase")]
pub struct MediaSummaryResult {
    pub state: String,
    pub summary: Option<String>,
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
