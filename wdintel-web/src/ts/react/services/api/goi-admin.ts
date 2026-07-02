import { postJson, postVoid } from './client';
import {
  GOI_INTEGRATION_TYPE_FULL,
  GOI_INTEGRATION_TYPE_SIMPLE,
  type GoiIntegrationType,
} from './organisms';

export type GoiAdminIntegration = {
  id: number;
  ownerOrganismId: number;
  ownerOrganismName: string;
  createdAtMs: number;
  integrationType: GoiIntegrationType;
  serverLabel: string;
  sshHost: string;
  sshUser: string;
  sshPort: number;
  path: string;
  apiHost: string;
  apiPort: number;
  apiLogin: string;
  apiPassword: string;
  accessOrganismIds: number[];
  accessLogins: string[];
};

export type UpsertGoiAdminIntegrationReq = {
  id?: number | null;
  ownerOrganismId: number;
  integrationType: GoiIntegrationType;
  sshHost: string;
  sshUser: string;
  sshPort: number;
  path: string;
  apiHost: string;
  apiPort: number;
  apiLogin: string;
  apiPassword: string;
  accessOrganismIds: number[];
  accessLogins: string[];
};

export type CheckGoiConnectionReq = {
  sshHost: string;
  sshUser: string;
  sshPort: number;
  path: string;
};

export type CheckGoiConnectionRsp = {
  ok: boolean;
  listedEntries: string[];
  error: string | null;
};

export type SetupGoiIntegrationWorkerReq = {
  id: number;
  sshHost: string;
  sshUser: string;
  sshPort: number;
  path: string;
  apiHost: string;
  apiPort: number;
};

type GoiAdminIntegrationLike = {
  id?: number | string;
  ownerOrganismId?: number | string;
  owner_organism_id?: number | string;
  ownerOrganismName?: string;
  owner_organism_name?: string;
  createdAtMs?: number | string;
  created_at_ms?: number | string;
  integrationType?: GoiIntegrationType | string | null;
  integration_type?: GoiIntegrationType | string | null;
  serverLabel?: string;
  server_label?: string;
  sshHost?: string | null;
  ssh_host?: string | null;
  sshUser?: string | null;
  ssh_user?: string | null;
  sshPort?: number | string;
  ssh_port?: number | string;
  path?: string | null;
  apiHost?: string | null;
  api_host?: string | null;
  apiPort?: number | string;
  api_port?: number | string;
  apiLogin?: string | null;
  api_login?: string | null;
  apiPassword?: string | null;
  api_password?: string | null;
  accessOrganismIds?: Array<number | string> | null;
  access_organism_ids?: Array<number | string> | null;
  accessLogins?: string[] | null;
  access_logins?: string[] | null;
};

type ListGoiAdminIntegrationsRspLike = {
  items?: GoiAdminIntegrationLike[] | null;
};

type CheckGoiConnectionRspLike = {
  ok?: boolean;
  listedEntries?: string[] | null;
  listed_entries?: string[] | null;
  error?: string | null;
};

