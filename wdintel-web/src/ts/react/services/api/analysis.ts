import type {
  AnalysisStatsReq,
  EditFreqUnitNameReq,
  BatchMessageCommentsReq,
  InboxSubmitReq,
  ReportPreviewReq,
  ReportType,
  ReoReportFileType,
  AnalysisStatsAor,
  AnalysisStatsCallsign,
  AnalysisStatsFreq,
  AnalysisStatsGroup,
  AnalysisStatsLocation,
  AnalysisStatsMetadataValue,
  AnalysisStatsNetwork,
  AnalysisStatsPost,
  AnalysisStatsSender,
  AnalysisStatsTag,
  AnalysisStatsUnit,
  AreaOfResponsibilityEntry,
  CallsignInfoRes,
  CallsignsGraphReq,
  CountStatsRsp,
  CorrelatedFreqsRsp,
  FreqDetailedPoint,
  FreqDailyActivityCount,
  FreqStatsReq,
  GroupStatsRsp,
  InboxMessage,
  MapPointsRsp,
  MetadataStatsRsp,
  NetJsonGraphAndMeta,
  Network,
  NetworkUnit,
  NewCallsignsRes,
  MessageComments,
  ListUnitsByIdReq,
  ListUnitsByIdRsp,
  SavedFilter,
  SavedFilterRenameReq,
  SavedFilterUpsertReq,
  SenderStatsRsp,
  SignalGroupEntry,
  SignalProfileRsp,
  SummaryTableFreq,
  UnitStatsRsp,
} from '../../../../Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';
import { emptyArrToNull, isNullOrUndefined } from '../../utils/misc';
import { getJson, postBytes, postJson, postVoid } from './client';
import {
  bookmarkAdd,
  bookmarkRemove,
  commentSave,
  deleteMessage,
  fetchInboxMessages,
  getGroupInfosBatch,
  getLatestSenders,
  getTagsMapForDisplay,
  importantAdd,
  importantRemove,
  inboxMessageTagsAdd,
  inboxMessageTagsModelError,
  inboxMessageTagsRm,
} from './inbox';

type JsonValue = string | number | boolean | null | { [key: string]: JsonValue } | JsonValue[];

type LocationStatsRsp = { locations: AnalysisStatsLocation[] };
type PostStatsRsp = { posts: AnalysisStatsPost[] };
type FreqStatsRsp = { freqs: AnalysisStatsFreq[] };
type CallsignStatsRsp = { callsigns: AnalysisStatsCallsign[] };
type TagStatsRsp = { tags: AnalysisStatsTag[] };
type NetworkStatsRsp = { networks: AnalysisStatsNetwork[]; networkNames: Array<{ id: number; name: string }> };
type AreaOfResponsibilityStatsRsp = { aors: AnalysisStatsAor[]; aorNames: AreaOfResponsibilityEntry[] };
type MessageIdsRsp = { messages: Array<[number, InboxMessage]> };
type CallsignInfoBatchRaw = Array<CallsignInfoRes>;
type BgtaskStatusAndLogsRsp = {
  running: boolean;
  loglines: string[];
  finishedWithError: string | null;
  finishedWithErrorCode: string | null;
};

const CONTENT_NODE_VARIANT_KEY_MAP: Record<string, string> = {
  _c_n_text_c: 'CNTextC',
  _c_n_newline_c: 'CNNewlineC',
  _c_n_callsign_c: 'CNCallsignC',
  _c_n_highlight_c: 'CNHighlightC',
  _c_n_signal_c: 'CNSignalC',
  _c_n_point_c: 'CNPointC',
};

function restoreContentNodeVariantKeys<T>(value: T): T {
  if (isNullOrUndefined(value)) return value;
  if (Array.isArray(value)) {
    return value.map((item) => restoreContentNodeVariantKeys(item)) as T;
  }
  if (typeof value !== 'object') return value;

  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const restoredKey = CONTENT_NODE_VARIANT_KEY_MAP[key] ?? key;
    out[restoredKey] = restoreContentNodeVariantKeys(obj[key]);
  }
  return out as T;
}

