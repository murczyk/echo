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
  DeviceFileRoot,
  DeviceUnitStat,
  JournalDeviceFilesReq,
  JournalDeviceFilesRsp,
  FileSyncError,
  FileSyncOperation,
  ListDeviceFileRootsReq,
  ListDeviceFileRootsRsp,
  ListDevicesReq,
  ListDevicesRsp,
  ListUnitsRsp,
  SearchDeviceFilesReq,
  SearchDeviceFilesRsp,
  SyncDeviceFilesReq,
  SyncDeviceFilesRsp,
  Unit,
  UpdateDeviceReq,
} from '../../../../Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';
import { postJson } from './client';
import type { JsonBody, RequestOptions } from './client';

export type CreateDeviceInput = {
  name: CreateDeviceReq['name'];
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
      root: DeviceFileRoot;
      file: DeviceFile;
    }
  | {
      status: 'rejected';
      index: number;
      error: FileSyncError;
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

function serializeSyncRequest(req: SyncDeviceFilesReq): JsonBody {
  return {
    device_id: req.deviceId,
    path_syntax: req.pathSyntax,
    files: req.files.map(({ fileId, ...file }) => ({
      ...(fileId === null ? {} : { file_id: fileId }),
      ...transformCamelToSnake<Record<string, JsonBody>>(file),
    })),
  };
}

function normalizeSyncResponse(data: unknown): SyncDeviceFilesRsp {
  const response = transformSnakeToCamel<{ results: CamelFileSyncResult[] }>(data);
  return {
    results: response.results.map((result) => {
      if (result.status === 'accepted') {
        return {
          Accepted: {
            index: result.index,
            operation: result.operation,
            root: result.root,
            file: result.file,
          },
        };
      }
      return {
        Rejected: {
          index: result.index,
          error: result.error,
        },
      };
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
  const data = await postJson('/api/device/files/sync', serializeSyncRequest(req), options);
  return normalizeSyncResponse(data);
}
