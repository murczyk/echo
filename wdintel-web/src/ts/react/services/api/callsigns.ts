import type {
  Callsign,
  CallsignUnitStatRow,
  CallsignUnitStatsRsp,
  CreateCallsignReq,
  ListCallsignsReq,
  ListCallsignsRsp,
  ListSourcesRsp,
  Source,
  Unit,
  User,
} from '../../../../Bindings';

import { getUnitsList } from './units';
import { HttpRequestError, postJson } from './client';
import { fetchCurrentUser } from './user';

type CallsignLike = Partial<Callsign> & {
  unit_id?: number | string;
  source_id?: number | string | null;
  created_at?: number | string;
  radio_freq?: string | null;
};

type SourceLike = Partial<Source> & {
  created_at?: number | string;
};

type CallsignUnitStatRowLike = Partial<CallsignUnitStatRow> & {
  unit_id?: number | string;
};

type ListCallsignsRspLike = {
  showLoadMore?: boolean;
  show_load_more?: boolean;
  callsigns?: CallsignLike[] | null;
};

type ListSourcesRspLike = {
  sources?: SourceLike[] | null;
};

type CallsignUnitStatsRspLike = {
  units?: CallsignUnitStatRowLike[] | null;
};

export type CallsignsBootstrapData = {
  user: User;
  units: Unit[];
  sources: Source[];
  unitStats: CallsignUnitStatRow[];
  callsigns: ListCallsignsRsp;
};

function toNumber(value: number | string | null | undefined, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function toNullableNumber(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  const parsed = toNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCallsign(raw: CallsignLike | null | undefined): Callsign {
  return {
    id: toNumber(raw?.id),
    callsign: raw?.callsign ?? '',
    position: raw?.position ?? '',
    comment: raw?.comment ?? '',
    unitId: toNumber(raw?.unitId ?? raw?.unit_id),
    active: raw?.active ?? true,
    sourceId: toNullableNumber(raw?.sourceId ?? raw?.source_id),
    createdAt: toNumber(raw?.createdAt ?? raw?.created_at),
    developing: raw?.developing ?? false,
    radioFreq: raw?.radioFreq ?? raw?.radio_freq ?? null,
  };
}

function normalizeSource(raw: SourceLike | null | undefined): Source {
  return {
    id: toNumber(raw?.id),
    name: raw?.name ?? '',
    createdAt: toNumber(raw?.createdAt ?? raw?.created_at),
  };
}

function normalizeUnitStatRow(raw: CallsignUnitStatRowLike | null | undefined): CallsignUnitStatRow {
  return {
    unitId: toNumber(raw?.unitId ?? raw?.unit_id),
    count: toNumber(raw?.count),
  };
}

function normalizeListCallsignsRsp(raw: ListCallsignsRspLike | null | undefined): ListCallsignsRsp {
  return {
    showLoadMore: raw?.showLoadMore ?? raw?.show_load_more ?? false,
    callsigns: (raw?.callsigns ?? []).map(normalizeCallsign),
  };
}

function normalizeListSourcesRsp(raw: ListSourcesRspLike | null | undefined): ListSourcesRsp {
  return {
    sources: (raw?.sources ?? []).map(normalizeSource),
  };
}

function normalizeCallsignUnitStatsRsp(raw: CallsignUnitStatsRspLike | null | undefined): CallsignUnitStatsRsp {
  return {
    units: (raw?.units ?? []).map(normalizeUnitStatRow),
  };
}

async function parseBinaryError(response: Response): Promise<string> {
  const text = await response.text();
  if (text.trim().length > 0) return text;
  return response.statusText || `HTTP ${response.status}`;
}

async function postBytes(url: string, body: unknown): Promise<Blob> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    credentials: 'include',
  });

  if (!response.ok) {
    throw new HttpRequestError(response.status, await parseBinaryError(response));
  }

  return response.blob();
}

export async function listCallsigns(req: ListCallsignsReq, signal?: AbortSignal): Promise<ListCallsignsRsp> {
  const raw = await postJson<ListCallsignsRspLike>('/api/sigint/callsigns', req as any, { signal });
  return normalizeListCallsignsRsp(raw);
}

export async function createCallsign(req: CreateCallsignReq): Promise<Callsign> {
  const raw = await postJson<CallsignLike>('/api/sigint/callsign/create', req as any);
  return normalizeCallsign(raw);
}

export async function updateCallsign(req: Callsign): Promise<Callsign> {
  const raw = await postJson<CallsignLike>('/api/sigint/callsign/update', req as any);
  return normalizeCallsign(raw);
}

export async function deleteCallsign(callsignId: number): Promise<Callsign> {
  const raw = await postJson<CallsignLike>('/api/sigint/callsign/delete', callsignId as any);
  return normalizeCallsign(raw);
}

export async function listSources(): Promise<Source[]> {
  const raw = await postJson<ListSourcesRspLike>('/api/sigint/sources', null as any);
  return normalizeListSourcesRsp(raw).sources;
}

export async function getCallsignUnitStats(): Promise<CallsignUnitStatRow[]> {
  const raw = await postJson<CallsignUnitStatsRspLike>('/api/sigint/callsign/unit-stats', null as any);
  return normalizeCallsignUnitStatsRsp(raw).units;
}

export async function downloadCallsignsCsv(req: ListCallsignsReq): Promise<Blob> {
  return postBytes('/api/sigint/callsigns/csv', req);
}

export async function downloadCallsignsXlsx(req: ListCallsignsReq): Promise<Blob> {
  return postBytes('/api/sigint/callsigns/xlsx', req);
}

export async function fetchCallsignsBootstrapData(initialReq: ListCallsignsReq): Promise<CallsignsBootstrapData> {
  const [user, units, sources, unitStats, callsigns] = await Promise.all([
    fetchCurrentUser(),
    getUnitsList(),
    listSources(),
    getCallsignUnitStats(),
    listCallsigns(initialReq),
  ]);

  return { user, units, sources, unitStats, callsigns };
}
