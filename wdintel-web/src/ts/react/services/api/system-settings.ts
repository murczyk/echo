import type {
  SystemSettingsCurrentRsp,
  SystemSettingsItem as BackendSystemSettingsItem,
} from '../../../../Bindings';
import { postJson } from './client';

type SystemSettingsItemRaw = {
  id: number;
  rer_analysis_units_exact_match_only_default: boolean;
  rer_duty_test_enabled: boolean;
  rer_duty_insert_historical_interceptions: boolean;
  rer_duty_test_since_ms: number;
  rer_duty_test_limit: number;
  rer_duty_poll_interval_sec: number;
  rer_duty_test_replay_interval_sec?: number;
  created_at: number;
  updated_at: number;
  updated_by?: string | null;
  deleted: boolean;
  short_url_enabled: boolean;
  rer_report_enabled?: boolean;
  support_non_rer_interceptions?: boolean;
  default_neo_analysis?: boolean;
  show_classic_duty?: boolean;
  show_classic_analysis?: boolean;
  show_peleng_distance_to_battleline?: boolean;
  disable_bot_tags?: boolean | null;
  hide_networks?: boolean | null;
  doc_media_serve_from_b2?: SystemSettingsCurrentRsp['docMediaServeFromB2'];
  duty_exclude_menu_enabled?: SystemSettingsCurrentRsp['dutyExcludeMenuEnabled'] | null;
  analysis_aor_filter_enabled?: SystemSettingsCurrentRsp['analysisAorFilterEnabled'] | null;
  ai_position_highlights_enabled?: SystemSettingsCurrentRsp['aiPositionHighlightsEnabled'] | null;
  duty_selected_groups_enabled?: SystemSettingsCurrentRsp['dutySelectedGroupsEnabled'] | null;
  important_notify_all_enabled?: SystemSettingsCurrentRsp['importantNotifyAllEnabled'] | null;
  api_rate_limit_replenish_interval_ms?: BackendSystemSettingsItem['apiRateLimitReplenishIntervalMs'];
  api_rate_limit_burst_size?: BackendSystemSettingsItem['apiRateLimitBurstSize'];
  two_factor_auth_enabled?: SystemSettingsCurrentRsp['twoFactorAuthEnabled'] | null;
  exclude_orbit_other_units?: boolean | null;
  messenger_media_cache_min_free_gib?: BackendSystemSettingsItem['messengerMediaCacheMinFreeGib'];
  messenger_media_cache_max_size_gib?: BackendSystemSettingsItem['messengerMediaCacheMaxSizeGib'];
  messenger_media_cache_retention_hours?: BackendSystemSettingsItem['messengerMediaCacheRetentionHours'];
  messenger_media_cache_enabled?: BackendSystemSettingsItem['messengerMediaCacheEnabled'];
  autofix_echoim_missing_messages?: boolean;
  devices_section_enabled?: boolean;
  sigint_comment_parsing_enabled?: boolean;
  do_not_store_duplicate_echoim_failures?: boolean;
  goi_association_message_uid_worker_enabled?: boolean;
  report_chunking_hours?: number;
  report_global_concurrency?: BackendSystemSettingsItem['reportGlobalConcurrency'];
  report_kind_concurrency?: BackendSystemSettingsItem['reportKindConcurrency'];
  report_etalonka_concurrency?: BackendSystemSettingsItem['reportEtalonkaConcurrency'];
  limit_big_reports?: boolean;
  enable_audio_transcription?: boolean;
  peleng_bounds_enabled?: boolean;
  peleng_bounds_top_left_lat?: number | null;
  peleng_bounds_top_left_lng?: number | null;
  peleng_bounds_bottom_right_lat?: number | null;
  peleng_bounds_bottom_right_lng?: number | null;
  echo_restapi_error_discord_webhook_url?: string | null;
  signoz_metrics_enabled?: BackendSystemSettingsItem['signozMetricsEnabled'];
  signoz_metrics_endpoint?: BackendSystemSettingsItem['signozMetricsEndpoint'];
};

