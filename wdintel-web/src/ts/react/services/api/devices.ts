import type {
  DeviceArchiveStatus,
  DeviceAudioForwardingSettings,
  DeviceFileContentRef,
  DeviceAnalyticsSummaryReq,
  LocateDeviceFileReq,
  LocateDeviceFileRsp,
  ListDeviceSyncSessionsReq,
  ListDeviceSyncSessionsRsp,
  GetDeviceSyncSessionReq,
  FileSyncSessionRsp,
  DeviceSyncSessionSummariesReq,
  DeviceSyncSessionSummariesRsp,
  AreaOfResponsibility,
  BrowseDeviceFilesReq,
  BrowseDeviceFilesRsp,
  CountDeviceFileSubtreesReq,
  CountDeviceFileSubtreesRsp,
  CreateDeviceReq,
  DeviceDetailReq,
  DeviceDetails,
  DeviceFilterOptions,
  DeviceSettingsItem,
  DeviceSettingsReq,
  DeviceAnalyticsFilesReq,
  DeviceAnalyticsFilesRsp,
  DeviceAnalyticsReq,
  DeviceAnalyticsSummaryRsp,
  DeviceAnalyticsTagsRsp,
  DeviceUnitStat,
  JournalDeviceFilesReq,
  JournalDeviceFilesRsp,
  ListDeviceFileRootsReq,
  ListDeviceFileRootsRsp,
  ListDevicesReq,
  ListDevicesRsp,
  ListUnitsRsp,
  SearchDeviceFilesReq,
  SearchDeviceFilesRsp,
  ReanalyzeAllRsp,
  ReanalyzeDeviceReq,
  ReanalyzeDeviceRsp,
  RebuildDeviceStatsReq,
  RebuildDeviceStatsRsp,
  GetAnalysisRunReq,
  GetAnalysisRunRsp,
  ListAnalysisRunsReq,
  ListAnalysisRunsRsp,
  ListAnalysisRunFilesReq,
  ListAnalysisRunFilesRsp,
  Unit,
  UpdateDeviceReq,
} from '../../../../Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';
import { getBytes, getJson, headResponse, postJson } from './client';
import type { JsonBody, RequestOptions } from './client';

export type CreateDeviceInput = {
  name?: NonNullable<CreateDeviceReq['name']>;
  externalUrl?: CreateDeviceReq['externalUrl'];
  customFields?: Exclude<CreateDeviceReq['customFields'], null>;
};

export type DeviceUpdatePatchInput = {
  deviceId: UpdateDeviceReq['deviceId'];
  rating?: NonNullable<UpdateDeviceReq['rating']>;
  tags?: NonNullable<UpdateDeviceReq['tags']>;
  description?: UpdateDeviceReq['description'];
  externalUrl?: UpdateDeviceReq['externalUrl'];
  customFields?: Exclude<UpdateDeviceReq['customFields'], null>;
  name?: NonNullable<UpdateDeviceReq['name']>;
  aorIds?: NonNullable<UpdateDeviceReq['aorIds']>;
  unitId?: UpdateDeviceReq['unitId'];
  audioForwarding?: NonNullable<UpdateDeviceReq['audioForwarding']>;
};

export type DeviceSettingsInput = Partial<DeviceSettingsReq>;

type DeviceUpdatePatchReq = DeviceUpdatePatchInput;

function toDeviceUpdatePatchReq(input: DeviceUpdatePatchInput): DeviceUpdatePatchReq {
  const req: DeviceUpdatePatchReq = { deviceId: input.deviceId };
  if (input.rating !== undefined) req.rating = input.rating;
  if (input.tags !== undefined) req.tags = input.tags;
  if (input.description !== undefined) req.description = input.description;

  if (input.externalUrl !== undefined) req.externalUrl = input.externalUrl;
  if (input.customFields !== undefined) req.customFields = input.customFields;
  if (input.name !== undefined) req.name = input.name;
  if (input.aorIds !== undefined) req.aorIds = input.aorIds;
  if (input.unitId !== undefined) req.unitId = input.unitId;
  if (input.audioForwarding !== undefined) req.audioForwarding = input.audioForwarding;

  return req;
}

function serializeDeviceWriteRequest(req: CreateDeviceInput | DeviceUpdatePatchReq): JsonBody {
  const { customFields, ...fields } = req;
  const body = transformCamelToSnake<Record<string, unknown>>(fields);
  if (customFields !== undefined) body.custom_fields = customFields;
  return body as JsonBody;
}

