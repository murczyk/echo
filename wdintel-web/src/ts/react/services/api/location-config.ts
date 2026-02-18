import { postJson } from './client';

type AorLocationConfigItemRaw = {
  aor_id: number;
  aor_name: string;
  selected_config: string | null;
};

type ListAorLocationConfigRspRaw = {
  available_configs: string[];
  items: AorLocationConfigItemRaw[];
};

type SaveAorLocationConfigReqRaw = {
  aor_id: number;
  settlements_config: string;
};

export type AorLocationConfigItem = {
  aorId: number;
  aorName: string;
  selectedConfig: string | null;
};

export type ListAorLocationConfigRsp = {
  availableConfigs: string[];
  items: AorLocationConfigItem[];
};

function normalizeItem(raw: AorLocationConfigItemRaw): AorLocationConfigItem {
  return {
    aorId: raw.aor_id,
    aorName: raw.aor_name,
    selectedConfig: raw.selected_config,
  };
}

export async function listAorLocationConfigs(): Promise<ListAorLocationConfigRsp> {
  const data = await postJson<ListAorLocationConfigRspRaw>('/api/admin/location-config/list');
  return {
    availableConfigs: data.available_configs || [],
    items: (data.items || []).map(normalizeItem),
  };
}

export async function saveAorLocationConfig(aorId: number, settlementsConfig: string): Promise<AorLocationConfigItem> {
  const req: SaveAorLocationConfigReqRaw = {
    aor_id: aorId,
    settlements_config: settlementsConfig,
  };
  const data = await postJson<AorLocationConfigItemRaw>('/api/admin/location-config/save', req);
  return normalizeItem(data);
}