type SystemSettingsCurrentRspRaw = {
  id: number | null;
  rer_analysis_units_exact_match_only_default: boolean;
  rer_duty_test_enabled: boolean;
  rer_duty_insert_historical_interceptions: boolean;
  rer_duty_test_since_ms: number;
  rer_duty_test_limit: number;
  rer_duty_poll_interval_sec: number;
  rer_duty_test_replay_interval_sec?: number;
  short_url_enabled: boolean;
  rer_report_enabled?: boolean;
  support_non_rer_interceptions?: boolean;
  default_neo_analysis?: boolean;
  show_classic_duty?: boolean;
  show_classic_analysis?: boolean;
  show_peleng_distance_to_battleline?: boolean;
  hide_orbit_data?: boolean;
  disable_bot_tags?: boolean | null;
  hide_networks?: boolean | null;
  doc_media_serve_from_b2?: SystemSettingsCurrentRsp['docMediaServeFromB2'];
  duty_exclude_menu_enabled?: SystemSettingsCurrentRsp['dutyExcludeMenuEnabled'] | null;
  analysis_aor_filter_enabled?: SystemSettingsCurrentRsp['analysisAorFilterEnabled'] | null;
  ai_position_highlights_enabled?: SystemSettingsCurrentRsp['aiPositionHighlightsEnabled'] | null;
  duty_selected_groups_enabled?: SystemSettingsCurrentRsp['dutySelectedGroupsEnabled'] | null;
  important_notify_all_enabled?: SystemSettingsCurrentRsp['importantNotifyAllEnabled'] | null;
  api_rate_limit_replenish_interval_ms?: BackendSystemSettingsItem['apiRateLimitReplenishIntervalMs'];
  api_rate_limit_burst_size?: BackendSystemSettingsItem['apiRateLimitBurstSize'];
  two_factor_auth_enabled?: SystemSettingsCurrentRsp['twoFactorAuthEnabled'] | null;
  exclude_orbit_other_units?: boolean | null;
  autofix_echoim_missing_messages?: boolean;
  devices_section_enabled?: boolean;
  sigint_comment_parsing_enabled?: boolean;
  do_not_store_duplicate_echoim_failures?: boolean;
  goi_association_message_uid_worker_enabled?: boolean;
  report_chunking_hours?: number;
  limit_big_reports?: boolean;
  enable_audio_transcription?: boolean;
  peleng_bounds_enabled?: boolean;
  peleng_bounds_top_left_lat?: number | null;
  peleng_bounds_top_left_lng?: number | null;
  peleng_bounds_bottom_right_lat?: number | null;
  peleng_bounds_bottom_right_lng?: number | null;
};

type SystemSettingsListRspRaw = {
  items: SystemSettingsItemRaw[];
};

type CreateSystemSettingsReqRaw = {
  rer_analysis_units_exact_match_only_default: boolean;
  rer_duty_test_enabled: boolean;
  rer_duty_insert_historical_interceptions: boolean;
  rer_duty_test_since_ms: number;
  rer_duty_test_limit: number;
  rer_duty_poll_interval_sec: number;
  rer_duty_test_replay_interval_sec: number;
  short_url_enabled: boolean;
  rer_report_enabled: boolean;
  support_non_rer_interceptions: boolean;
  default_neo_analysis: boolean;
  show_classic_duty: boolean;
  show_classic_analysis: boolean;
  show_peleng_distance_to_battleline: boolean;
  disable_bot_tags: boolean;
  hide_networks: boolean;
  doc_media_serve_from_b2: SystemSettingsCurrentRsp['docMediaServeFromB2'];
  duty_exclude_menu_enabled: SystemSettingsCurrentRsp['dutyExcludeMenuEnabled'];
  analysis_aor_filter_enabled: SystemSettingsCurrentRsp['analysisAorFilterEnabled'];
  ai_position_highlights_enabled: SystemSettingsCurrentRsp['aiPositionHighlightsEnabled'];
  duty_selected_groups_enabled: SystemSettingsCurrentRsp['dutySelectedGroupsEnabled'] | null;
  important_notify_all_enabled: SystemSettingsCurrentRsp['importantNotifyAllEnabled'] | null;
  api_rate_limit_replenish_interval_ms?: BackendSystemSettingsItem['apiRateLimitReplenishIntervalMs'];
  api_rate_limit_burst_size?: BackendSystemSettingsItem['apiRateLimitBurstSize'];
  two_factor_auth_enabled: SystemSettingsCurrentRsp['twoFactorAuthEnabled'];
  exclude_orbit_other_units: boolean;
  messenger_media_cache_min_free_gib: BackendSystemSettingsItem['messengerMediaCacheMinFreeGib'];
  messenger_media_cache_max_size_gib: BackendSystemSettingsItem['messengerMediaCacheMaxSizeGib'];
  messenger_media_cache_retention_hours: BackendSystemSettingsItem['messengerMediaCacheRetentionHours'];
  messenger_media_cache_enabled: BackendSystemSettingsItem['messengerMediaCacheEnabled'];
  autofix_echoim_missing_messages: boolean;
  devices_section_enabled: boolean;
  sigint_comment_parsing_enabled: boolean;
  do_not_store_duplicate_echoim_failures: boolean;
  goi_association_message_uid_worker_enabled: boolean;
  report_chunking_hours: number;
  report_global_concurrency?: BackendSystemSettingsItem['reportGlobalConcurrency'];
  report_kind_concurrency?: BackendSystemSettingsItem['reportKindConcurrency'];
  report_etalonka_concurrency?: BackendSystemSettingsItem['reportEtalonkaConcurrency'];
  limit_big_reports: boolean;
  enable_audio_transcription: boolean;
  peleng_bounds_enabled: boolean;
  peleng_bounds_top_left_lat: number | null;
  peleng_bounds_top_left_lng: number | null;
  peleng_bounds_bottom_right_lat: number | null;
  peleng_bounds_bottom_right_lng: number | null;
  echo_restapi_error_discord_webhook_url: string | null;
  signoz_metrics_enabled?: BackendSystemSettingsItem['signozMetricsEnabled'];
  signoz_metrics_endpoint?: BackendSystemSettingsItem['signozMetricsEndpoint'];
};