function normalizeReq(req: AnalysisStatsReq): AnalysisStatsReq {
  let normalized = req;

  if (req.withoutMetadata) {
    normalized = {
      ...normalized,
      metadataCc: null,
      metadataSender: null,
      metadataReceiver: null,
      metadataHash: null,
      onlyWithMetadata: false,
    };
  }

  if (normalized.onlyWithMetadata) {
    normalized = { ...normalized, withoutMetadata: false };
  }

  if (normalized.withoutNetwork) {
    normalized = { ...normalized, selectedNetworks: null };
  }

  return normalized;
}

function analysisStatsReqBody(req: AnalysisStatsReq) {
  const normalized = normalizeReq({
    ...req,
    selectedGroups: emptyArrToNull(req.selectedGroups),
    selectedSenders: emptyArrToNull(req.selectedSenders),
    selectedFreqs: emptyArrToNull(req.selectedFreqs),
    selectedPosts: emptyArrToNull(req.selectedPosts),
    selectedCallsigns: emptyArrToNull(req.selectedCallsigns),
    selectedUnits: emptyArrToNull(req.selectedUnits),
    selectedLocations: emptyArrToNull(req.selectedLocations),
    selectedAors: emptyArrToNull(req.selectedAors),
    selectedTags: emptyArrToNull(req.selectedTags),
    selectedNetworks: emptyArrToNull(req.selectedNetworks),
    metadataCc: emptyArrToNull(req.metadataCc),
    metadataSender: emptyArrToNull(req.metadataSender),
    metadataReceiver: emptyArrToNull(req.metadataReceiver),
    metadataHash: emptyArrToNull(req.metadataHash),
  });

  return transformCamelToSnake(normalized);
}

function reportPreviewReqBody(req: ReportPreviewReq): JsonValue {
  const body = transformCamelToSnake(req) as Record<string, unknown>;

  if (req.reportType == null) {
    body.report_type = null;
    return body as JsonValue;
  }

  if (typeof req.reportType === 'string') {
    body.report_type = req.reportType;
    return body as JsonValue;
  }

  const [variant, payload] = Object.entries(req.reportType as Record<string, unknown>)[0] ?? [];
  if (variant) {
    body.report_type = { [variant]: transformCamelToSnake(payload) };
  }

  return body as JsonValue;
}

async function postAnalysisStats<T>(url: string, req: AnalysisStatsReq): Promise<T> {
  const raw = await postJson<unknown>(url, analysisStatsReqBody(req) as JsonValue);
  return transformSnakeToCamel<T>(raw);
}

export async function listAnalysisSavedFilters(): Promise<SavedFilter[]> {
  const raw = await postJson<unknown>('/api/rer/analysis/saved-filters', {});
  return transformSnakeToCamel<SavedFilter[]>(raw) ?? [];
}

export async function upsertAnalysisSavedFilter(req: SavedFilterUpsertReq): Promise<SavedFilter[]> {
  const body = {
    name: req.name,
    req: analysisStatsReqBody(req.req),
  };
  const raw = await postJson<unknown>('/api/rer/analysis/saved-filter-upsert', body as JsonValue);
  return transformSnakeToCamel<SavedFilter[]>(raw) ?? [];
}

export async function renameAnalysisSavedFilter(req: SavedFilterRenameReq): Promise<void> {
  await postVoid('/api/rer/analysis/saved-filter-rename', transformCamelToSnake(req));
}

export async function deleteAnalysisSavedFilter(id: number): Promise<void> {
  await postVoid('/api/rer/analysis/saved-filter-delete', id);
}

export async function fetchAnalysisCount(req: AnalysisStatsReq): Promise<CountStatsRsp> {
  return postAnalysisStats<CountStatsRsp>('/api/rer/analysis/stats/count', req);
}

export async function fetchAnalysisGroups(req: AnalysisStatsReq): Promise<GroupStatsRsp> {
  return postAnalysisStats<GroupStatsRsp>('/api/rer/analysis/stats/groups', req);
}

export async function fetchAnalysisSenders(req: AnalysisStatsReq): Promise<SenderStatsRsp> {
  return postAnalysisStats<SenderStatsRsp>('/api/rer/analysis/stats/senders', req);
}

export async function fetchAnalysisFreqs(req: AnalysisStatsReq): Promise<FreqStatsRsp> {
  return postAnalysisStats<FreqStatsRsp>('/api/rer/analysis/stats/freqs', req);
}

