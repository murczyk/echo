export function networkSettingsResponse() {
  return {
    showTableRowNumbers: true,
  };
}

type SystemSettingsCurrentFixture = {
  id: number | null;
  rer_analysis_units_exact_match_only_default: boolean;
  rer_duty_test_enabled: boolean;
  rer_duty_insert_historical_interceptions: boolean;
  rer_duty_test_since_ms: number;
  rer_duty_test_limit: number;
  rer_duty_poll_interval_sec: number;
  rer_duty_test_replay_interval_sec: number;
  short_url_enabled: boolean;
  support_non_rer_interceptions: boolean;
  default_neo_analysis: boolean;
  autofix_echoim_missing_messages: boolean;
  peleng_bounds_enabled: boolean;
  peleng_bounds_top_left_lat: number | null;
  peleng_bounds_top_left_lng: number | null;
  peleng_bounds_bottom_right_lat: number | null;
  peleng_bounds_bottom_right_lng: number | null;
  devices_section_enabled: boolean;
  sigint_comment_parsing_enabled: boolean;
  do_not_store_duplicate_echoim_failures: boolean;
  goi_association_message_uid_worker_enabled: boolean;
  report_chunking_hours: number;
  limit_big_reports: boolean;
  enable_audio_transcription: boolean;
  show_classic_duty: boolean;
  show_classic_analysis: boolean;
  show_peleng_distance_to_battleline: boolean;
  hide_orbit_data: boolean;
  disable_bot_tags: boolean;
};

export function systemSettingsCurrentResponse({
  enableAudioTranscription = false,
  shortUrlEnabled = false,
}: {
  enableAudioTranscription?: boolean;
  shortUrlEnabled?: boolean;
} = {}): SystemSettingsCurrentFixture {
  return {
    id: null,
    rer_analysis_units_exact_match_only_default: false,
    rer_duty_test_enabled: false,
    rer_duty_insert_historical_interceptions: false,
    rer_duty_test_since_ms: 0,
    rer_duty_test_limit: 1,
    rer_duty_poll_interval_sec: 1,
    rer_duty_test_replay_interval_sec: 1,
    short_url_enabled: shortUrlEnabled,
    support_non_rer_interceptions: false,
    default_neo_analysis: false,
    autofix_echoim_missing_messages: false,
    peleng_bounds_enabled: false,
    peleng_bounds_top_left_lat: null,
    peleng_bounds_top_left_lng: null,
    peleng_bounds_bottom_right_lat: null,
    peleng_bounds_bottom_right_lng: null,
    devices_section_enabled: false,
    sigint_comment_parsing_enabled: false,
    do_not_store_duplicate_echoim_failures: false,
    goi_association_message_uid_worker_enabled: false,
    report_chunking_hours: 1,
    limit_big_reports: false,
    enable_audio_transcription: enableAudioTranscription,
    show_classic_duty: false,
    show_classic_analysis: false,
    show_peleng_distance_to_battleline: false,
    hide_orbit_data: false,
    disable_bot_tags: false,
  };
}
