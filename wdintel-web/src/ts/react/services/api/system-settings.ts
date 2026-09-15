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
  support_non_rer_interceptions?: boolean;
  default_neo_analysis?: boolean;
  show_classic_duty?: boolean;
  show_classic_analysis?: boolean;
  show_peleng_distance_to_battleline?: boolean;
  disable_bot_tags?: boolean | null;
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
  echo_restapi_error_discord_webhook_url?: string | null;
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
  support_non_rer_interceptions?: boolean;
  default_neo_analysis?: boolean;
  show_classic_duty?: boolean;
  show_classic_analysis?: boolean;
  show_peleng_distance_to_battleline?: boolean;
  hide_orbit_data?: boolean;
  disable_bot_tags?: boolean | null;
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
  support_non_rer_interceptions: boolean;
  default_neo_analysis: boolean;
  show_classic_duty: boolean;
  show_classic_analysis: boolean;
  show_peleng_distance_to_battleline: boolean;
  disable_bot_tags: boolean;
  autofix_echoim_missing_messages: boolean;
  devices_section_enabled: boolean;
  sigint_comment_parsing_enabled: boolean;
  do_not_store_duplicate_echoim_failures: boolean;
  goi_association_message_uid_worker_enabled: boolean;
  report_chunking_hours: number;
  limit_big_reports: boolean;
  enable_audio_transcription: boolean;
  peleng_bounds_enabled: boolean;
  peleng_bounds_top_left_lat: number | null;
  peleng_bounds_top_left_lng: number | null;
  peleng_bounds_bottom_right_lat: number | null;
  peleng_bounds_bottom_right_lng: number | null;
  echo_restapi_error_discord_webhook_url: string | null;
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
  supportNonRerInterceptions: boolean;
  defaultNeoAnalysis: boolean;
  showClassicDuty: boolean;
  showClassicAnalysis: boolean;
  showPelengDistanceToBattleline: boolean;
  disableBotTags: boolean;
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
  echoRestapiErrorDiscordWebhookUrl: string | null;
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
  supportNonRerInterceptions: boolean;
  defaultNeoAnalysis: boolean;
  showClassicDuty: boolean;
  showClassicAnalysis: boolean;
  showPelengDistanceToBattleline: boolean;
  hideOrbitData: boolean;
  disableBotTags: boolean;
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
  supportNonRerInterceptions: boolean;
  defaultNeoAnalysis: boolean;
  showClassicDuty: boolean;
  showClassicAnalysis: boolean;
  showPelengDistanceToBattleline?: boolean;
  disableBotTags: boolean;
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
  echoRestapiErrorDiscordWebhookUrl: string | null;
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
    supportNonRerInterceptions: raw.support_non_rer_interceptions ?? false,
    defaultNeoAnalysis: raw.default_neo_analysis ?? false,
    showClassicDuty: raw.show_classic_duty ?? true,
    showClassicAnalysis: raw.show_classic_analysis ?? true,
    showPelengDistanceToBattleline: raw.show_peleng_distance_to_battleline ?? false,
    disableBotTags: raw.disable_bot_tags ?? false,
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
    echoRestapiErrorDiscordWebhookUrl: raw.echo_restapi_error_discord_webhook_url ?? null,
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
    supportNonRerInterceptions: raw.support_non_rer_interceptions ?? false,
    defaultNeoAnalysis: raw.default_neo_analysis ?? false,
    showClassicDuty: raw.show_classic_duty ?? true,
    showClassicAnalysis: raw.show_classic_analysis ?? true,
    showPelengDistanceToBattleline: raw.show_peleng_distance_to_battleline ?? false,
    hideOrbitData: raw.hide_orbit_data ?? false,
    disableBotTags: raw.disable_bot_tags ?? false,
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
    support_non_rer_interceptions: input.supportNonRerInterceptions,
    default_neo_analysis: input.defaultNeoAnalysis,
    show_classic_duty: input.showClassicDuty,
    show_classic_analysis: input.showClassicAnalysis,
    show_peleng_distance_to_battleline: input.showPelengDistanceToBattleline ?? false,
    disable_bot_tags: input.disableBotTags,
    autofix_echoim_missing_messages: input.autofixEchoimMissingMessages,
    devices_section_enabled: input.devicesSectionEnabled,
    sigint_comment_parsing_enabled: input.sigintCommentParsingEnabled,
    do_not_store_duplicate_echoim_failures: input.doNotStoreDuplicateEchoimFailures,
    goi_association_message_uid_worker_enabled: input.goiAssociationMessageUidWorkerEnabled,
    report_chunking_hours: input.reportChunkingHours,
    limit_big_reports: input.limitBigReports,
    enable_audio_transcription: input.enableAudioTranscription,
    peleng_bounds_enabled: input.pelengBoundsEnabled,
    peleng_bounds_top_left_lat: input.pelengBoundsTopLeftLat,
    peleng_bounds_top_left_lng: input.pelengBoundsTopLeftLng,
    peleng_bounds_bottom_right_lat: input.pelengBoundsBottomRightLat,
    peleng_bounds_bottom_right_lng: input.pelengBoundsBottomRightLng,
    echo_restapi_error_discord_webhook_url: input.echoRestapiErrorDiscordWebhookUrl,
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
