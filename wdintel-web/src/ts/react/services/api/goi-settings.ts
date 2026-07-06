import { emitUnauthorizedEvent } from '../../auth-redirect';
import type {
  GoiReportTabOrderItem,
  GoiReportTabOrderListRsp,
  GoiReportTabOrderUpdateReq,
} from '../../../../Bindings';
import { HttpRequestError, postBytes, postJson } from './client';

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
  pauseWorker: boolean;
  canChangePauseWorker: boolean;
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
  pauseWorker?: boolean;
  pause_worker?: boolean;
  canChangePauseWorker?: boolean;
  can_change_pause_worker?: boolean;
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

type DownloadGoiIntegrationPalettesReqBody = {
  integration_id: number;
};

type UpdateGoiIntegrationPauseWorkerReqBody = {
  integration_id: number;
  pause_worker: boolean;
};

type GoiReportTabOrderItemLike = {
  aorId?: number | string;
  aor_id?: number | string;
  aorName?: string | null;
  aor_name?: string | null;
  orderForReport?: number | string;
  order_for_report?: number | string;
};

type GoiReportTabOrderListRspLike = {
  items?: GoiReportTabOrderItemLike[] | null;
};

function normalizeNumber(value: number | string | null | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeGoiUserIntegration(
  raw: GoiUserIntegrationLike | null | undefined,
): GoiUserIntegration {
  return {
    id: normalizeNumber(raw?.id),
    ownerOrganismId: normalizeNumber(raw?.ownerOrganismId ?? raw?.owner_organism_id),
    ownerOrganismName:
      normalizeOptionalString(raw?.ownerOrganismName ?? raw?.owner_organism_name) ?? '',
    integrationType:
      normalizeOptionalString(raw?.integrationType ?? raw?.integration_type) ?? 'full',
    serverLabel: normalizeOptionalString(raw?.serverLabel ?? raw?.server_label) ?? '',
    goiUrl: normalizeOptionalString(raw?.goiUrl ?? raw?.goi_url),
    swappUrl: normalizeOptionalString(raw?.swappUrl ?? raw?.swapp_url),
    hasDataAccess: raw?.hasDataAccess ?? raw?.has_data_access ?? false,
    pauseWorker: raw?.pauseWorker ?? raw?.pause_worker ?? false,
    canChangePauseWorker: raw?.canChangePauseWorker ?? raw?.can_change_pause_worker ?? false,
    canRestart: raw?.canRestart ?? raw?.can_restart ?? false,
    restartUnavailableReason: normalizeOptionalString(
      raw?.restartUnavailableReason ?? raw?.restart_unavailable_reason,
    ),
  };
}

function normalizeGoiReportTabOrderItem(
  raw: GoiReportTabOrderItemLike | null | undefined,
): GoiReportTabOrderItem {
  return {
    aorId: normalizeNumber(raw?.aorId ?? raw?.aor_id),
    aorName: normalizeOptionalString(raw?.aorName ?? raw?.aor_name) ?? '',
    orderForReport: normalizeNumber(raw?.orderForReport ?? raw?.order_for_report),
  };
}

function toGoiReportTabOrderUpdateReqBody(req: GoiReportTabOrderUpdateReq) {
  return {
    integration_id: req.integrationId,
    items: req.items.map((item) => ({
      aor_id: item.aorId,
      aor_name: item.aorName,
      order_for_report: item.orderForReport,
    })),
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

export async function fetchGoiReportTabOrder(
  integrationId: number | null,
  signal?: AbortSignal,
): Promise<GoiReportTabOrderItem[]> {
  const data = await postJson<GoiReportTabOrderListRspLike>(
    '/api/goi/report-tab-order',
    { integration_id: integrationId },
    { signal },
  );
  return (data?.items ?? []).map(normalizeGoiReportTabOrderItem);
}

export async function updateGoiReportTabOrder(
  req: GoiReportTabOrderUpdateReq,
): Promise<GoiReportTabOrderItem[]> {
  const data = await postJson<GoiReportTabOrderListRsp>(
    '/api/goi/report-tab-order/update',
    toGoiReportTabOrderUpdateReqBody(req),
  );
  return (data?.items ?? []).map(normalizeGoiReportTabOrderItem);
}

export async function updateCurrentUserGoiPauseWorker(
  integrationId: number,
  pauseWorker: boolean,
): Promise<GoiUserIntegration> {
  const data = await postJson<GoiUserIntegrationLike>('/api/goi/pause-worker/update', {
    integration_id: integrationId,
    pause_worker: pauseWorker,
  } satisfies UpdateGoiIntegrationPauseWorkerReqBody);
  return normalizeGoiUserIntegration(data);
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

export async function downloadCurrentUserGoiPalettes(integrationId: number): Promise<Blob> {
  return postBytes('/api/goi/download-palettes', {
    integration_id: integrationId,
  } satisfies DownloadGoiIntegrationPalettesReqBody);
}

export async function uploadCurrentUserGoiCategories(
  integrationId: number,
  file: File,
): Promise<void> {
  const formData = new FormData();
  formData.append('file', file);
  await postMultipartVoid(`/api/goi/upload-categories/${integrationId}`, formData);
}

function formatMultipartErrorMessage(status: number, text: string): string {
  if (text.trim().length > 0) return text;
  return `HTTP ${status}`;
}

async function postMultipartVoid(url: string, formData: FormData): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    body: formData,
    credentials: 'include',
  });

  if (!response.ok) {
    if (response.status === 401) {
      emitUnauthorizedEvent();
    }
    throw new HttpRequestError(
      response.status,
      formatMultipartErrorMessage(response.status, await response.text()),
    );
  }
}
