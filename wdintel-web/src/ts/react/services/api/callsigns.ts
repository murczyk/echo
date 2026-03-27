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
  callsign_additional_sources?: Array<number | string> | null;
  created_at?: number | string;
  full_name?: string;
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

type ListCallsignsReqBody = {
  after_id: ListCallsignsReq['afterId'];
  before_id: ListCallsignsReq['beforeId'];
  filter_text: ListCallsignsReq['filterText'];
  filter_callsign: ListCallsignsReq['filterCallsign'];
  filter_position: ListCallsignsReq['filterPosition'];
  filter_full_name: ListCallsignsReq['filterFullName'];
  filter_comment: ListCallsignsReq['filterComment'];
  filter_unit: ListCallsignsReq['filterUnit'];
  filter_unit_army: ListCallsignsReq['filterUnitArmy'];
  filter_unit_division: ListCallsignsReq['filterUnitDivision'];
  filter_unit_regiment: ListCallsignsReq['filterUnitRegiment'];
  filter_unit_battalion: ListCallsignsReq['filterUnitBattalion'];
  filter_developing: ListCallsignsReq['filterDeveloping'];
  since_date_inclusive_ms: ListCallsignsReq['sinceDateInclusiveMs'];
  till_date_inclusive_ms: ListCallsignsReq['tillDateInclusiveMs'];
  limit: ListCallsignsReq['limit'];
  sort_by: ListCallsignsReq['sortBy'];
};

type CreateCallsignReqBody = {
  callsign: CreateCallsignReq['callsign'];
  position: CreateCallsignReq['position'];
  comment: CreateCallsignReq['comment'];
  full_name: CreateCallsignReq['fullName'];
  unit_id: CreateCallsignReq['unitId'];
  source_id: CreateCallsignReq['sourceId'];
  callsign_additional_sources: CreateCallsignReq['callsignAdditionalSources'];
  developing: CreateCallsignReq['developing'];
  radio_freq: CreateCallsignReq['radioFreq'];
};

type UpdateCallsignReqBody = {
  id: Callsign['id'];
  callsign: Callsign['callsign'];
  position: Callsign['position'];
  comment: Callsign['comment'];
  full_name: Callsign['fullName'];
  unit_id: Callsign['unitId'];
  active: Callsign['active'];
  source_id: Callsign['sourceId'];
  callsign_additional_sources: Callsign['callsignAdditionalSources'];
  created_at: Callsign['createdAt'];
  developing: Callsign['developing'];
  radio_freq: Callsign['radioFreq'];
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
  const callsignAdditionalSources = (raw?.callsignAdditionalSources ?? raw?.callsign_additional_sources ?? [])
    .map((value) => toNumber(value, Number.NaN))
    .filter(Number.isFinite);

  return {
    id: toNumber(raw?.id),
    callsign: raw?.callsign ?? '',
    position: raw?.position ?? '',
    comment: raw?.comment ?? '',
    fullName: raw?.fullName ?? raw?.full_name ?? '',
    unitId: toNumber(raw?.unitId ?? raw?.unit_id),
    active: raw?.active ?? true,
    sourceId: toNullableNumber(raw?.sourceId ?? raw?.source_id),
    callsignAdditionalSources,
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

function toListCallsignsReqBody(req: ListCallsignsReq): ListCallsignsReqBody {
  return {
    after_id: req.afterId,
    before_id: req.beforeId,
    filter_text: req.filterText,
    filter_callsign: req.filterCallsign,
    filter_position: req.filterPosition,
    filter_full_name: req.filterFullName,
    filter_comment: req.filterComment,
    filter_unit: req.filterUnit,
    filter_unit_army: req.filterUnitArmy,
    filter_unit_division: req.filterUnitDivision,
    filter_unit_regiment: req.filterUnitRegiment,
    filter_unit_battalion: req.filterUnitBattalion,
    filter_developing: req.filterDeveloping,
    since_date_inclusive_ms: req.sinceDateInclusiveMs,
    till_date_inclusive_ms: req.tillDateInclusiveMs,
    limit: req.limit,
    sort_by: req.sortBy,
  };
}

function toCreateCallsignReqBody(req: CreateCallsignReq): CreateCallsignReqBody {
  return {
    callsign: req.callsign,
    position: req.position,
    comment: req.comment,
    full_name: req.fullName,
    unit_id: req.unitId,
    source_id: req.sourceId,
    callsign_additional_sources: req.callsignAdditionalSources,
    developing: req.developing,
    radio_freq: req.radioFreq,
  };
}

function toUpdateCallsignReqBody(req: Callsign): UpdateCallsignReqBody {
  return {
    id: req.id,
    callsign: req.callsign,
    position: req.position,
    comment: req.comment,
    full_name: req.fullName,
    unit_id: req.unitId,
    active: req.active,
    source_id: req.sourceId,
    callsign_additional_sources: req.callsignAdditionalSources,
    created_at: req.createdAt,
    developing: req.developing,
    radio_freq: req.radioFreq,
  };
}

export async function listCallsigns(req: ListCallsignsReq, signal?: AbortSignal): Promise<ListCallsignsRsp> {
  const raw = await postJson<ListCallsignsRspLike>('/api/sigint/callsigns', toListCallsignsReqBody(req) as any, { signal });
  return normalizeListCallsignsRsp(raw);
}

export async function createCallsign(req: CreateCallsignReq): Promise<Callsign> {
  const raw = await postJson<CallsignLike>('/api/sigint/callsign/create', toCreateCallsignReqBody(req) as any);
  return normalizeCallsign(raw);
}

export async function updateCallsign(req: Callsign): Promise<Callsign> {
  const raw = await postJson<CallsignLike>('/api/sigint/callsign/update', toUpdateCallsignReqBody(req) as any);
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
  return postBytes('/api/sigint/callsigns/csv', toListCallsignsReqBody(req));
}

export async function downloadCallsignsXlsx(req: ListCallsignsReq): Promise<Blob> {
  return postBytes('/api/sigint/callsigns/xlsx', toListCallsignsReqBody(req));
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