type ActivateSystemSettingsReqRaw = {
  id: number;
};

export type SystemSettingsItem = {
  id: number;
  rerAnalysisUnitsExactMatchOnlyDefault: boolean;
  rerDutyTestEnabled: boolean;
  rerDutyInsertHistoricalInterceptions: boolean;
  rerDutyTestSinceMs: number;
  rerDutyTestLimit: number;
  rerDutyPollIntervalSec: number;
  rerDutyTestReplayIntervalSec: number;
  createdAt: number;
  updatedAt: number;
  updatedBy: string | null;
  deleted: boolean;
  rerShortUrlEnabled: boolean;
  rerReportEnabled: boolean;
  supportNonRerInterceptions: boolean;
  defaultNeoAnalysis: boolean;
  showClassicDuty: boolean;
  showClassicAnalysis: boolean;
  showPelengDistanceToBattleline: boolean;
  disableBotTags: boolean;
  hideNetworks: boolean;
  docMediaServeFromB2: SystemSettingsCurrentRsp['docMediaServeFromB2'];
  dutyExcludeMenuEnabled: SystemSettingsCurrentRsp['dutyExcludeMenuEnabled'];
  analysisAorFilterEnabled: SystemSettingsCurrentRsp['analysisAorFilterEnabled'];
  aiPositionHighlightsEnabled: SystemSettingsCurrentRsp['aiPositionHighlightsEnabled'];
  dutySelectedGroupsEnabled: SystemSettingsCurrentRsp['dutySelectedGroupsEnabled'];
  importantNotifyAllEnabled: SystemSettingsCurrentRsp['importantNotifyAllEnabled'];
  apiRateLimitReplenishIntervalMs: BackendSystemSettingsItem['apiRateLimitReplenishIntervalMs'];
  apiRateLimitBurstSize: BackendSystemSettingsItem['apiRateLimitBurstSize'];
  twoFactorAuthEnabled: SystemSettingsCurrentRsp['twoFactorAuthEnabled'];
  excludeOrbitOtherUnits: boolean;
  messengerMediaCacheMinFreeGib: BackendSystemSettingsItem['messengerMediaCacheMinFreeGib'];
  messengerMediaCacheMaxSizeGib: BackendSystemSettingsItem['messengerMediaCacheMaxSizeGib'];
  messengerMediaCacheRetentionHours: BackendSystemSettingsItem['messengerMediaCacheRetentionHours'];
  messengerMediaCacheEnabled: BackendSystemSettingsItem['messengerMediaCacheEnabled'];
  autofixEchoimMissingMessages: boolean;
  devicesSectionEnabled: boolean;
  sigintCommentParsingEnabled: boolean;
  doNotStoreDuplicateEchoimFailures: boolean;
  goiAssociationMessageUidWorkerEnabled: boolean;
  reportChunkingHours: number;
  reportGlobalConcurrency: BackendSystemSettingsItem['reportGlobalConcurrency'];
  reportKindConcurrency: BackendSystemSettingsItem['reportKindConcurrency'];
  reportEtalonkaConcurrency: BackendSystemSettingsItem['reportEtalonkaConcurrency'];
  limitBigReports: boolean;
  enableAudioTranscription: boolean;
  pelengBoundsEnabled: boolean;
  pelengBoundsTopLeftLat: number | null;
  pelengBoundsTopLeftLng: number | null;
  pelengBoundsBottomRightLat: number | null;
  pelengBoundsBottomRightLng: number | null;
  echoRestapiErrorDiscordWebhookUrl: string | null;
  signozMetricsEnabled: BackendSystemSettingsItem['signozMetricsEnabled'];
  signozMetricsEndpoint: BackendSystemSettingsItem['signozMetricsEndpoint'];
};

