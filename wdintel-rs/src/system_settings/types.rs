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
    pub default_neo_analysis: bool,
    pub autofix_echoim_missing_messages: bool,
    pub peleng_bounds_enabled: bool,
    pub peleng_bounds_top_left_lat: Option<f64>,
    pub peleng_bounds_top_left_lng: Option<f64>,
    pub peleng_bounds_bottom_right_lat: Option<f64>,
    pub peleng_bounds_bottom_right_lng: Option<f64>,
    pub cyber_echo_enabled: bool,
    pub sigint_comment_parsing_enabled: bool,
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
    pub support_non_rer_interceptions: bool,
    pub default_neo_analysis: bool,
    pub autofix_echoim_missing_messages: bool,
    pub peleng_bounds_enabled: bool,
    pub peleng_bounds_top_left_lat: Option<f64>,
    pub peleng_bounds_top_left_lng: Option<f64>,
    pub peleng_bounds_bottom_right_lat: Option<f64>,
    pub peleng_bounds_bottom_right_lng: Option<f64>,
    pub cyber_echo_enabled: bool,
    pub echo_restapi_error_discord_webhook_url: Option<String>,
    pub sigint_comment_parsing_enabled: bool,
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
    pub support_non_rer_interceptions: bool,
    #[serde(default)]
    pub default_neo_analysis: bool,
    #[serde(default)]
    pub autofix_echoim_missing_messages: bool,
    #[serde(default)]
    pub peleng_bounds_enabled: bool,
    pub peleng_bounds_top_left_lat: Option<f64>,
    pub peleng_bounds_top_left_lng: Option<f64>,
    pub peleng_bounds_bottom_right_lat: Option<f64>,
    pub peleng_bounds_bottom_right_lng: Option<f64>,
    #[serde(default)]
    pub cyber_echo_enabled: bool,
    #[serde(default)]
    pub echo_restapi_error_discord_webhook_url: Option<String>,
    #[serde(default = "default_sigint_comment_parsing_enabled")]
    pub sigint_comment_parsing_enabled: bool,
}

fn default_sigint_comment_parsing_enabled() -> bool {
    false
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ActivateSystemSettingsReq {
    pub id: i64,
}

#[cfg(test)]
mod tests {
    use super::CreateSystemSettingsReq;
    use serde_json::json;

    #[test]
    fn missing_sigint_comment_parsing_enabled_defaults_to_false() {
        let req: CreateSystemSettingsReq = serde_json::from_value(json!({
            "rer_analysis_units_exact_match_only_default": true,
            "rer_duty_test_enabled": false,
            "rer_duty_insert_historical_interceptions": false,
            "rer_duty_test_since_ms": 0,
            "rer_duty_test_limit": 1,
            "rer_duty_poll_interval_sec": 1,
            "short_url_enabled": false
        }))
        .unwrap();

        assert!(!req.sigint_comment_parsing_enabled);
    }
}
