import {
  AddGroupToOrganismReq,
  CreateOrganismReq,
  ListOrganismsReq,
  Organism,
  OrganismGroup,
  RemoveGroupFromOrganismReq,
  SignalGroupFull,
  UpdateOrganismReq,
} from '../../../../Bindings';

import { postJson, postVoid } from './client';
import { isNullOrUndefined } from '../../utils/misc';
const GOI_SSH_PORT_DEFAULT = 22;
const GOI_API_PORT_DEFAULT = 8088;
const GOI_PATH_DEFAULT = '/etc/goi/data/palettes';
export const GOI_INTEGRATION_TYPE_SIMPLE = 'simple';
export const GOI_INTEGRATION_TYPE_FULL = 'full';

export type GoiIntegrationType =
  | typeof GOI_INTEGRATION_TYPE_SIMPLE
  | typeof GOI_INTEGRATION_TYPE_FULL;

type OrganismLike = {
  id?: number | string;
  parentId?: number | string | null;
  parent_id?: number | string | null;
  name?: string;
  createdAt?: number | string;
  created_at?: number | string;
  roles?: string[] | null;
  enabled?: boolean;
  aorIds?: Array<number | string> | null;
  aor_ids?: Array<number | string> | null;
  loginsCount?: number | string;
  logins_count?: number | string;
};

type SignalGroupFullLike = {
  name?: string;
  masterKey?: string;
  master_key?: string;
  originDatasourceId?: number | string;
  origin_datasource_id?: number | string;
};

type OrganismGroupLike = {
  masterKey?: string;
  master_key?: string;
  organismId?: number | string;
  organism_id?: number | string;
};

type OrganismGoiSettingsLike = {
  organismId?: number | string;
  organism_id?: number | string;
  integrationType?: GoiIntegrationType | string | null;
  integration_type?: GoiIntegrationType | string | null;
  sshHost?: string | null;
  ssh_host?: string | null;
  sshUser?: string | null;
  ssh_user?: string | null;
  sshPort?: number | string;
  ssh_port?: number | string;
  path?: string;
  apiHost?: string | null;
  api_host?: string | null;
  apiPort?: number | string;
  api_port?: number | string;
  apiLogin?: string | null;
  api_login?: string | null;
  apiPassword?: string | null;
  api_password?: string | null;
};

type ListOrganismsReqBody = {
  sort_by: ListOrganismsReq['sortBy'];
};

type CreateOrganismReqBody = {
  name: string;
  parent_id: number | null;
  roles: string[];
  aor_ids: number[] | null;
};

type UpdateOrganismReqBody = {
  id: number;
  parent_id: number | null;
  name: string | null;
  roles: string[] | null;
  enabled: boolean;
  aor_ids: number[] | null;
};

type AddGroupToOrganismReqBody = {
  organism_id: number;
  group_name: string;
};

type RemoveGroupFromOrganismReqBody = {
  organism_id: number;
  group_name: string;
};

type UpdateOrganismGoiSettingsReqBody = {
  organism_id: number;
  integration_type: GoiIntegrationType;
  ssh_host: string | null;
  ssh_user: string | null;
  ssh_port: number;
  path: string;
  api_host: string | null;
  api_port: number;
  api_login: string | null;
  api_password: string | null;
};

type SetupOrganismGoiWorkerReqBody = {
  organism_id: number;
  ssh_host: string;
  ssh_user: string;
  ssh_port: number;
  path: string;
  api_host: string | null;
  api_port: number;
};

type CheckOrganismGoiConnectionReqBody = {
  ssh_host: string;
  ssh_user: string;
  ssh_port: number;
  path: string;
};

type CheckOrganismGoiConnectionRspLike = {
  ok?: boolean;
  listedEntries?: string[];
  listed_entries?: string[];
  error?: string | null;
};

export type OrganismGoiSettings = {
  organismId: number;
  integrationType: GoiIntegrationType;
  sshHost: string;
  sshUser: string;
  sshPort: number;
  path: string;
  apiHost: string;
  apiPort: number;
  apiLogin: string;
  apiPassword: string;
};

export type UpdateOrganismGoiSettingsReq = OrganismGoiSettings;

export type SetupOrganismGoiWorkerReq = {
  organismId: number;
  sshHost: string;
  sshUser: string;
  sshPort: number;
  path: string;
  apiHost: string;
  apiPort: number;
};

export type CheckOrganismGoiConnectionReq = {
  sshHost: string;
  sshUser: string;
  sshPort: number;
  path: string;
};

export type CheckOrganismGoiConnectionRsp = {
  ok: boolean;
  listedEntries: string[];
  error: string | null;
};

function toListOrganismsReqBody(req: ListOrganismsReq): ListOrganismsReqBody {
  return { sort_by: req.sortBy };
}

function toCreateOrganismReqBody(req: CreateOrganismReq): CreateOrganismReqBody {
  return {
    name: req.name,
    parent_id: req.parentId,
    roles: req.roles,
    aor_ids: req.aorIds ?? null,
  };
}