export type SystemSettingsCurrent = {
  id: number | null;
  rerAnalysisUnitsExactMatchOnlyDefault: boolean;
  rerDutyTestEnabled: boolean;
  rerDutyInsertHistoricalInterceptions: boolean;
  rerDutyTestSinceMs: number;
  rerDutyTestLimit: number;
  rerDutyPollIntervalSec: number;
  rerDutyTestReplayIntervalSec: number;
  rerShortUrlEnabled: boolean;
  rerReportEnabled: boolean;
  supportNonRerInterceptions: boolean;
  defaultNeoAnalysis: boolean;
  showClassicDuty: boolean;
  showClassicAnalysis: boolean;
  showPelengDistanceToBattleline: boolean;
  hideOrbitData: boolean;
  disableBotTags: boolean;
  hideNetworks: boolean;
  docMediaServeFromB2: SystemSettingsCurrentRsp['docMediaServeFromB2'];
  dutyExcludeMenuEnabled: SystemSettingsCurrentRsp['dutyExcludeMenuEnabled'];
  analysisAorFilterEnabled: SystemSettingsCurrentRsp['analysisAorFilterEnabled'];
  aiPositionHighlightsEnabled: SystemSettingsCurrentRsp['aiPositionHighlightsEnabled'];
  dutySelectedGroupsEnabled: SystemSettingsCurrentRsp['dutySelectedGroupsEnabled'];
  importantNotifyAllEnabled: SystemSettingsCurrentRsp['importantNotifyAllEnabled'];
  apiRateLimitReplenishIntervalMs: BackendSystemSettingsItem['apiRateLimitReplenishIntervalMs'];
  apiRateLimitBurstSize: BackendSystemSettingsItem['apiRateLimitBurstSize'];
  twoFactorAuthEnabled: SystemSettingsCurrentRsp['twoFactorAuthEnabled'];
  excludeOrbitOtherUnits: boolean;
  autofixEchoimMissingMessages: boolean;
  devicesSectionEnabled: boolean;
  sigintCommentParsingEnabled: boolean;
  doNotStoreDuplicateEchoimFailures: boolean;
  goiAssociationMessageUidWorkerEnabled: boolean;
  reportChunkingHours: number;
  limitBigReports: boolean;
  enableAudioTranscription: boolean;
  pelengBoundsEnabled: boolean;
  pelengBoundsTopLeftLat: number | null;
  pelengBoundsTopLeftLng: number | null;
  pelengBoundsBottomRightLat: number | null;
  pelengBoundsBottomRightLng: number | null;
};

