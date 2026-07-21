import { postJson } from './client';

type SystemSettingsItemRaw = {
  id: number;
  rer_analysis_units_exact_match_only_default: boolean;
  rer_duty_test_enabled: boolean;
  rer_duty_insert_historical_interceptions: boolean;
  rer_duty_test_since_ms: number;
  rer_duty_test_limit: number;
  rer_duty_poll_interval_sec: number;
  created_at: number;
  updated_at: number;
  updated_by?: string | null;
  deleted: boolean;
  short_url_enabled: boolean;
  support_non_rer_interceptions?: boolean;
  default_neo_analysis?: boolean;
  autofix_echoim_missing_messages?: boolean;
  devices_section_enabled?: boolean;
  sigint_comment_parsing_enabled?: boolean;
  do_not_store_duplicate_echoim_failures?: boolean;
  goi_association_message_uid_worker_enabled?: boolean;
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
  short_url_enabled: boolean;
  support_non_rer_interceptions?: boolean;
  default_neo_analysis?: boolean;
  autofix_echoim_missing_messages?: boolean;
  devices_section_enabled?: boolean;
  sigint_comment_parsing_enabled?: boolean;
  do_not_store_duplicate_echoim_failures?: boolean;
  goi_association_message_uid_worker_enabled?: boolean;
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
  short_url_enabled: boolean;
  support_non_rer_interceptions: boolean;
  default_neo_analysis: boolean;
  autofix_echoim_missing_messages: boolean;
  devices_section_enabled: boolean;
  sigint_comment_parsing_enabled: boolean;
  do_not_store_duplicate_echoim_failures: boolean;
  goi_association_message_uid_worker_enabled: boolean;
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
  createdAt: number;
  updatedAt: number;
  updatedBy: string | null;
  deleted: boolean;
  rerShortUrlEnabled: boolean;
  supportNonRerInterceptions: boolean;
  defaultNeoAnalysis: boolean;
  autofixEchoimMissingMessages: boolean;
  devicesSectionEnabled: boolean;
  sigintCommentParsingEnabled: boolean;
  doNotStoreDuplicateEchoimFailures: boolean;
  goiAssociationMessageUidWorkerEnabled: boolean;
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
  rerShortUrlEnabled: boolean;
  supportNonRerInterceptions: boolean;
  defaultNeoAnalysis: boolean;
  autofixEchoimMissingMessages: boolean;
  devicesSectionEnabled: boolean;
  sigintCommentParsingEnabled: boolean;
  doNotStoreDuplicateEchoimFailures: boolean;
  goiAssociationMessageUidWorkerEnabled: boolean;
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
  rerDutyShortUrl: boolean;
  supportNonRerInterceptions: boolean;
  defaultNeoAnalysis: boolean;
  autofixEchoimMissingMessages: boolean;
  devicesSectionEnabled: boolean;
  sigintCommentParsingEnabled: boolean;
  doNotStoreDuplicateEchoimFailures: boolean;
  goiAssociationMessageUidWorkerEnabled: boolean;
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
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    updatedBy: raw.updated_by ?? null,
    deleted: raw.deleted,
    rerShortUrlEnabled: raw.short_url_enabled,
    supportNonRerInterceptions: raw.support_non_rer_interceptions ?? false,
    defaultNeoAnalysis: raw.default_neo_analysis ?? false,
    autofixEchoimMissingMessages: raw.autofix_echoim_missing_messages ?? false,
    devicesSectionEnabled: raw.devices_section_enabled ?? false,
    sigintCommentParsingEnabled: raw.sigint_comment_parsing_enabled ?? false,
    doNotStoreDuplicateEchoimFailures: raw.do_not_store_duplicate_echoim_failures ?? false,
    goiAssociationMessageUidWorkerEnabled: raw.goi_association_message_uid_worker_enabled ?? false,
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
    rerShortUrlEnabled: raw.short_url_enabled,
    supportNonRerInterceptions: raw.support_non_rer_interceptions ?? false,
    defaultNeoAnalysis: raw.default_neo_analysis ?? false,
    autofixEchoimMissingMessages: raw.autofix_echoim_missing_messages ?? false,
    devicesSectionEnabled: raw.devices_section_enabled ?? false,
    sigintCommentParsingEnabled: raw.sigint_comment_parsing_enabled ?? false,
    doNotStoreDuplicateEchoimFailures: raw.do_not_store_duplicate_echoim_failures ?? false,
    goiAssociationMessageUidWorkerEnabled: raw.goi_association_message_uid_worker_enabled ?? false,
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
    short_url_enabled: input.rerDutyShortUrl,
    support_non_rer_interceptions: input.supportNonRerInterceptions,
    default_neo_analysis: input.defaultNeoAnalysis,
    autofix_echoim_missing_messages: input.autofixEchoimMissingMessages,
    devices_section_enabled: input.devicesSectionEnabled,
    sigint_comment_parsing_enabled: input.sigintCommentParsingEnabled,
    do_not_store_duplicate_echoim_failures: input.doNotStoreDuplicateEchoimFailures,
    goi_association_message_uid_worker_enabled: input.goiAssociationMessageUidWorkerEnabled,
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