function readCustomFields(data: unknown): Record<string, string> {
  if (data === null || typeof data !== 'object' || !('custom_fields' in data)) return {};
  const customFields = data.custom_fields;
  if (customFields === null || typeof customFields !== 'object' || Array.isArray(customFields)) {
    throw new Error('Invalid Devices API custom_fields response');
  }
  const entries = Object.entries(customFields);
  if (!entries.every(([, value]) => typeof value === 'string')) {
    throw new Error('Invalid Devices API custom_fields response');
  }
  return Object.fromEntries(entries);
}

function normalizeDeviceDetails(data: unknown): DeviceDetails {
  const details = transformSnakeToCamel<DeviceDetails>(data);
  const customFields = readCustomFields(data);
  return {
    ...details,
    rating: details.rating ?? 0,
    tags: details.tags ?? [],
    description: details.description ?? null,
    customFields,
  };
}

export async function listDevices(
  req: ListDevicesReq,
  options?: RequestOptions,
): Promise<ListDevicesRsp> {
  const data = await postJson<ListDevicesRsp>(
    '/api/device/list',
    transformCamelToSnake(req),
    options,
  );
  const response = transformSnakeToCamel<ListDevicesRsp>(data);
  return {
    ...response,
    list: response.list.map((device) => ({
      ...device,
      rating: device.rating ?? 0,
      tags: device.tags ?? [],
      audioDays: device.audioDays ?? null,
      activitySplitFilesAudio: device.activitySplitFilesAudio ?? false,
    })),
  };
}

export async function getDeviceUnitStats(options?: RequestOptions): Promise<DeviceUnitStat[]> {
  const data = await postJson('/api/device/unit-stats', undefined, options);
  return transformSnakeToCamel<{ units: DeviceUnitStat[] }>(data).units;
}

export async function listDeviceAors(options?: RequestOptions): Promise<AreaOfResponsibility[]> {
  const data = await postJson('/api/device/aors', undefined, options);
  return transformSnakeToCamel<AreaOfResponsibility[]>(data);
}

export async function listDeviceFilterOptions(
  options?: RequestOptions,
): Promise<DeviceFilterOptions> {
  const data = await postJson('/api/device/filter-options', undefined, options);
  return transformSnakeToCamel<DeviceFilterOptions>(data);
}

export async function listDeviceTags(options?: RequestOptions): Promise<string[]> {
  return postJson<string[]>('/api/device/tags', undefined, options);
}

export async function archiveDevice(deviceId: DeviceDetails['id']): Promise<DeviceDetails> {
  const data = await postJson('/api/device/archive', { device_id: deviceId });
  return normalizeDeviceDetails(data);
}

export async function unarchiveDevice(deviceId: DeviceDetails['id']): Promise<DeviceDetails> {
  const data = await postJson('/api/device/unarchive', { device_id: deviceId });
  return normalizeDeviceDetails(data);
}

export async function listDeviceUnits(options?: RequestOptions): Promise<Unit[]> {
  const data = await postJson('/api/device/units', undefined, options);
  return transformSnakeToCamel<ListUnitsRsp>(data).units;
}

export async function getDeviceDetail(
  req: DeviceDetailReq,
  options?: RequestOptions,
): Promise<DeviceDetails> {
  const data = await postJson('/api/device/detail', transformCamelToSnake(req), options);
  return normalizeDeviceDetails(data);
}

export async function createDevice(
  req: CreateDeviceInput,
  options?: RequestOptions,
): Promise<DeviceDetails> {
  const data = await postJson('/api/device/create', serializeDeviceWriteRequest(req), options);
  return normalizeDeviceDetails(data);
}

export async function updateDevice(
  input: DeviceUpdatePatchInput,
  options?: RequestOptions,
): Promise<DeviceDetails> {
  const data = await postJson(
    '/api/device/update',
    serializeDeviceWriteRequest(toDeviceUpdatePatchReq(input)),
    options,
  );
  return normalizeDeviceDetails(data);
}