export type CreateSystemSettingsInput = {
  rerAnalysisUnitsExactMatchOnlyDefault: boolean;
  rerDutyTestEnabled: boolean;
  rerDutyInsertHistoricalInterceptions: boolean;
  rerDutyTestSinceMs: number;
  rerDutyTestLimit: number;
  rerDutyPollIntervalSec: number;
  rerDutyTestReplayIntervalSec: number;
  rerDutyShortUrl: boolean;
  rerReportEnabled: boolean;
  supportNonRerInterceptions: boolean;
  defaultNeoAnalysis: boolean;
  showClassicDuty: boolean;
  showClassicAnalysis: boolean;
  showPelengDistanceToBattleline?: boolean;
  disableBotTags: boolean;
  hideNetworks: boolean;
  docMediaServeFromB2: SystemSettingsCurrentRsp['docMediaServeFromB2'];
  dutyExcludeMenuEnabled?: SystemSettingsCurrentRsp['dutyExcludeMenuEnabled'];
  analysisAorFilterEnabled?: SystemSettingsCurrentRsp['analysisAorFilterEnabled'];
  aiPositionHighlightsEnabled?: SystemSettingsCurrentRsp['aiPositionHighlightsEnabled'];
  dutySelectedGroupsEnabled?: SystemSettingsCurrentRsp['dutySelectedGroupsEnabled'];
  importantNotifyAllEnabled?: SystemSettingsCurrentRsp['importantNotifyAllEnabled'];
  apiRateLimitReplenishIntervalMs?: BackendSystemSettingsItem['apiRateLimitReplenishIntervalMs'];
  apiRateLimitBurstSize?: BackendSystemSettingsItem['apiRateLimitBurstSize'];
  twoFactorAuthEnabled?: SystemSettingsCurrentRsp['twoFactorAuthEnabled'];
  excludeOrbitOtherUnits?: boolean;
  messengerMediaCacheMinFreeGib?: BackendSystemSettingsItem['messengerMediaCacheMinFreeGib'];
  messengerMediaCacheMaxSizeGib?: BackendSystemSettingsItem['messengerMediaCacheMaxSizeGib'];
  messengerMediaCacheRetentionHours?: BackendSystemSettingsItem['messengerMediaCacheRetentionHours'];
  messengerMediaCacheEnabled?: BackendSystemSettingsItem['messengerMediaCacheEnabled'];
  autofixEchoimMissingMessages: boolean;
  devicesSectionEnabled: boolean;
  sigintCommentParsingEnabled: boolean;
  doNotStoreDuplicateEchoimFailures: boolean;
  goiAssociationMessageUidWorkerEnabled: boolean;
  reportChunkingHours: number;
  reportGlobalConcurrency?: BackendSystemSettingsItem['reportGlobalConcurrency'];
  reportKindConcurrency?: BackendSystemSettingsItem['reportKindConcurrency'];
  reportEtalonkaConcurrency?: BackendSystemSettingsItem['reportEtalonkaConcurrency'];
  limitBigReports: boolean;
  enableAudioTranscription: boolean;
  pelengBoundsEnabled: boolean;
  pelengBoundsTopLeftLat: number | null;
  pelengBoundsTopLeftLng: number | null;
  pelengBoundsBottomRightLat: number | null;
  pelengBoundsBottomRightLng: number | null;
  echoRestapiErrorDiscordWebhookUrl: string | null;
  signozMetricsEnabled?: BackendSystemSettingsItem['signozMetricsEnabled'];
  signozMetricsEndpoint?: BackendSystemSettingsItem['signozMetricsEndpoint'];
};

