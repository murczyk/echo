import { postJson } from './client';

type SystemSettingsItemRaw = {
  id: number;
  rer_analysis_units_exact_match_only_default: boolean;
  created_at: number;
  updated_at: number;
  updated_by?: string | null;
  deleted: boolean;
};

type SystemSettingsListRspRaw = {
  items: SystemSettingsItemRaw[];
};

type CreateSystemSettingsReqRaw = {
  rer_analysis_units_exact_match_only_default: boolean;
};

type ActivateSystemSettingsReqRaw = {
  id: number;
};

export type SystemSettingsItem = {
  id: number;
  rerAnalysisUnitsExactMatchOnlyDefault: boolean;
  createdAt: number;
  updatedAt: number;
  updatedBy: string | null;
  deleted: boolean;
};

function normalizeItem(raw: SystemSettingsItemRaw): SystemSettingsItem {
  return {
    id: raw.id,
    rerAnalysisUnitsExactMatchOnlyDefault:
      raw.rer_analysis_units_exact_match_only_default,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    updatedBy: raw.updated_by ?? null,
    deleted: raw.deleted,
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
): Promise<SystemSettingsItem> {
  const req: CreateSystemSettingsReqRaw = {
    rer_analysis_units_exact_match_only_default:
      rerAnalysisUnitsExactMatchOnlyDefault,
  };
  const data = await postJson<SystemSettingsItemRaw>(
    '/api/admin/system-settings/create',
    req,
  );
  return normalizeItem(data);
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
