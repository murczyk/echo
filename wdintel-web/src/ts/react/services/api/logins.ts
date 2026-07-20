import {
  CreateLoginReq,
  DeactivationReasonType,
  ListLoginsReq,
  ListLoginsRsp,
  Login,
  UpdateLoginReq,
} from '../../../../Bindings';

import { postJson } from './client';
import { isNullOrUndefined } from '../../utils/misc';
type ListLoginsReqBody = {
  sort_by: ListLoginsReq['sortBy'];
  filter_by_roles: ListLoginsReq['filterByRoles'];
};

type CreateLoginReqBody = {
  login: string;
  password: string;
  roles: string[];
  sigint_zone_id: number | null;
  organism_id: number;
  description: string | null;
};

type UpdateLoginReqBody = {
  id: string;
  login: string;
  roles: string[] | null;
  sigint_zone_id: number | null;
  organism_id: number;
  deleted: boolean | null;
  password: string | null;
  delta_login: string | null;
  deactivation_reason: DeactivationReasonType | null;
  description: string | null;
};

type LoginLike = {
  id?: string;
  login?: string;
  roles?: string[] | null;
  createdAt?: number | string;
  created_at?: number | string;
  deleted?: boolean;
  sigintZoneId?: number | string | null;
  sigint_zone_id?: number | string | null;
  sigintZoneName?: string | null;
  sigint_zone_name?: string | null;
  organismId?: number | string | null;
  organism_id?: number | string | null;
  organismName?: string | null;
  organism_name?: string | null;
  organismEnabled?: boolean | null;
  organism_enabled?: boolean | null;
  deltaLogin?: string | null;
  delta_login?: string | null;
  lastActiveAt?: number | string | null;
  last_active_at?: number | string | null;
  deactivationReason?: DeactivationReasonType | null;
  deactivation_reason?: DeactivationReasonType | null;
  description?: string | null;
};

type ListLoginsRspLike = {
  users?: LoginLike[] | null;
};
function toListLoginsReqBody(req: ListLoginsReq): ListLoginsReqBody {
  return { sort_by: req.sortBy, filter_by_roles: req.filterByRoles };
}

function toCreateLoginReqBody(req: CreateLoginReq): CreateLoginReqBody {
  return {
    login: req.login,
    password: req.password,
    roles: req.roles,
    sigint_zone_id: req.sigintZoneId,
    organism_id: req.organismId,
    description: req.description,
  };
}

function toUpdateLoginReqBody(req: UpdateLoginReq): UpdateLoginReqBody {
  return {
    id: req.id,
    login: req.login,
    roles: req.roles,
    sigint_zone_id: req.sigintZoneId,
    organism_id: req.organismId,
    deleted: req.deleted,
    password: req.password,
    delta_login: req.deltaLogin,
    deactivation_reason: req.deactivationReason,
    description: req.description,
  };
}

function normalizeNumber(value: number | string | null | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function normalizeOptionalNumber(value: number | string | null | undefined): number | null {
  if (isNullOrUndefined(value)) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeLogin(raw: LoginLike): Login {
  return {
    id: raw.id ?? '',
    login: raw.login ?? '',
    roles: raw.roles ?? [],
    createdAt: normalizeNumber(raw.createdAt ?? raw.created_at),
    deleted: raw.deleted ?? false,
    sigintZoneId: normalizeOptionalNumber(raw.sigintZoneId ?? raw.sigint_zone_id),
    sigintZoneName: raw.sigintZoneName ?? raw.sigint_zone_name ?? null,
    organismId: normalizeOptionalNumber(raw.organismId ?? raw.organism_id),
    organismName: raw.organismName ?? raw.organism_name ?? null,
    organismEnabled: raw.organismEnabled ?? raw.organism_enabled ?? null,
    deltaLogin: raw.deltaLogin ?? raw.delta_login ?? null,
    lastActiveAt: normalizeOptionalNumber(raw.lastActiveAt ?? raw.last_active_at),
    deactivationReason: raw.deactivationReason ?? raw.deactivation_reason ?? null,
    description: raw.description ?? null,
  };
}

export async function listLogins(req: ListLoginsReq): Promise<ListLoginsRsp> {
  const data = await postJson<ListLoginsRspLike>('/api/logins', toListLoginsReqBody(req));
  return {
    users: (data?.users ?? []).map(normalizeLogin),
  };
}

export async function createLogin(req: CreateLoginReq): Promise<Login> {
  const data = await postJson<LoginLike>('/api/login/create', toCreateLoginReqBody(req));
  return normalizeLogin(data ?? {});
}

export async function createLoginDelta(req: CreateLoginReq): Promise<Login> {
  const data = await postJson<LoginLike>('/api/login/create-delta', toCreateLoginReqBody(req));
  return normalizeLogin(data ?? {});
}

export async function updateLogin(req: UpdateLoginReq): Promise<Login> {
  const data = await postJson<LoginLike>('/api/login/update', toUpdateLoginReqBody(req));
  return normalizeLogin(data ?? {});
}
