import {
  CreateLoginReq,
  MessengerProfileSearchReq,
  SignalProfilesRsp,
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
  password: string | null;
  roles: string[];
  sigint_zone_id: number | null;
  organism_id: number;
  signal_profile_id: CreateLoginReq['signalProfileId'];
  description: string | null;
  delta_login?: string | null;
  password_auth_enabled?: boolean | null;
};

export type UpdateLoginPatch = Pick<UpdateLoginReq, 'id' | 'login' | 'organismId'> &
  Partial<Omit<UpdateLoginReq, 'id' | 'login' | 'organismId'>>;

type UpdateLoginReqBody = {
  id: string;
  login: string;
  roles?: string[] | null;
  sigint_zone_id?: number | null;
  organism_id: number;
  signal_profile_id?: UpdateLoginReq['signalProfileId'];
  deleted?: boolean | null;
  password?: string | null;
  delta_login?: string | null;
  deactivation_reason?: DeactivationReasonType | null;
  description?: string | null;
  password_auth_enabled?: boolean | null;
  clear_totp?: boolean | null;
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
  signalProfileId?: Login['signalProfileId'];
  signal_profile_id?: Login['signalProfileId'];
  description?: string | null;
  passwordAuthEnabled?: boolean;
  password_auth_enabled?: boolean;
  hasPassword?: boolean;
  has_password?: boolean;
  totpEnabled?: boolean;
  totp_enabled?: boolean;
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
    signal_profile_id: req.signalProfileId,
    description: req.description,
    ...(req.deltaLogin === undefined ? {} : { delta_login: req.deltaLogin }),
    ...(req.passwordAuthEnabled === undefined
      ? {}
      : { password_auth_enabled: req.passwordAuthEnabled }),
  };
}

function toUpdateLoginReqBody(req: UpdateLoginPatch): UpdateLoginReqBody {
  return {
    id: req.id,
    login: req.login,
    ...(req.roles === undefined ? {} : { roles: req.roles }),
    ...(req.sigintZoneId === undefined ? {} : { sigint_zone_id: req.sigintZoneId }),
    organism_id: req.organismId,
    ...(req.signalProfileId === undefined ? {} : { signal_profile_id: req.signalProfileId }),
    ...(req.deleted === undefined ? {} : { deleted: req.deleted }),
    ...(req.password === undefined ? {} : { password: req.password }),
    ...(req.deltaLogin === undefined ? {} : { delta_login: req.deltaLogin }),
    ...(req.deactivationReason === undefined
      ? {}
      : { deactivation_reason: req.deactivationReason }),
    ...(req.description === undefined ? {} : { description: req.description }),
    ...(req.passwordAuthEnabled === undefined
      ? {}
      : { password_auth_enabled: req.passwordAuthEnabled }),
    ...(req.clearTotp === undefined ? {} : { clear_totp: req.clearTotp }),
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
    signalProfileId: raw.signalProfileId ?? raw.signal_profile_id ?? null,
    description: raw.description ?? null,
    passwordAuthEnabled: raw.passwordAuthEnabled ?? raw.password_auth_enabled ?? true,
    hasPassword: raw.hasPassword ?? raw.has_password ?? false,
    totpEnabled: raw.totpEnabled ?? raw.totp_enabled ?? false,
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

export async function updateLogin(req: UpdateLoginPatch): Promise<Login> {
  const data = await postJson<LoginLike>('/api/login/update', toUpdateLoginReqBody(req));
  return normalizeLogin(data ?? {});
}

export async function searchMessengerProfiles(
  req: MessengerProfileSearchReq,
  signal?: AbortSignal,
): Promise<SignalProfilesRsp> {
  const response = await postJson<{
    data: Record<string, { given_name?: string | null; family_name?: string | null } | null>;
  }>('/api/users/messenger-profiles', req, { signal });
  return {
    data: Object.fromEntries(
      Object.entries(response.data).map(([id, profile]) => [
        id,
        profile
          ? { givenName: profile.given_name ?? null, familyName: profile.family_name ?? null }
          : null,
      ]),
    ),
  };
}