function normalizeItem(raw: SystemSettingsItemRaw): SystemSettingsItem {
  return {
    id: raw.id,
    rerAnalysisUnitsExactMatchOnlyDefault: raw.rer_analysis_units_exact_match_only_default,
    rerDutyTestEnabled: raw.rer_duty_test_enabled,
    rerDutyInsertHistoricalInterceptions: raw.rer_duty_insert_historical_interceptions,
    rerDutyTestSinceMs: raw.rer_duty_test_since_ms,
    rerDutyTestLimit: raw.rer_duty_test_limit,
    rerDutyPollIntervalSec: raw.rer_duty_poll_interval_sec,
    rerDutyTestReplayIntervalSec: raw.rer_duty_test_replay_interval_sec ?? 1,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    updatedBy: raw.updated_by ?? null,
    deleted: raw.deleted,
    rerShortUrlEnabled: raw.short_url_enabled,
    rerReportEnabled: raw.rer_report_enabled ?? false,
    supportNonRerInterceptions: raw.support_non_rer_interceptions ?? false,
    defaultNeoAnalysis: raw.default_neo_analysis ?? false,
    showClassicDuty: raw.show_classic_duty ?? true,
    showClassicAnalysis: raw.show_classic_analysis ?? true,
    showPelengDistanceToBattleline: raw.show_peleng_distance_to_battleline ?? false,
    disableBotTags: raw.disable_bot_tags ?? false,
    hideNetworks: raw.hide_networks ?? false,
    docMediaServeFromB2: raw.doc_media_serve_from_b2 ?? false,
    dutyExcludeMenuEnabled: raw.duty_exclude_menu_enabled ?? true,
    analysisAorFilterEnabled: raw.analysis_aor_filter_enabled ?? true,
    aiPositionHighlightsEnabled: raw.ai_position_highlights_enabled ?? false,
    dutySelectedGroupsEnabled: raw.duty_selected_groups_enabled ?? true,
    importantNotifyAllEnabled: raw.important_notify_all_enabled ?? true,
    apiRateLimitReplenishIntervalMs: raw.api_rate_limit_replenish_interval_ms ?? 500,
    apiRateLimitBurstSize: raw.api_rate_limit_burst_size ?? 5,
    twoFactorAuthEnabled: raw.two_factor_auth_enabled ?? true,
    excludeOrbitOtherUnits: raw.exclude_orbit_other_units ?? true,
    messengerMediaCacheMinFreeGib: raw.messenger_media_cache_min_free_gib ?? 10,
    messengerMediaCacheMaxSizeGib: raw.messenger_media_cache_max_size_gib ?? 32,
    messengerMediaCacheRetentionHours: raw.messenger_media_cache_retention_hours ?? 24,
    messengerMediaCacheEnabled: raw.messenger_media_cache_enabled ?? false,
    autofixEchoimMissingMessages: raw.autofix_echoim_missing_messages ?? false,
    devicesSectionEnabled: raw.devices_section_enabled ?? false,
    sigintCommentParsingEnabled: raw.sigint_comment_parsing_enabled ?? false,
    doNotStoreDuplicateEchoimFailures: raw.do_not_store_duplicate_echoim_failures ?? false,
    goiAssociationMessageUidWorkerEnabled: raw.goi_association_message_uid_worker_enabled ?? false,
    reportChunkingHours: raw.report_chunking_hours ?? 24,
    reportGlobalConcurrency: raw.report_global_concurrency ?? 4,
    reportKindConcurrency: raw.report_kind_concurrency ?? 1,
    reportEtalonkaConcurrency: raw.report_etalonka_concurrency ?? 2,
    limitBigReports: raw.limit_big_reports ?? false,
    enableAudioTranscription: raw.enable_audio_transcription ?? false,
    pelengBoundsEnabled: raw.peleng_bounds_enabled ?? false,
    pelengBoundsTopLeftLat: raw.peleng_bounds_top_left_lat ?? null,
    pelengBoundsTopLeftLng: raw.peleng_bounds_top_left_lng ?? null,
    pelengBoundsBottomRightLat: raw.peleng_bounds_bottom_right_lat ?? null,
    pelengBoundsBottomRightLng: raw.peleng_bounds_bottom_right_lng ?? null,
    echoRestapiErrorDiscordWebhookUrl: raw.echo_restapi_error_discord_webhook_url ?? null,
    signozMetricsEnabled: raw.signoz_metrics_enabled ?? false,
    signozMetricsEndpoint: raw.signoz_metrics_endpoint ?? null,
  };
}