export async function updateDeviceSettings(
  req: DeviceSettingsInput,
  options?: RequestOptions,
): Promise<DeviceSettingsItem> {
  const body: JsonBody = {};
  if (req.mattermostWebhookUrl !== undefined) {
    body.mattermostWebhookUrl = req.mattermostWebhookUrl;
  }
  if (req.clearMattermostWebhook !== undefined) {
    body.clearMattermostWebhook = req.clearMattermostWebhook;
  }
  if (req.activitySplitFilesAudio !== undefined) {
    body.activitySplitFilesAudio = req.activitySplitFilesAudio;
  }
  const data = await postJson<DeviceSettingsItem>('/api/admin/device/settings', body, options);
  const settings = transformSnakeToCamel<DeviceSettingsItem>(data);
  return { ...settings, activitySplitFilesAudio: settings.activitySplitFilesAudio ?? false };
}

export async function listDeviceFileRoots(
  req: ListDeviceFileRootsReq,
  options?: RequestOptions,
): Promise<ListDeviceFileRootsRsp> {
  const data = await postJson('/api/device/files/roots', transformCamelToSnake(req), options);
  return transformSnakeToCamel<ListDeviceFileRootsRsp>(data);
}
export async function countDeviceFileSubtrees(
  req: CountDeviceFileSubtreesReq,
  options?: RequestOptions,
): Promise<CountDeviceFileSubtreesRsp> {
  const data = await postJson(
    '/api/device/files/subtree-counts',
    transformCamelToSnake(req),
    options,
  );
  return transformSnakeToCamel<CountDeviceFileSubtreesRsp>(data);
}

export async function browseDeviceFiles(
  req: BrowseDeviceFilesReq,
  options?: RequestOptions,
): Promise<BrowseDeviceFilesRsp> {
  const data = await postJson('/api/device/files/browse', transformCamelToSnake(req), options);
  return transformSnakeToCamel<BrowseDeviceFilesRsp>(data);
}

export async function searchDeviceFiles(
  req: SearchDeviceFilesReq,
  options?: RequestOptions,
): Promise<SearchDeviceFilesRsp> {
  const data = await postJson('/api/device/files/search', transformCamelToSnake(req), options);
  return transformSnakeToCamel<SearchDeviceFilesRsp>(data);
}

export async function journalDeviceFiles(
  req: JournalDeviceFilesReq,
  options?: RequestOptions,
): Promise<JournalDeviceFilesRsp> {
  const data = await postJson('/api/device/files/journal', transformCamelToSnake(req), options);
  return transformSnakeToCamel<JournalDeviceFilesRsp>(data);
}

export function deviceFileContentUrl(deviceId: string, fileId: string, revision: number): string {
  return `/api/device/files/${encodeURIComponent(deviceId)}/${encodeURIComponent(fileId)}/revisions/${revision}/content`;
}

export function getDeviceFileContent(href: string, options?: RequestOptions) {
  return getBytes(href, options);
}

export async function getDeviceFileContentSize(href: string, options?: RequestOptions) {
  const response = await headResponse(href, options);
  const length = response.headers.get('content-length');
  const size = length === null || !/^\d+$/.test(length) ? null : Number(length);
  return size !== null && Number.isSafeInteger(size) && size >= 0 ? size : null;
}

export async function listAnalyticsTags(
  req: DeviceAnalyticsReq,
  options?: RequestOptions,
): Promise<DeviceAnalyticsTagsRsp> {
  const data = await postJson('/api/device/analytics/tags', transformCamelToSnake(req), options);
  return transformSnakeToCamel<DeviceAnalyticsTagsRsp>(data);
}

export async function getDeviceAnalyticsSummary(
  req: DeviceAnalyticsSummaryReq,
  options?: RequestOptions,
): Promise<DeviceAnalyticsSummaryRsp> {
  const data = await postJson('/api/device/analytics/summary', transformCamelToSnake(req), options);
  return transformSnakeToCamel<DeviceAnalyticsSummaryRsp>(data);
}

export async function listDeviceAnalyticsFiles(
  req: DeviceAnalyticsFilesReq,
  options?: RequestOptions,
): Promise<DeviceAnalyticsFilesRsp> {
  const data = await postJson('/api/device/analytics/files', transformCamelToSnake(req), options);
  return transformSnakeToCamel<DeviceAnalyticsFilesRsp>(data);
}

export async function reanalyzeDevice(
  req: ReanalyzeDeviceReq,
  options?: RequestOptions,
): Promise<ReanalyzeDeviceRsp> {
  const data = await postJson(
    '/api/admin/device-analytics/reanalyze/device',
    transformCamelToSnake(req),
    options,
  );
  return transformSnakeToCamel<ReanalyzeDeviceRsp>(data);
}