function toUpdateOrganismReqBody(req: UpdateOrganismReq): UpdateOrganismReqBody {
  return {
    id: req.id,
    parent_id: req.parentId,
    name: req.name ?? null,
    roles: req.roles ?? null,
    enabled: req.enabled,
    aor_ids: req.aorIds ?? null,
  };
}

function toAddGroupReqBody(req: AddGroupToOrganismReq): AddGroupToOrganismReqBody {
  return {
    organism_id: req.organismId,
    group_name: req.groupName,
  };
}

function toRemoveGroupReqBody(req: RemoveGroupFromOrganismReq): RemoveGroupFromOrganismReqBody {
  return {
    organism_id: req.organismId,
    group_name: req.groupName,
  };
}

function toUpdateOrganismGoiSettingsReqBody(req: UpdateOrganismGoiSettingsReq): UpdateOrganismGoiSettingsReqBody {
  return {
    organism_id: req.organismId,
    integration_type: req.integrationType,
    ssh_host: req.sshHost.trim() ? req.sshHost.trim() : null,
    ssh_user: req.sshUser.trim() ? req.sshUser.trim() : null,
    ssh_port: req.sshPort,
    path: req.path,
    api_host: req.apiHost.trim() ? req.apiHost.trim() : null,
    api_port: req.apiPort,
    api_login: req.apiLogin.trim() ? req.apiLogin.trim() : null,
    api_password: req.apiPassword.trim() ? req.apiPassword.trim() : null,
  };
}

function toSetupOrganismGoiWorkerReqBody(req: SetupOrganismGoiWorkerReq): SetupOrganismGoiWorkerReqBody {
  return {
    organism_id: req.organismId,
    ssh_host: req.sshHost.trim(),
    ssh_user: req.sshUser.trim(),
    ssh_port: req.sshPort,
    path: req.path,
    api_host: req.apiHost.trim() ? req.apiHost.trim() : null,
    api_port: req.apiPort,
  };
}