function normalizeCurrent(raw: SystemSettingsCurrentRspRaw): SystemSettingsCurrent {
  return {
    id: raw.id ?? null,
    rerAnalysisUnitsExactMatchOnlyDefault: raw.rer_analysis_units_exact_match_only_default,
    rerDutyTestEnabled: raw.rer_duty_test_enabled,
    rerDutyInsertHistoricalInterceptions: raw.rer_duty_insert_historical_interceptions,
    rerDutyTestSinceMs: raw.rer_duty_test_since_ms,
    rerDutyTestLimit: raw.rer_duty_test_limit,
    rerDutyPollIntervalSec: raw.rer_duty_poll_interval_sec,
    rerDutyTestReplayIntervalSec: raw.rer_duty_test_replay_interval_sec ?? 1,
    rerShortUrlEnabled: raw.short_url_enabled,
    rerReportEnabled: raw.rer_report_enabled ?? false,
    supportNonRerInterceptions: raw.support_non_rer_interceptions ?? false,
    defaultNeoAnalysis: raw.default_neo_analysis ?? false,
    showClassicDuty: raw.show_classic_duty ?? true,
    showClassicAnalysis: raw.show_classic_analysis ?? true,
    showPelengDistanceToBattleline: raw.show_peleng_distance_to_battleline ?? false,
    hideOrbitData: raw.hide_orbit_data ?? false,
    disableBotTags: raw.disable_bot_tags ?? false,
    hideNetworks: raw.hide_networks ?? false,
    docMediaServeFromB2: raw.doc_media_serve_from_b2 ?? false,
    dutyExcludeMenuEnabled: raw.duty_exclude_menu_enabled ?? true,
    analysisAorFilterEnabled: raw.analysis_aor_filter_enabled ?? true,
    aiPositionHighlightsEnabled: raw.ai_position_highlights_enabled ?? false,
    dutySelectedGroupsEnabled: raw.duty_selected_groups_enabled ?? true,
    importantNotifyAllEnabled: raw.important_notify_all_enabled ?? true,
    apiRateLimitReplenishIntervalMs: raw.api_rate_limit_replenish_interval_ms ?? 500,
    apiRateLimitBurstSize: raw.api_rate_limit_burst_size ?? 5,
    twoFactorAuthEnabled: raw.two_factor_auth_enabled ?? true,
    excludeOrbitOtherUnits: raw.exclude_orbit_other_units ?? true,
    autofixEchoimMissingMessages: raw.autofix_echoim_missing_messages ?? false,
    devicesSectionEnabled: raw.devices_section_enabled ?? false,
    sigintCommentParsingEnabled: raw.sigint_comment_parsing_enabled ?? false,
    doNotStoreDuplicateEchoimFailures: raw.do_not_store_duplicate_echoim_failures ?? false,
    goiAssociationMessageUidWorkerEnabled: raw.goi_association_message_uid_worker_enabled ?? false,
    reportChunkingHours: raw.report_chunking_hours ?? 24,
    limitBigReports: raw.limit_big_reports ?? false,
    enableAudioTranscription: raw.enable_audio_transcription ?? false,
    pelengBoundsEnabled: raw.peleng_bounds_enabled ?? false,
    pelengBoundsTopLeftLat: raw.peleng_bounds_top_left_lat ?? null,
    pelengBoundsTopLeftLng: raw.peleng_bounds_top_left_lng ?? null,
    pelengBoundsBottomRightLat: raw.peleng_bounds_bottom_right_lat ?? null,
    pelengBoundsBottomRightLng: raw.peleng_bounds_bottom_right_lng ?? null,
  };
}

export async function listSystemSettings(): Promise<SystemSettingsItem[]> {
  const data = await postJson<SystemSettingsListRspRaw>('/api/admin/system-settings/list');
  return (data.items || []).map(normalizeItem);
}

export async function createSystemSettings(
  input: CreateSystemSettingsInput,
): Promise<SystemSettingsItem> {
  const req: CreateSystemSettingsReqRaw = {
    rer_analysis_units_exact_match_only_default: input.rerAnalysisUnitsExactMatchOnlyDefault,
    rer_duty_test_enabled: input.rerDutyTestEnabled,
    rer_duty_insert_historical_interceptions: input.rerDutyInsertHistoricalInterceptions,
    rer_duty_test_since_ms: input.rerDutyTestSinceMs,
    rer_duty_test_limit: input.rerDutyTestLimit,
    rer_duty_poll_interval_sec: input.rerDutyPollIntervalSec,
    rer_duty_test_replay_interval_sec: input.rerDutyTestReplayIntervalSec,
    short_url_enabled: input.rerDutyShortUrl,
    rer_report_enabled: input.rerReportEnabled,
    support_non_rer_interceptions: input.supportNonRerInterceptions,
    default_neo_analysis: input.defaultNeoAnalysis,
    show_classic_duty: input.showClassicDuty,
    show_classic_analysis: input.showClassicAnalysis,
    show_peleng_distance_to_battleline: input.showPelengDistanceToBattleline ?? false,
    disable_bot_tags: input.disableBotTags,
    hide_networks: input.hideNetworks,
    doc_media_serve_from_b2: input.docMediaServeFromB2 ?? false,
    duty_exclude_menu_enabled: input.dutyExcludeMenuEnabled ?? true,
    analysis_aor_filter_enabled: input.analysisAorFilterEnabled ?? true,
    ai_position_highlights_enabled: input.aiPositionHighlightsEnabled ?? false,
    duty_selected_groups_enabled: input.dutySelectedGroupsEnabled ?? null,
    important_notify_all_enabled: input.importantNotifyAllEnabled ?? null,
    api_rate_limit_replenish_interval_ms: input.apiRateLimitReplenishIntervalMs,
    api_rate_limit_burst_size: input.apiRateLimitBurstSize,
    two_factor_auth_enabled: input.twoFactorAuthEnabled ?? true,
    exclude_orbit_other_units: input.excludeOrbitOtherUnits ?? true,
    messenger_media_cache_min_free_gib: input.messengerMediaCacheMinFreeGib ?? 10,
    messenger_media_cache_max_size_gib: input.messengerMediaCacheMaxSizeGib ?? 32,
    messenger_media_cache_retention_hours: input.messengerMediaCacheRetentionHours ?? 24,
    messenger_media_cache_enabled: input.messengerMediaCacheEnabled ?? false,
    autofix_echoim_missing_messages: input.autofixEchoimMissingMessages,
    devices_section_enabled: input.devicesSectionEnabled,
    sigint_comment_parsing_enabled: input.sigintCommentParsingEnabled,
    do_not_store_duplicate_echoim_failures: input.doNotStoreDuplicateEchoimFailures,
    goi_association_message_uid_worker_enabled: input.goiAssociationMessageUidWorkerEnabled,
    report_chunking_hours: input.reportChunkingHours,
    report_global_concurrency: input.reportGlobalConcurrency,
    report_kind_concurrency: input.reportKindConcurrency,
    report_etalonka_concurrency: input.reportEtalonkaConcurrency,
    limit_big_reports: input.limitBigReports,
    enable_audio_transcription: input.enableAudioTranscription,
    peleng_bounds_enabled: input.pelengBoundsEnabled,
    peleng_bounds_top_left_lat: input.pelengBoundsTopLeftLat,
    peleng_bounds_top_left_lng: input.pelengBoundsTopLeftLng,
    peleng_bounds_bottom_right_lat: input.pelengBoundsBottomRightLat,
    peleng_bounds_bottom_right_lng: input.pelengBoundsBottomRightLng,
    echo_restapi_error_discord_webhook_url: input.echoRestapiErrorDiscordWebhookUrl,
    signoz_metrics_enabled: input.signozMetricsEnabled,
    signoz_metrics_endpoint: input.signozMetricsEndpoint,
  };
  const data = await postJson<SystemSettingsItemRaw>('/api/admin/system-settings/create', req);
  return normalizeItem(data);
}

