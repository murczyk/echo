import { postJson } from './client';

export type GoiRestartService = 'swapp' | 'swapp_alt' | 'goi' | 'echo_swapp';
export type GoiWhatsappService = 'swapp' | 'swapp_alt';

export type GoiUserIntegration = {
  id: number;
  ownerOrganismId: number;
  ownerOrganismName: string;
  integrationType: string;
  serverLabel: string;
  goiUrl: string | null;
  swappUrl: string | null;
  hasDataAccess: boolean;
  canRestart: boolean;
  restartUnavailableReason: string | null;
};

type GoiUserIntegrationLike = {
  id?: number | string;
  ownerOrganismId?: number | string;
  owner_organism_id?: number | string;
  ownerOrganismName?: string | null;
  owner_organism_name?: string | null;
  integrationType?: string | null;
  integration_type?: string | null;
  serverLabel?: string | null;
  server_label?: string | null;
  goiUrl?: string | null;
  goi_url?: string | null;
  swappUrl?: string | null;
  swapp_url?: string | null;
  hasDataAccess?: boolean;
  has_data_access?: boolean;
  canRestart?: boolean;
  can_restart?: boolean;
  restartUnavailableReason?: string | null;
  restart_unavailable_reason?: string | null;
};

type ListCurrentUserGoiIntegrationsRspLike = {
  items?: GoiUserIntegrationLike[] | null;
};

type RestartCurrentUserGoiServiceReqBody = {
  integration_id: number;
  service: GoiRestartService;
};

type UnlinkCurrentUserGoiWhatsappReqBody = {
  integration_id: number;
  service: GoiWhatsappService;
};

function normalizeNumber(value: number | string | null | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function normalizeOptionalString(
  value: string | null | undefined,
): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeGoiUserIntegration(
  raw: GoiUserIntegrationLike | null | undefined,
): GoiUserIntegration {
  return {
    id: normalizeNumber(raw?.id),
    ownerOrganismId: normalizeNumber(
      raw?.ownerOrganismId ?? raw?.owner_organism_id,
    ),
    ownerOrganismName: normalizeOptionalString(
      raw?.ownerOrganismName ?? raw?.owner_organism_name,
    ) ?? '',
    integrationType:
      normalizeOptionalString(raw?.integrationType ?? raw?.integration_type) ??
      'full',
    serverLabel:
      normalizeOptionalString(raw?.serverLabel ?? raw?.server_label) ?? '',
    goiUrl: normalizeOptionalString(raw?.goiUrl ?? raw?.goi_url),
    swappUrl: normalizeOptionalString(raw?.swappUrl ?? raw?.swapp_url),
    hasDataAccess:
      raw?.hasDataAccess ?? raw?.has_data_access ?? false,
    canRestart: raw?.canRestart ?? raw?.can_restart ?? false,
    restartUnavailableReason:
      normalizeOptionalString(
        raw?.restartUnavailableReason ?? raw?.restart_unavailable_reason,
      ),
  };
}

export async function fetchCurrentUserGoiIntegrations(
  signal?: AbortSignal,
): Promise<GoiUserIntegration[]> {
  const data = await postJson<ListCurrentUserGoiIntegrationsRspLike>(
    '/api/goi/current-user-integrations',
    undefined,
    { signal },
  );
  return (data?.items ?? []).map(normalizeGoiUserIntegration);
}

export async function restartCurrentUserGoiService(
  integrationId: number,
  service: GoiRestartService,
): Promise<void> {
  await postJson<boolean>('/api/goi/restart-service', {
    integration_id: integrationId,
    service,
  } satisfies RestartCurrentUserGoiServiceReqBody);
}

export async function unlinkCurrentUserGoiWhatsapp(
  integrationId: number,
  service: GoiWhatsappService,
): Promise<void> {
  await postJson<boolean>('/api/goi/unlink-whatsapp', {
    integration_id: integrationId,
    service,
  } satisfies UnlinkCurrentUserGoiWhatsappReqBody);
}
