import { postJson } from './client';

type SystemSettingsItemRaw = {
  id: number;
  rer_analysis_units_exact_match_only_default: boolean;
  rer_duty_random_enabled: boolean;
  rer_duty_random_interval_sec: number;
  created_at: number;
  updated_at: number;
  updated_by?: string | null;
  deleted: boolean;
};

type SystemSettingsCurrentRspRaw = {
  id: number | null;
  rer_analysis_units_exact_match_only_default: boolean;
  rer_duty_random_enabled: boolean;
  rer_duty_random_interval_sec: number;
};

type SystemSettingsListRspRaw = {
  items: SystemSettingsItemRaw[];
};

type CreateSystemSettingsReqRaw = {
  rer_analysis_units_exact_match_only_default: boolean;
  rer_duty_random_enabled: boolean;
  rer_duty_random_interval_sec: number;
};

type ActivateSystemSettingsReqRaw = {
  id: number;
};

export type SystemSettingsItem = {
  id: number;
  rerAnalysisUnitsExactMatchOnlyDefault: boolean;
  rerDutyRandomEnabled: boolean;
  rerDutyRandomIntervalSec: number;
  createdAt: number;
  updatedAt: number;
  updatedBy: string | null;
  deleted: boolean;
};

export type SystemSettingsCurrent = {
  id: number | null;
  rerAnalysisUnitsExactMatchOnlyDefault: boolean;
  rerDutyRandomEnabled: boolean;
  rerDutyRandomIntervalSec: number;
};

function normalizeItem(raw: SystemSettingsItemRaw): SystemSettingsItem {
  return {
    id: raw.id,
    rerAnalysisUnitsExactMatchOnlyDefault:
      raw.rer_analysis_units_exact_match_only_default,
    rerDutyRandomEnabled: raw.rer_duty_random_enabled,
    rerDutyRandomIntervalSec: raw.rer_duty_random_interval_sec,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    updatedBy: raw.updated_by ?? null,
    deleted: raw.deleted,
  };
}

function normalizeCurrent(raw: SystemSettingsCurrentRspRaw): SystemSettingsCurrent {
  return {
    id: raw.id ?? null,
    rerAnalysisUnitsExactMatchOnlyDefault:
      raw.rer_analysis_units_exact_match_only_default,
    rerDutyRandomEnabled: raw.rer_duty_random_enabled,
    rerDutyRandomIntervalSec: raw.rer_duty_random_interval_sec,
  };
}

export async function listSystemSettings(): Promise<SystemSettingsItem[]> {
  const data = await postJson<SystemSettingsListRspRaw>(
    '/api/admin/system-settings/list',
  );
  return (data.items || []).map(normalizeItem);
}

export async function createSystemSettings(
  rerAnalysisUnitsExactMatchOnlyDefault: boolean,
  rerDutyRandomEnabled: boolean,
  rerDutyRandomIntervalSec: number,
): Promise<SystemSettingsItem> {
  const req: CreateSystemSettingsReqRaw = {
    rer_analysis_units_exact_match_only_default:
      rerAnalysisUnitsExactMatchOnlyDefault,
    rer_duty_random_enabled: rerDutyRandomEnabled,
    rer_duty_random_interval_sec: rerDutyRandomIntervalSec,
  };
  const data = await postJson<SystemSettingsItemRaw>(
    '/api/admin/system-settings/create',
    req,
  );
  return normalizeItem(data);
}

export async function currentSystemSettings(): Promise<SystemSettingsCurrent> {
  const data = await postJson<SystemSettingsCurrentRspRaw>(
    '/api/system-settings/current',
  );
  return normalizeCurrent(data);
}

export async function activateSystemSettings(
  id: number,
): Promise<SystemSettingsItem> {
  const req: ActivateSystemSettingsReqRaw = { id };
  const data = await postJson<SystemSettingsItemRaw>(
    '/api/admin/system-settings/activate',
    req,
  );
  return normalizeItem(data);
}