export async function currentSystemSettings(): Promise<SystemSettingsCurrent> {
  const data = await postJson<SystemSettingsCurrentRspRaw>('/api/system-settings/current');
  return normalizeCurrent(data);
}

export async function activateSystemSettings(id: number): Promise<SystemSettingsItem> {
  const req: ActivateSystemSettingsReqRaw = { id };
  const data = await postJson<SystemSettingsItemRaw>('/api/admin/system-settings/activate', req);
  return normalizeItem(data);
}

export async function setRerReportEnabled(enabled: boolean): Promise<SystemSettingsItem> {
  const data = await postJson<SystemSettingsItemRaw>(
    '/api/admin/system-settings/rer-report-enabled',
    { enabled },
  );
  return normalizeItem(data);
}

type CleanupOrbitOtherUnitsRspRaw = {
  deleted_count: number;
  active_units: Array<{ id: number; name: string }>;
};

export type CleanupOrbitOtherUnitsRsp = {
  deletedCount: number;
  activeUnits: Array<{ id: number; name: string }>;
};

export async function cleanupOrbitOtherUnits(
  ignoreActive: boolean,
): Promise<CleanupOrbitOtherUnitsRsp> {
  const response = await postJson<CleanupOrbitOtherUnitsRspRaw>(
    '/api/admin/system-settings/orbit/cleanup-other-units',
    { ignore_active: ignoreActive },
  );
  return {
    deletedCount: response.deleted_count,
    activeUnits: response.active_units,
  };
}

type RerDutyTestReplayStatusRaw = {
  status: string;
  source_count: number;
  next_source_position: number | null;
  generated_count: number;
  next_emit_at_ms: number | null;
};

export type RerDutyTestReplayStatus = {
  status: string;
  sourceCount: number;
  nextSourcePosition: number | null;
  generatedCount: number;
  nextEmitAtMs: number | null;
};

export async function getRerDutyTestReplayStatus(): Promise<RerDutyTestReplayStatus> {
  const raw = await postJson<RerDutyTestReplayStatusRaw>(
    '/api/admin/system-settings/rer-duty-test-replay/status',
  );
  return {
    status: raw.status,
    sourceCount: raw.source_count,
    nextSourcePosition: raw.next_source_position,
    generatedCount: raw.generated_count,
    nextEmitAtMs: raw.next_emit_at_ms,
  };
}