export async function fetchAnalysisPosts(req: AnalysisStatsReq): Promise<PostStatsRsp> {
  return postAnalysisStats<PostStatsRsp>('/api/rer/analysis/stats/posts', req);
}

export async function fetchAnalysisCallsigns(req: AnalysisStatsReq): Promise<CallsignStatsRsp> {
  return postAnalysisStats<CallsignStatsRsp>('/api/rer/analysis/stats/callsigns', req);
}

export async function fetchAnalysisUnits(req: AnalysisStatsReq): Promise<UnitStatsRsp> {
  return postAnalysisStats<UnitStatsRsp>('/api/rer/analysis/stats/units', req);
}

export async function fetchAnalysisLocations(req: AnalysisStatsReq): Promise<LocationStatsRsp> {
  return postAnalysisStats<LocationStatsRsp>('/api/rer/analysis/stats/locations', req);
}

export async function fetchAnalysisTags(req: AnalysisStatsReq): Promise<TagStatsRsp> {
  return postAnalysisStats<TagStatsRsp>('/api/rer/analysis/stats/tags', req);
}

export async function fetchAnalysisNetworks(req: AnalysisStatsReq): Promise<NetworkStatsRsp> {
  return postAnalysisStats<NetworkStatsRsp>('/api/rer/analysis/stats/networks', req);
}

export async function fetchAnalysisAors(req: AnalysisStatsReq): Promise<AreaOfResponsibilityStatsRsp> {
  return postAnalysisStats<AreaOfResponsibilityStatsRsp>('/api/rer/analysis/stats/aors', req);
}

export async function fetchAnalysisMetadata(req: AnalysisStatsReq): Promise<MetadataStatsRsp> {
  return postAnalysisStats<MetadataStatsRsp>('/api/rer/analysis/stats/metadata', req);
}

export async function fetchAnalysisSummaryTable(req: AnalysisStatsReq): Promise<SummaryTableFreq> {
  return postAnalysisStats<SummaryTableFreq>('/api/rer/analysis/summary-table-freq', req);
}

export async function fetchAnalysisNewCallsigns(req: AnalysisStatsReq): Promise<NewCallsignsRes> {
  return postAnalysisStats<NewCallsignsRes>('/api/rer/analysis/new-callsigns', req);
}

export async function fetchAnalysisCorrelatedFreqs(req: AnalysisStatsReq): Promise<CorrelatedFreqsRsp> {
  return postAnalysisStats<CorrelatedFreqsRsp>('/api/rer/analysis/correlated-freqs', req);
}

export async function fetchAnalysisCallsignGraph(req: CallsignsGraphReq): Promise<NetJsonGraphAndMeta> {
  const raw = await postJson<unknown>('/api/rer/analysis/callsigns-graph', transformCamelToSnake(req));
  return transformSnakeToCamel<NetJsonGraphAndMeta>(raw);
}

export async function fetchFreqActivityDaily(req: FreqStatsReq): Promise<FreqDailyActivityCount> {
  const raw = await postJson<unknown>('/api/sigint/freqs/daily', transformCamelToSnake(req));
  return transformSnakeToCamel<FreqDailyActivityCount>(raw);
}

export async function fetchAnalysisMapPoints(req: {
  inboxItemsFilter: unknown;
  mapFilter: null;
  pageId: string;
}): Promise<MapPointsRsp> {
  const raw = await postJson<unknown>('/api/rer-importer/get-inbox-map', transformCamelToSnake(req));
  return transformSnakeToCamel<MapPointsRsp>(raw);
}

export async function fetchMessagesByIds(messageIds: number[]): Promise<Array<[number, InboxMessage]>> {
  const raw = await postJson<unknown>('/api/rer-importer/messages-by-id', transformCamelToSnake({ messageIds }));
  return transformSnakeToCamel<MessageIdsRsp>(raw).messages ?? [];
}

export async function fetchMessageComments(req: BatchMessageCommentsReq): Promise<MessageComments> {
  const raw = await postJson<unknown>('/api/rer/message/comments-batch', transformCamelToSnake(req));
  return transformSnakeToCamel<MessageComments>(raw);
}

export async function fetchAnalysisCallsignInfos(callsigns: string[]): Promise<CallsignInfoRes[]> {
  const raw = await postJson<unknown>('/api/rer/callsign-info-batch', transformCamelToSnake({ callsigns }));
  return transformSnakeToCamel<CallsignInfoBatchRaw>(raw) ?? [];
}