export async function rebuildDeviceStats(
  req: RebuildDeviceStatsReq,
  options?: RequestOptions,
): Promise<RebuildDeviceStatsRsp> {
  const data = await postJson('/api/device/stats/rebuild', transformCamelToSnake(req), options);
  return transformSnakeToCamel<RebuildDeviceStatsRsp>(data);
}

export async function reanalyzeAll(options?: RequestOptions): Promise<ReanalyzeAllRsp> {
  const data = await postJson('/api/admin/device-analytics/reanalyze/all', undefined, options);
  return transformSnakeToCamel<ReanalyzeAllRsp>(data);
}

export async function getAnalysisRun(
  req: GetAnalysisRunReq,
  options?: RequestOptions,
): Promise<GetAnalysisRunRsp> {
  const data = await postJson(
    '/api/device/analytics/runs/get',
    transformCamelToSnake(req),
    options,
  );
  return transformSnakeToCamel<GetAnalysisRunRsp>(data);
}

export async function listAnalysisRuns(
  req: ListAnalysisRunsReq,
  options?: RequestOptions,
): Promise<ListAnalysisRunsRsp> {
  const data = await postJson(
    '/api/device/analytics/runs/list',
    transformCamelToSnake(req),
    options,
  );
  return transformSnakeToCamel<ListAnalysisRunsRsp>(data);
}

export async function listAnalysisRunFiles(
  req: ListAnalysisRunFilesReq,
  options?: RequestOptions,
): Promise<ListAnalysisRunFilesRsp> {
  const data = await postJson(
    '/api/device/analytics/runs/files',
    transformCamelToSnake(req),
    options,
  );
  return transformSnakeToCamel<ListAnalysisRunFilesRsp>(data);
}

export async function listDeviceSyncSessions(
  req: ListDeviceSyncSessionsReq,
  options?: RequestOptions,
): Promise<ListDeviceSyncSessionsRsp> {
  const data = await postJson(
    '/api/device/files/sessions/list',
    transformCamelToSnake(req),
    options,
  );
  return transformSnakeToCamel<ListDeviceSyncSessionsRsp>(data);
}

export async function getDeviceSyncSession(
  req: GetDeviceSyncSessionReq,
  options?: RequestOptions,
): Promise<FileSyncSessionRsp> {
  const data = await postJson(
    '/api/device/files/sessions/get',
    transformCamelToSnake(req),
    options,
  );
  return transformSnakeToCamel<FileSyncSessionRsp>(data);
}

export async function getDeviceSyncSessionSummaries(
  req: DeviceSyncSessionSummariesReq,
  options?: RequestOptions,
): Promise<DeviceSyncSessionSummariesRsp> {
  const data = await postJson(
    '/api/device/files/sessions/summaries',
    transformCamelToSnake(req),
    options,
  );
  return transformSnakeToCamel<DeviceSyncSessionSummariesRsp>(data);
}

export async function locateDeviceFile(req: LocateDeviceFileReq, options?: RequestOptions) {
  const data = await postJson('/api/device/files/locate', req, options);
  return transformSnakeToCamel<LocateDeviceFileRsp>(data);
}

function deviceArchiveUrl(deviceId: string, fileId: string, revision: number) {
  if (!Number.isSafeInteger(revision) || revision <= 0) throw new Error('Некоректна ревізія файлу');
  return `/api/device/files/${encodeURIComponent(deviceId)}/${encodeURIComponent(fileId)}/revisions/${revision}/archive`;
}

export async function getDeviceArchive(
  deviceId: string,
  fileId: string,
  revision: number,
  options?: RequestOptions,
): Promise<DeviceArchiveStatus> {
  return transformSnakeToCamel(
    await getJson(deviceArchiveUrl(deviceId, fileId, revision), options),
  );
}

export async function ensureDeviceArchive(
  deviceId: string,
  fileId: string,
  revision: number,
  options?: RequestOptions,
): Promise<DeviceArchiveStatus> {
  return transformSnakeToCamel(
    await postJson(deviceArchiveUrl(deviceId, fileId, revision), undefined, options),
  );
}

export async function getDeviceAudioForwarding(
  deviceId: string,
  options?: RequestOptions,
): Promise<DeviceAudioForwardingSettings> {
  const data = await postJson('/api/device/audio/forwarding', { device_id: deviceId }, options);
  return transformSnakeToCamel<DeviceAudioForwardingSettings>(data);
}
