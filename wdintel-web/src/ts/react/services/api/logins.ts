import { DeactivationReasonType, ListLoginsReq, ListLoginsRsp, Login } from '../../../../Bindings';

import { postJson } from './client';

type ListLoginsReqBody = {
  sort_by: ListLoginsReq['sortBy'];
  filter_by_roles: ListLoginsReq['filterByRoles'];
};

type LoginLike = {
  login?: string;
  roles?: string[] | null;
  createdAt?: number;
  created_at?: number;
  deleted?: boolean;
  sigintZoneId?: number | null;
  sigint_zone_id?: number | null;
  sigintZoneName?: string | null;
  sigint_zone_name?: string | null;
  organismId?: number | null;
  organism_id?: number | null;
  organismName?: string | null;
  organism_name?: string | null;
  organismEnabled?: boolean | null;
  organism_enabled?: boolean | null;
  deltaLogin?: string | null;
  delta_login?: string | null;
  lastActiveAt?: number | null;
  last_active_at?: number | null;
  deactivationReason?: DeactivationReasonType | null;
  deactivation_reason?: DeactivationReasonType | null;
};

type ListLoginsRspLike = {
  users?: LoginLike[] | null;
};
function toListLoginsReqBody(req: ListLoginsReq): ListLoginsReqBody {
  return { sort_by: req.sortBy, filter_by_roles: req.filterByRoles };
}

function normalizeLogin(raw: LoginLike): Login {
  return {
    login: raw.login ?? '',
    roles: raw.roles ?? [],
    createdAt: raw.createdAt ?? raw.created_at ?? 0,
    deleted: raw.deleted ?? false,
    sigintZoneId: raw.sigintZoneId ?? raw.sigint_zone_id ?? null,
    sigintZoneName: raw.sigintZoneName ?? raw.sigint_zone_name ?? null,
    organismId: raw.organismId ?? raw.organism_id ?? null,
    organismName: raw.organismName ?? raw.organism_name ?? null,
    organismEnabled: raw.organismEnabled ?? raw.organism_enabled ?? null,
    deltaLogin: raw.deltaLogin ?? raw.delta_login ?? null,
    lastActiveAt: raw.lastActiveAt ?? raw.last_active_at ?? null,
    deactivationReason: raw.deactivationReason ?? raw.deactivation_reason ?? null,
  };
}

export async function listLogins(req: ListLoginsReq): Promise<ListLoginsRsp> {
  const data = await postJson<ListLoginsRspLike>('/api/logins', toListLoginsReqBody(req));
  return {
    users: (data?.users ?? []).map(normalizeLogin),
  };
}
