import { postJson } from './client';

type AorLocationConfigItemRaw = {
  aor_id: number;
  aor_name: string;
  selected_configs: string[];
};

type ListAorLocationConfigRspRaw = {
  available_configs: string[];
  items: AorLocationConfigItemRaw[];
};

type SaveAorLocationConfigReqRaw = {
  aor_id: number;
  settlements_configs: string[];
};

export type AorLocationConfigItem = {
  aorId: number;
  aorName: string;
  selectedConfigs: string[];
};

export type ListAorLocationConfigRsp = {
  availableConfigs: string[];
  items: AorLocationConfigItem[];
};

function normalizeItem(raw: AorLocationConfigItemRaw): AorLocationConfigItem {
  return {
    aorId: raw.aor_id,
    aorName: raw.aor_name,
    selectedConfigs: raw.selected_configs || [],
  };
}

export async function listAorLocationConfigs(): Promise<ListAorLocationConfigRsp> {
  const data = await postJson<ListAorLocationConfigRspRaw>('/api/admin/location-config/list');
  return {
    availableConfigs: data.available_configs || [],
    items: (data.items || []).map(normalizeItem),
  };
}

export async function saveAorLocationConfig(
  aorId: number,
  settlementsConfigs: string[],
): Promise<AorLocationConfigItem> {
  const req: SaveAorLocationConfigReqRaw = {
    aor_id: aorId,
    settlements_configs: settlementsConfigs,
  };
  const data = await postJson<AorLocationConfigItemRaw>('/api/admin/location-config/save', req);
  return normalizeItem(data);
}
