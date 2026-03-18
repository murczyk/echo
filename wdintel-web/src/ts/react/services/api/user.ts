import { SettingsSaveReq, User } from '../../../../Bindings';

import { getJson, postVoid } from './client';

type UserLike = {
  name?: string;
  roles?: string[] | null;
  sigintZoneId?: number | null;
  sigint_zone_id?: number | null;
  organismId?: number | null;
  organism_id?: number | null;
  deltaLogin?: string | null;
  delta_login?: string | null;
  goiConfiguredForOrganism?: boolean;
  goi_configured_for_organism?: boolean;
  goiHost?: string | null;
  goi_host?: string | null;
};

type SettingsSaveReqBody = {
  sigint_zone_id: number | null;
};

function normalizeUser(raw: UserLike | null | undefined): User {
  return {
    name: raw?.name ?? '',
    roles: raw?.roles ?? [],
    sigintZoneId: raw?.sigintZoneId ?? raw?.sigint_zone_id ?? null,
    organismId: raw?.organismId ?? raw?.organism_id ?? null,
    deltaLogin: raw?.deltaLogin ?? raw?.delta_login ?? null,
    goiConfiguredForOrganism:
      raw?.goiConfiguredForOrganism ?? raw?.goi_configured_for_organism ?? false,
    goiHost: raw?.goiHost ?? raw?.goi_host ?? null,
  };
}

function toSettingsSaveReqBody(req: SettingsSaveReq): SettingsSaveReqBody {
  return {
    sigint_zone_id: req.sigintZoneId,
  };
}

export async function fetchCurrentUser(signal?: AbortSignal): Promise<User> {
  const data = await getJson<UserLike>('/api/user', { signal });
  return normalizeUser(data ?? {});
}

export async function saveUserSettings(req: SettingsSaveReq): Promise<void> {
  await postVoid('/api/user/settings-save', toSettingsSaveReqBody(req));
}

export async function logoutCurrentUser(): Promise<void> {
  await getJson<unknown>('/api/user/logout');
}
