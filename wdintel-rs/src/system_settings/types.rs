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
    pub rer_duty_test_replay_interval_sec: i64,
    pub short_url_enabled: bool,
    pub rer_report_enabled: bool,
    pub support_non_rer_interceptions: bool,
    pub default_neo_analysis: bool,
    pub autofix_echoim_missing_messages: bool,
    pub peleng_bounds_enabled: bool,
    pub peleng_bounds_top_left_lat: Option<f64>,
    pub peleng_bounds_top_left_lng: Option<f64>,
    pub peleng_bounds_bottom_right_lat: Option<f64>,
    pub peleng_bounds_bottom_right_lng: Option<f64>,
    pub devices_section_enabled: bool,
    #[serde(default)]
    pub doc_media_serve_from_b2: bool,
    pub sigint_comment_parsing_enabled: bool,
    pub do_not_store_duplicate_echoim_failures: bool,
    pub goi_association_message_uid_worker_enabled: bool,
    pub report_chunking_hours: i64,
    pub limit_big_reports: bool,
    pub enable_audio_transcription: bool,
    pub show_classic_duty: bool,
    pub show_classic_analysis: bool,
    pub show_peleng_distance_to_battleline: bool,
    pub hide_orbit_data: bool,
    pub disable_bot_tags: bool,
    #[serde(default)]
    pub hide_networks: bool,
    pub duty_exclude_menu_enabled: bool,
    #[serde(default = "default_analysis_aor_filter_enabled")]
    pub analysis_aor_filter_enabled: bool,
    #[serde(default)]
    pub ai_position_highlights_enabled: bool,
    #[serde(default = "default_duty_selected_groups_enabled")]
    pub duty_selected_groups_enabled: bool,
    #[serde(default)]
    pub enable_duty_search: bool,
    #[serde(default = "default_important_notify_all_enabled")]
    pub important_notify_all_enabled: bool,
    #[serde(default = "default_true")]
    pub two_factor_auth_enabled: bool,
    #[serde(default = "default_api_rate_limit_replenish_interval_ms")]
    pub api_rate_limit_replenish_interval_ms: i64,
    #[serde(default = "default_api_rate_limit_burst_size")]
    pub api_rate_limit_burst_size: i64,
    #[serde(default = "default_true")]
    pub exclude_orbit_other_units: bool,
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
    pub rer_duty_test_replay_interval_sec: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub updated_by_login_id: Option<String>,
    pub deleted: bool,
    pub short_url_enabled: bool,
    pub rer_report_enabled: bool,
    pub support_non_rer_interceptions: bool,
    pub default_neo_analysis: bool,
    pub autofix_echoim_missing_messages: bool,
    pub peleng_bounds_enabled: bool,
    pub peleng_bounds_top_left_lat: Option<f64>,
    pub peleng_bounds_top_left_lng: Option<f64>,
    pub peleng_bounds_bottom_right_lat: Option<f64>,
    pub peleng_bounds_bottom_right_lng: Option<f64>,
    pub devices_section_enabled: bool,
    #[serde(default)]
    pub doc_media_serve_from_b2: bool,
    pub echo_restapi_error_discord_webhook_url: Option<String>,
    pub sigint_comment_parsing_enabled: bool,
    pub do_not_store_duplicate_echoim_failures: bool,
    pub goi_association_message_uid_worker_enabled: bool,
    pub report_chunking_hours: i64,
    pub report_global_concurrency: i64,
    pub report_kind_concurrency: i64,
    pub report_etalonka_concurrency: i64,
    pub limit_big_reports: bool,
    pub enable_audio_transcription: bool,
    pub show_classic_duty: bool,
    pub show_classic_analysis: bool,
    pub show_peleng_distance_to_battleline: bool,
    pub disable_bot_tags: bool,
    pub hide_networks: bool,
    pub duty_exclude_menu_enabled: bool,
    #[serde(default = "default_analysis_aor_filter_enabled")]
    pub analysis_aor_filter_enabled: bool,
    #[serde(default)]
    pub ai_position_highlights_enabled: bool,
    #[serde(default = "default_duty_selected_groups_enabled")]
    pub duty_selected_groups_enabled: bool,
    #[serde(default)]
    pub enable_duty_search: bool,
    #[serde(default = "default_important_notify_all_enabled")]
    pub important_notify_all_enabled: bool,
    #[serde(default = "default_true")]
    pub two_factor_auth_enabled: bool,
    #[serde(default = "default_api_rate_limit_replenish_interval_ms")]
    pub api_rate_limit_replenish_interval_ms: i64,
    #[serde(default = "default_api_rate_limit_burst_size")]
    pub api_rate_limit_burst_size: i64,
    #[serde(default = "default_true")]
    pub exclude_orbit_other_units: bool,
    #[serde(default)]
    pub messenger_media_cache_enabled: bool,
    #[serde(default = "default_media_cache_retention_hours")]
    pub messenger_media_cache_retention_hours: i64,
    #[serde(default = "default_media_cache_max_size_gib")]
    pub messenger_media_cache_max_size_gib: i64,
    #[serde(default = "default_media_cache_min_free_gib")]
    pub messenger_media_cache_min_free_gib: i64,
    #[serde(default)]
    pub signoz_metrics_enabled: bool,
    #[serde(default)]
    pub signoz_metrics_endpoint: Option<String>,
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
    #[serde(default = "default_rer_duty_test_replay_interval_sec")]
    pub rer_duty_test_replay_interval_sec: i64,
    pub short_url_enabled: bool,
    #[serde(default)]
    pub rer_report_enabled: bool,
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
    pub devices_section_enabled: bool,
    #[serde(default)]
    pub doc_media_serve_from_b2: bool,
    #[serde(default)]
    pub echo_restapi_error_discord_webhook_url: Option<String>,
    #[serde(default = "default_sigint_comment_parsing_enabled")]
    pub sigint_comment_parsing_enabled: bool,
    #[serde(default)]
    pub do_not_store_duplicate_echoim_failures: bool,
    #[serde(default)]
    pub goi_association_message_uid_worker_enabled: bool,
    #[serde(default = "default_report_chunking_hours")]
    pub report_chunking_hours: i64,
    #[serde(default)]
    pub report_global_concurrency: Option<i64>,
    #[serde(default)]
    pub report_kind_concurrency: Option<i64>,
    #[serde(default)]
    pub report_etalonka_concurrency: Option<i64>,
    #[serde(default)]
    pub limit_big_reports: bool,
    #[serde(default)]
    pub enable_audio_transcription: bool,
    #[serde(default = "default_true")]
    pub show_classic_duty: bool,
    #[serde(default = "default_true")]
    pub show_classic_analysis: bool,
    #[serde(default)]
    pub show_peleng_distance_to_battleline: bool,
    #[serde(default)]
    pub disable_bot_tags: bool,
    #[serde(default)]
    pub hide_networks: bool,
    #[serde(default = "default_true")]
    pub duty_exclude_menu_enabled: bool,
    #[serde(default = "default_analysis_aor_filter_enabled")]
    pub analysis_aor_filter_enabled: bool,
    #[serde(default)]
    pub ai_position_highlights_enabled: Option<bool>,
    #[serde(default)]
    pub duty_selected_groups_enabled: Option<bool>,
    #[serde(default)]
    pub enable_duty_search: Option<bool>,
    #[serde(default)]
    pub important_notify_all_enabled: Option<bool>,
    #[serde(default = "default_true")]
    pub two_factor_auth_enabled: bool,
    #[serde(default)]
    pub api_rate_limit_replenish_interval_ms: Option<i64>,
    #[serde(default)]
    pub api_rate_limit_burst_size: Option<i64>,
    #[serde(default = "default_true")]
    pub exclude_orbit_other_units: bool,
    #[serde(default)]
    pub messenger_media_cache_enabled: bool,
    #[serde(default = "default_media_cache_retention_hours")]
    pub messenger_media_cache_retention_hours: i64,
    #[serde(default = "default_media_cache_max_size_gib")]
    pub messenger_media_cache_max_size_gib: i64,
    #[serde(default = "default_media_cache_min_free_gib")]
    pub messenger_media_cache_min_free_gib: i64,
    /// Omitted by older clients; the saved value is then kept.
    #[serde(default)]
    pub signoz_metrics_enabled: Option<bool>,
    #[serde(default)]
    pub signoz_metrics_endpoint: Option<String>,
}