function normalizeNumber(value: number | string | null | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function normalizeNumberArray(values: Array<number | string> | null | undefined): number[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => normalizeNumber(value))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function normalizeString(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStringArray(value: string[] | null | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => normalizeString(item)).filter(Boolean);
}

function normalizeGoiIntegrationType(
  value: GoiIntegrationType | string | null | undefined,
): GoiIntegrationType {
  return value === GOI_INTEGRATION_TYPE_SIMPLE
    ? GOI_INTEGRATION_TYPE_SIMPLE
    : GOI_INTEGRATION_TYPE_FULL;
}

function normalizeGoiAdminIntegration(
  raw: GoiAdminIntegrationLike | null | undefined,
): GoiAdminIntegration {
  return {
    id: normalizeNumber(raw?.id),
    ownerOrganismId: normalizeNumber(raw?.ownerOrganismId ?? raw?.owner_organism_id),
    ownerOrganismName: normalizeString(raw?.ownerOrganismName ?? raw?.owner_organism_name),
    createdAtMs: normalizeNumber(raw?.createdAtMs ?? raw?.created_at_ms),
    integrationType: normalizeGoiIntegrationType(raw?.integrationType ?? raw?.integration_type),
    serverLabel: normalizeString(raw?.serverLabel ?? raw?.server_label),
    sshHost: normalizeString(raw?.sshHost ?? raw?.ssh_host),
    sshUser: normalizeString(raw?.sshUser ?? raw?.ssh_user),
    sshPort: normalizeNumber(raw?.sshPort ?? raw?.ssh_port) || 22,
    path: normalizeString(raw?.path) || '/etc/goi/data/palettes',
    apiHost: normalizeString(raw?.apiHost ?? raw?.api_host),
    apiPort: normalizeNumber(raw?.apiPort ?? raw?.api_port) || 8088,
    apiLogin: normalizeString(raw?.apiLogin ?? raw?.api_login),
    apiPassword: normalizeString(raw?.apiPassword ?? raw?.api_password),
    accessOrganismIds: normalizeNumberArray(raw?.accessOrganismIds ?? raw?.access_organism_ids),
    accessLogins: normalizeStringArray(raw?.accessLogins ?? raw?.access_logins),
  };
}

function toUpsertReqBody(req: UpsertGoiAdminIntegrationReq) {
  return {
    id: req.id ?? null,
    owner_organism_id: req.ownerOrganismId,
    integration_type: req.integrationType,
    ssh_host: normalizeString(req.sshHost) || null,
    ssh_user: normalizeString(req.sshUser) || null,
    ssh_port: req.sshPort,
    path: req.path,
    api_host: normalizeString(req.apiHost) || null,
    api_port: req.apiPort,
    api_login: normalizeString(req.apiLogin) || null,
    api_password: normalizeString(req.apiPassword) || null,
    access_organism_ids: req.accessOrganismIds,
    access_logins: req.accessLogins,
  };
}

function toCheckReqBody(req: CheckGoiConnectionReq) {
  return {
    ssh_host: req.sshHost,
    ssh_user: req.sshUser,
    ssh_port: req.sshPort,
    path: req.path,
  };
}

function toSetupWorkerReqBody(req: SetupGoiIntegrationWorkerReq) {
  return {
    id: req.id,
    ssh_host: req.sshHost,
    ssh_user: req.sshUser,
    ssh_port: req.sshPort,
    path: req.path,
    api_host: normalizeString(req.apiHost) || null,
    api_port: req.apiPort,
  };
}

export async function listGoiAdminIntegrations(): Promise<GoiAdminIntegration[]> {
  const data = await postJson<ListGoiAdminIntegrationsRspLike>('/api/admin/goi/integrations');
  return (data?.items ?? []).map(normalizeGoiAdminIntegration);
}

export async function getGoiAdminIntegration(id: number): Promise<GoiAdminIntegration> {
  const data = await postJson<GoiAdminIntegrationLike>('/api/admin/goi/integration', { id });
  return normalizeGoiAdminIntegration(data);
}

export async function upsertGoiAdminIntegration(
  req: UpsertGoiAdminIntegrationReq,
): Promise<GoiAdminIntegration> {
  const data = await postJson<GoiAdminIntegrationLike>(
    '/api/admin/goi/integration/upsert',
    toUpsertReqBody(req),
  );
  return normalizeGoiAdminIntegration(data);
}

export async function deleteGoiAdminIntegration(id: number): Promise<void> {
  await postVoid('/api/admin/goi/integration/delete', { id });
}

export async function checkGoiConnection(
  req: CheckGoiConnectionReq,
): Promise<CheckGoiConnectionRsp> {
  const data = await postJson<CheckGoiConnectionRspLike>(
    '/api/admin/goi/check-connection',
    toCheckReqBody(req),
  );
  return {
    ok: data?.ok ?? false,
    listedEntries: data?.listedEntries ?? data?.listed_entries ?? [],
    error: typeof data?.error === 'string' ? data.error : null,
  };
}

export async function setupGoiIntegrationWorker(
  req: SetupGoiIntegrationWorkerReq,
): Promise<GoiAdminIntegration> {
  const data = await postJson<GoiAdminIntegrationLike>(
    '/api/admin/goi/integration/setup-worker',
    toSetupWorkerReqBody(req),
  );
  return normalizeGoiAdminIntegration(data);
}