function toCheckOrganismGoiConnectionReqBody(req: CheckOrganismGoiConnectionReq): CheckOrganismGoiConnectionReqBody {
  return {
    ssh_host: req.sshHost,
    ssh_user: req.sshUser,
    ssh_port: req.sshPort,
    path: req.path,
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

function normalizeNumberArray(values: Array<number | string> | null | undefined): number[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => normalizeOptionalNumber(value))
    .filter((value): value is number => value !== null);
}

function normalizeOrganism(raw: OrganismLike): Organism {
  return {
    id: normalizeNumber(raw.id),
    parentId: normalizeOptionalNumber(raw.parentId ?? raw.parent_id),
    name: raw.name ?? '',
    createdAt: normalizeNumber(raw.createdAt ?? raw.created_at),
    roles: raw.roles ?? [],
    enabled: raw.enabled ?? false,
    aorIds: normalizeNumberArray(raw.aorIds ?? raw.aor_ids),
    loginsCount: normalizeNumber(raw.loginsCount ?? raw.logins_count),
  };
}

function normalizeSignalGroup(raw: SignalGroupFullLike): SignalGroupFull {
  return {
    name: raw.name ?? '',
    masterKey: raw.masterKey ?? raw.master_key ?? '',
    originDatasourceId: normalizeNumber(raw.originDatasourceId ?? raw.origin_datasource_id),
  };
}

function normalizeOrganismGroup(raw: OrganismGroupLike): OrganismGroup {
  return {
    masterKey: raw.masterKey ?? raw.master_key ?? '',
    organismId: normalizeNumber(raw.organismId ?? raw.organism_id),
  };
}

function normalizeOrganismGoiSettings(raw: OrganismGoiSettingsLike): OrganismGoiSettings {
  const sshHost = (raw.sshHost ?? raw.ssh_host ?? '').trim();
  const integrationType = normalizeGoiIntegrationType(raw.integrationType ?? raw.integration_type);
  return {
    organismId: normalizeNumber(raw.organismId ?? raw.organism_id),
    integrationType,
    sshHost,
    sshUser: (raw.sshUser ?? raw.ssh_user ?? '').trim(),
    sshPort: normalizeOptionalNumber(raw.sshPort ?? raw.ssh_port) ?? GOI_SSH_PORT_DEFAULT,
    path: (raw.path ?? GOI_PATH_DEFAULT).trim() || GOI_PATH_DEFAULT,
    apiHost: (raw.apiHost ?? raw.api_host ?? sshHost).trim(),
    apiPort: normalizeOptionalNumber(raw.apiPort ?? raw.api_port) ?? GOI_API_PORT_DEFAULT,
    apiLogin: (raw.apiLogin ?? raw.api_login ?? '').trim(),
    apiPassword: (raw.apiPassword ?? raw.api_password ?? '').trim(),
  };
}

function normalizeGoiIntegrationType(value: GoiIntegrationType | string | null | undefined): GoiIntegrationType {
  return value === GOI_INTEGRATION_TYPE_SIMPLE
    ? GOI_INTEGRATION_TYPE_SIMPLE
    : GOI_INTEGRATION_TYPE_FULL;
}

export async function listOrganisms(req: ListOrganismsReq): Promise<Organism[]> {
  const data = await postJson<OrganismLike[]>('/api/organisms', toListOrganismsReqBody(req));
  return (data || []).map(normalizeOrganism);
}

export async function createOrganism(req: CreateOrganismReq): Promise<Organism> {
  const data = await postJson<OrganismLike>('/api/organism/create', toCreateOrganismReqBody(req));
  return normalizeOrganism(data);
}

export async function updateOrganism(req: UpdateOrganismReq): Promise<Organism> {
  const data = await postJson<OrganismLike>('/api/organism/update', toUpdateOrganismReqBody(req));
  return normalizeOrganism(data);
}

export async function deleteOrganism(organismId: number): Promise<void> {
  await postVoid('/api/organism/delete', organismId);
}

export async function listSignalGroups(): Promise<SignalGroupFull[]> {
  const data = await postJson<SignalGroupFullLike[]>('/api/organism/all-groups');
  return (data || []).map(normalizeSignalGroup);
}

export async function listOrganismGroups(): Promise<OrganismGroup[]> {
  const data = await postJson<OrganismGroupLike[]>('/api/organism/group-list');
  return (data || []).map(normalizeOrganismGroup);
}

export async function listAvailableGroups(organismId: number): Promise<SignalGroupFull[]> {
  const data = await postJson<SignalGroupFullLike[]>('/api/organism/available-groups', organismId);
  return (data || []).map(normalizeSignalGroup);
}

export async function listAvailableGroupsBatch(
  organismIds: number[],
): Promise<Map<number, SignalGroupFull[]>> {
  const data = await postJson<Record<string, SignalGroupFullLike[]>>(
    '/api/organism/available-groups-batch',
    organismIds,
  );
  const result = new Map<number, SignalGroupFull[]>();
  Object.entries(data || {}).forEach(([key, groups]) => {
    const parsedId = Number(key);
    if (!Number.isFinite(parsedId)) return;
    result.set(parsedId, (groups || []).map(normalizeSignalGroup));
  });
  return result;
}

export async function computeAvailableGroups(req: UpdateOrganismReq): Promise<SignalGroupFull[]> {
  const data = await postJson<SignalGroupFullLike[]>('/api/organism/compute-available-groups', toUpdateOrganismReqBody(req));
  return (data || []).map(normalizeSignalGroup);
}

export async function computeAvailableGroupsForNew(req: CreateOrganismReq): Promise<SignalGroupFull[]> {
  const data = await postJson<SignalGroupFullLike[]>('/api/organism/compute-available-groups-for-new', toCreateOrganismReqBody(req));
  return (data || []).map(normalizeSignalGroup);
}

export async function listActiveLogins(organismId: number): Promise<string[]> {
  return postJson<string[]>('/api/organism/active-logins', organismId);
}

export async function listOrganismLogins(): Promise<string[]> {
  return postJson<string[]>('/api/organism/list-logins');
}

export async function addGroupToOrganism(req: AddGroupToOrganismReq): Promise<void> {
  await postVoid('/api/organism/add-group', toAddGroupReqBody(req));
}

export async function removeGroupFromOrganism(req: RemoveGroupFromOrganismReq): Promise<void> {
  await postVoid('/api/organism/remove-group', toRemoveGroupReqBody(req));
}

export async function getOrganismGoiSettings(organismId: number): Promise<OrganismGoiSettings> {
  const data = await postJson<OrganismGoiSettingsLike>('/api/organism/goi-settings', organismId);
  return normalizeOrganismGoiSettings(data || {});
}

export async function updateOrganismGoiSettings(req: UpdateOrganismGoiSettingsReq): Promise<OrganismGoiSettings> {
  const data = await postJson<OrganismGoiSettingsLike>(
    '/api/organism/goi-settings/update',
    toUpdateOrganismGoiSettingsReqBody(req),
  );
  return normalizeOrganismGoiSettings(data || {});
}

export async function setupOrganismGoiWorker(req: SetupOrganismGoiWorkerReq): Promise<OrganismGoiSettings> {
  const data = await postJson<OrganismGoiSettingsLike>(
    '/api/organism/goi-settings/setup-worker',
    toSetupOrganismGoiWorkerReqBody(req),
  );
  return normalizeOrganismGoiSettings(data || {});
}

export async function checkOrganismGoiConnection(
  req: CheckOrganismGoiConnectionReq,
): Promise<CheckOrganismGoiConnectionRsp> {
  const data = await postJson<CheckOrganismGoiConnectionRspLike>(
    '/api/organism/goi-settings/check-connection',
    toCheckOrganismGoiConnectionReqBody(req),
  );
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return {
      ok: false,
      listedEntries: [],
      error: 'Некоректна відповідь сервера',
    };
  }
  const parsedOk = typeof data.ok === 'boolean' ? data.ok : null;
  const error = (data && typeof data.error === 'string' && data.error.trim().length > 0)
    ? data.error.trim()
    : null;
  return {
    ok: parsedOk ?? (error === null),
    listedEntries: data?.listedEntries ?? data?.listed_entries ?? [],
    error,
  };
}
