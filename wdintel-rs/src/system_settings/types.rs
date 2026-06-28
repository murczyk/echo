use crate::types::{Deserialize, Serialize};
use elm_rs::{Elm, ElmDecode, ElmEncode};

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SystemSettingsCurrentRsp {
    pub id: Option<i64>,
    pub rer_analysis_units_exact_match_only_default: bool,
    pub rer_duty_test_enabled: bool,
    pub rer_duty_insert_historical_interceptions: bool,
    pub rer_duty_test_since_ms: i64,
    pub rer_duty_test_limit: i64,
    pub rer_duty_poll_interval_sec: i64,
    pub short_url_enabled: bool,
    pub support_non_rer_interceptions: bool,
    pub peleng_bounds_enabled: bool,
    pub peleng_bounds_top_left_lat: Option<f64>,
    pub peleng_bounds_top_left_lng: Option<f64>,
    pub peleng_bounds_bottom_right_lat: Option<f64>,
    pub peleng_bounds_bottom_right_lng: Option<f64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct SystemSettingsItem {
    pub id: i64,
    pub rer_analysis_units_exact_match_only_default: bool,
    pub rer_duty_test_enabled: bool,
    pub rer_duty_insert_historical_interceptions: bool,
    pub rer_duty_test_since_ms: i64,
    pub rer_duty_test_limit: i64,
    pub rer_duty_poll_interval_sec: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub updated_by: Option<String>,
    pub deleted: bool,
    pub short_url_enabled: bool,
    pub peleng_bounds_enabled: bool,
    pub peleng_bounds_top_left_lat: Option<f64>,
    pub peleng_bounds_top_left_lng: Option<f64>,
    pub peleng_bounds_bottom_right_lat: Option<f64>,
    pub peleng_bounds_bottom_right_lng: Option<f64>,
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
    pub rer_duty_test_enabled: bool,
    pub rer_duty_insert_historical_interceptions: bool,
    pub rer_duty_test_since_ms: i64,
    pub rer_duty_test_limit: i64,
    pub rer_duty_poll_interval_sec: i64,
    pub short_url_enabled: bool,
    #[serde(default)]
    pub peleng_bounds_enabled: bool,
    pub peleng_bounds_top_left_lat: Option<f64>,
    pub peleng_bounds_top_left_lng: Option<f64>,
    pub peleng_bounds_bottom_right_lat: Option<f64>,
    pub peleng_bounds_bottom_right_lng: Option<f64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ActivateSystemSettingsReq {
    pub id: i64,
}