fn default_api_rate_limit_replenish_interval_ms() -> i64 {
    crate::config::API_RATE_LIMIT_REPLENISH_INTERVAL_MS_DEFAULT
}

fn default_api_rate_limit_burst_size() -> i64 {
    crate::config::API_RATE_LIMIT_BURST_SIZE_DEFAULT
}

fn default_analysis_aor_filter_enabled() -> bool {
    crate::config::ANALYSIS_AOR_FILTER_ENABLED_DEFAULT
}

fn default_duty_selected_groups_enabled() -> bool {
    crate::config::DUTY_SELECTED_GROUPS_ENABLED_DEFAULT
}

fn default_important_notify_all_enabled() -> bool {
    crate::config::IMPORTANT_NOTIFY_ALL_ENABLED_DEFAULT
}

fn default_true() -> bool {
    true
}

fn default_rer_duty_test_replay_interval_sec() -> i64 {
    1
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct RerDutyTestReplayStatusRsp {
    pub status: String,
    pub source_count: i64,
    pub next_source_position: Option<i64>,
    pub generated_count: i64,
    pub next_emit_at_ms: Option<i64>,
}

fn default_sigint_comment_parsing_enabled() -> bool {
    false
}

fn default_report_chunking_hours() -> i64 {
    crate::config::RER_REPORT_CHUNKING_HOURS_DEFAULT
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ActivateSystemSettingsReq {
    pub id: i64,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct SetRerReportEnabledReq {
    pub enabled: bool,
}

fn default_media_cache_retention_hours() -> i64 {
    crate::config::MESSENGER_MEDIA_CACHE_RETENTION_HOURS_DEFAULT
}

fn default_media_cache_max_size_gib() -> i64 {
    crate::config::MESSENGER_MEDIA_CACHE_MAX_SIZE_GIB_DEFAULT
}

fn default_media_cache_min_free_gib() -> i64 {
    crate::config::MESSENGER_MEDIA_CACHE_MIN_FREE_GIB_DEFAULT
}

#[cfg(test)]
mod tests {
    use super::CreateSystemSettingsReq;
    use serde_json::json;

    #[test]
    fn missing_boolean_settings_default_to_false() {
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
        assert!(!req.goi_association_message_uid_worker_enabled);
        assert_eq!(req.report_chunking_hours, 24);
        assert!(!req.limit_big_reports);
        assert!(!req.enable_audio_transcription);
        assert!(!req.show_peleng_distance_to_battleline);
        assert!(!req.disable_bot_tags);
        assert!(!req.hide_networks);
        assert!(req.analysis_aor_filter_enabled);
        assert_eq!(req.rer_duty_test_replay_interval_sec, 1);
        assert!(req.exclude_orbit_other_units);
    }
}