export async function downloadAnalysisReport(req: ReportPreviewReq): Promise<Blob> {
  return postBytes('/api/rer/report-docx', reportPreviewReqBody(req));
}

export async function launchAnalysisReportTask(req: ReportPreviewReq): Promise<number> {
  return postJson<number>('/api/rer/report-docx-task-launch', reportPreviewReqBody(req));
}

export async function fetchAnalysisReportTaskStatus(taskId: number, skip: number): Promise<BgtaskStatusAndLogsRsp> {
  const raw = await getJson<unknown>(`/api/bgtask/${taskId}/status-and-logs?skip=${skip}`);
  const rsp = transformSnakeToCamel<BgtaskStatusAndLogsRsp>(raw);
  return {
    ...rsp,
    finishedWithErrorCode: rsp.finishedWithErrorCode ?? null,
  };
}

export async function downloadAnalysisReportTaskResult(taskId: number): Promise<Blob> {
  return postBytes('/api/rer/report-docx-task-download', transformCamelToSnake({ bgtaskId: taskId }));
}

export async function submitAnalysisInboxMessages(req: InboxSubmitReq): Promise<void> {
  const snakeBody = transformCamelToSnake(req) as JsonValue;
  await postVoid('/api/rer-importer/inbox/submit', restoreContentNodeVariantKeys(snakeBody));
}

export async function editAnalysisFreqUnitName(req: EditFreqUnitNameReq): Promise<void> {
  await postVoid('/api/rer/analysis/freq-edit-unit-name', transformCamelToSnake(req));
}

export async function downloadAnalysisSummaryTableXlsx(req: AnalysisStatsReq): Promise<Blob> {
  return postBytes('/api/rer/analysis/summary-table.xlsx', analysisStatsReqBody(req) as JsonValue);
}

export async function downloadAnalysisKmz(req: AnalysisStatsReq): Promise<Blob> {
  return postBytes('/api/rer/analysis/download-kmz', analysisStatsReqBody(req) as JsonValue);
}

export async function downloadAnalysisGeojson(req: AnalysisStatsReq): Promise<Blob> {
  return postBytes('/api/rer/analysis/download-geojson', analysisStatsReqBody(req) as JsonValue);
}

export async function fetchUnitsByIds(req: ListUnitsByIdReq): Promise<ListUnitsByIdRsp> {
  const raw = await postJson<unknown>('/api/sigint/units-by-id', transformCamelToSnake(req));
  return transformSnakeToCamel<ListUnitsByIdRsp>(raw);
}

export async function fetchNetworksByIds(ids: number[]): Promise<Network[]> {
  const raw = await postJson<unknown>('/api/sigint/network-info-batch-id', ids);
  return transformSnakeToCamel<Network[]>(raw) ?? [];
}

export { fetchInboxMessages };
export {
  bookmarkAdd,
  bookmarkRemove,
  commentSave,
  deleteMessage,
  getGroupInfosBatch,
  getLatestSenders,
  getTagsMapForDisplay,
  importantAdd,
  importantRemove,
  inboxMessageTagsAdd,
  inboxMessageTagsModelError,
  inboxMessageTagsRm,
};

export type AnalysisFilterReferenceData = {
  groups: AnalysisStatsGroup[];
  groupNames: SignalGroupEntry[];
  senders: AnalysisStatsSender[];
  senderNames: Record<string, SignalProfileRsp | null>;
  freqs: AnalysisStatsFreq[];
  posts: AnalysisStatsPost[];
  callsigns: AnalysisStatsCallsign[];
  units: AnalysisStatsUnit[];
  locations: AnalysisStatsLocation[];
  tags: AnalysisStatsTag[];
  networks: AnalysisStatsNetwork[];
  aors: AnalysisStatsAor[];
  metadata: MetadataStatsRsp;
};

export type AnalysisMapData = {
  points: FreqDetailedPoint[];
  networkUnits: NetworkUnit[];
};

export type AnalysisMetadataOptionGroups = {
  ccs: AnalysisStatsMetadataValue[];
  senders: AnalysisStatsMetadataValue[];
  receivers: AnalysisStatsMetadataValue[];
  hashes: AnalysisStatsMetadataValue[];
};
