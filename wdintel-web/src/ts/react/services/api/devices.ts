import type {
  AreaOfResponsibility,
  BrowseDeviceFilesReq,
  BrowseDeviceFilesRsp,
  CountDeviceFileSubtreesReq,
  CountDeviceFileSubtreesRsp,
  CreateDeviceReq,
  DeviceDetailReq,
  DeviceDetails,
  DeviceFile,
  DeviceAnalyticsFilesReq,
  DeviceAnalyticsFilesRsp,
  DeviceAnalyticsReq,
  DeviceAnalyticsSummaryRsp,
  DeviceAnalyticsTagsRsp,
  DeviceUnitStat,
  JournalDeviceFilesReq,
  JournalDeviceFilesRsp,
  FileSyncErrorCode,
  FileSyncFieldError,
  FileSyncOperation,
  ListDeviceFileRootsReq,
  ListDeviceFileRootsRsp,
  ListDevicesReq,
  ListDevicesRsp,
  ListUnitsRsp,
  SearchDeviceFilesReq,
  SearchDeviceFilesRsp,
  SyncDeviceFilesReq,
  ReanalysisRsp,
  ReanalyzeDeviceReq,
  SyncDeviceFilesRsp,
  Unit,
  UpdateDeviceReq,
} from '../../../../Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';
import { postJson } from './client';
import type { JsonBody, RequestOptions } from './client';

export type CreateDeviceInput = {
  name?: NonNullable<CreateDeviceReq['name']>;
  externalUrl?: CreateDeviceReq['externalUrl'];
  customFields?: Exclude<CreateDeviceReq['customFields'], null>;
};

export type DeviceUpdatePatchInput = {
  deviceId: UpdateDeviceReq['deviceId'];
  externalUrl?: UpdateDeviceReq['externalUrl'];
  customFields?: Exclude<UpdateDeviceReq['customFields'], null>;
  name?: NonNullable<UpdateDeviceReq['name']>;
  aorIds?: NonNullable<UpdateDeviceReq['aorIds']>;
  unitId?: UpdateDeviceReq['unitId'];
};

type DeviceUpdatePatchReq = DeviceUpdatePatchInput;

type CamelFileSyncResult =
  | {
      status: 'accepted';
      index: number;
      operation: FileSyncOperation;
      fileId: string;
      revision: number;
      file: DeviceFile;
    }
  | {
      status: 'rejected';
      index: number;
      code: FileSyncErrorCode;
      message: string;
      fieldErrors: FileSyncFieldError[];
    };

export function toDeviceUpdatePatchReq(input: DeviceUpdatePatchInput): DeviceUpdatePatchReq {
  const req: DeviceUpdatePatchReq = { deviceId: input.deviceId };

  if (input.externalUrl !== undefined) req.externalUrl = input.externalUrl;
  if (input.customFields !== undefined) req.customFields = input.customFields;
  if (input.name !== undefined) req.name = input.name;
  if (input.aorIds !== undefined) req.aorIds = input.aorIds;
  if (input.unitId !== undefined) req.unitId = input.unitId;

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
    customFields,
  };
}

function normalizeSyncResponse(data: unknown): SyncDeviceFilesRsp {
  const response = transformSnakeToCamel<{
    sync: SyncDeviceFilesRsp['sync'];
    results: CamelFileSyncResult[];
  }>(data);
  return {
    sync: response.sync,
    results: response.results.map((result) => {
      if (result.status === 'accepted') {
        const { status: _, ...accepted } = result;
        return { Accepted: accepted };
      }
      const { status: _, ...rejected } = result;
      return { Rejected: rejected };
    }),
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
  return transformSnakeToCamel<ListDevicesRsp>(data);
}

export async function getDeviceUnitStats(options?: RequestOptions): Promise<DeviceUnitStat[]> {
  const data = await postJson('/api/device/unit-stats', undefined, options);
  return transformSnakeToCamel<{ units: DeviceUnitStat[] }>(data).units;
}

export async function listDeviceAors(options?: RequestOptions): Promise<AreaOfResponsibility[]> {
  const data = await postJson('/api/device/aors', undefined, options);
  return transformSnakeToCamel<AreaOfResponsibility[]>(data);
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

export async function syncDeviceFiles(
  req: SyncDeviceFilesReq,
  options?: RequestOptions,
): Promise<SyncDeviceFilesRsp> {
  const data = await postJson(
    '/api/device/files/sync',
    transformCamelToSnake<JsonBody>(req),
    options,
  );
  return normalizeSyncResponse(data);
}

export async function listAnalyticsTags(
  req: DeviceAnalyticsReq,
  options?: RequestOptions,
): Promise<DeviceAnalyticsTagsRsp> {
  const data = await postJson('/api/device/analytics/tags', transformCamelToSnake(req), options);
  return transformSnakeToCamel<DeviceAnalyticsTagsRsp>(data);
}

export async function getDeviceAnalyticsSummary(
  req: DeviceAnalyticsReq,
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
): Promise<ReanalysisRsp> {
  const data = await postJson(
    '/api/admin/device-analytics/reanalyze/device',
    transformCamelToSnake(req),
    options,
  );
  return transformSnakeToCamel<ReanalysisRsp>(data);
}

export async function reanalyzeAll(options?: RequestOptions): Promise<ReanalysisRsp> {
  const data = await postJson('/api/admin/device-analytics/reanalyze/all', undefined, options);
  return transformSnakeToCamel<ReanalysisRsp>(data);
}
