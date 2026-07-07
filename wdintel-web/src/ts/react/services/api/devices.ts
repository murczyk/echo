import type {
  CreateDeviceFileItem,
  CreateDeviceFilesReq,
  CreateDeviceFilesRsp,
  CreateDeviceReq,
  DeleteDeviceFileReq,
  DeleteDeviceReq,
  DeviceCustomField,
  DeviceDetailReq,
  DeviceDetails,
  DeviceFileEntry,
  DeviceUnitStatRow,
  ListDeviceFilesReq,
  ListDeviceFilesRsp,
  ListDevicesReq,
  ListDevicesRsp,
  RestoreDeviceFileReq,
  RestoreDeviceReq,
} from '../../../../Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';
import { postJson } from './client';
import type { RequestOptions } from './client';

export type DeviceUpdatePatchInput = {
  deviceId: string;
  name?: string;
  aorIds?: number[];
  unitId?: number | null;
  customFields?: DeviceCustomField[];
  externalUrl?: string | null;
  files?: CreateDeviceFileItem[];
};

type DeviceUpdatePatchReq = {
  deviceId: string;
  name?: string;
  aorIds?: number[];
  unitId?: number | null;
  customFields?: DeviceCustomField[];
  externalUrl?: string | null;
  files?: CreateDeviceFileItem[];
};

export function toDeviceUpdatePatchReq(input: DeviceUpdatePatchInput): DeviceUpdatePatchReq {
  const req: DeviceUpdatePatchReq = { deviceId: input.deviceId };

  const name = (input as { name?: string | null }).name;
  const customFields = (input as { customFields?: DeviceCustomField[] | null }).customFields;

  if (name !== undefined && name !== null) {
    req.name = name;
  }
  if (input.aorIds !== undefined) {
    req.aorIds = input.aorIds;
  }
  if (input.unitId !== undefined) {
    req.unitId = input.unitId;
  }
  if (customFields !== undefined && customFields !== null) {
    req.customFields = customFields;
  }
  if (input.externalUrl !== undefined) {
    req.externalUrl = input.externalUrl;
  }
  if (Array.isArray(input.files) && input.files.length > 0) {
    req.files = input.files;
  }

  return req;
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

export async function getDeviceUnitStats(options?: RequestOptions): Promise<DeviceUnitStatRow[]> {
  const data = await postJson<{ units: Array<{ unit_id: number; count: number }> }>(
    '/api/device/unit-stats',
    undefined,
    options,
  );
  const normalized = transformSnakeToCamel<{ units: DeviceUnitStatRow[] }>(data);
  return normalized.units ?? [];
}

export async function getDeviceDetail(
  req: DeviceDetailReq,
  options?: RequestOptions,
): Promise<DeviceDetails> {
  const data = await postJson<DeviceDetails>(
    '/api/device/detail',
    transformCamelToSnake(req),
    options,
  );
  return transformSnakeToCamel<DeviceDetails>(data);
}

export async function createDevice(
  req: CreateDeviceReq,
  options?: RequestOptions,
): Promise<DeviceDetails> {
  const data = await postJson<DeviceDetails>(
    '/api/device/create',
    transformCamelToSnake(req),
    options,
  );
  return transformSnakeToCamel<DeviceDetails>(data);
}

export async function updateDevice(
  input: DeviceUpdatePatchInput,
  options?: RequestOptions,
): Promise<DeviceDetails> {
  const data = await postJson<DeviceDetails>(
    '/api/device/update',
    transformCamelToSnake(toDeviceUpdatePatchReq(input)),
    options,
  );
  return transformSnakeToCamel<DeviceDetails>(data);
}

export async function deleteDevice(
  req: DeleteDeviceReq,
  options?: RequestOptions,
): Promise<DeviceDetails> {
  const data = await postJson<DeviceDetails>(
    '/api/device/delete',
    transformCamelToSnake(req),
    options,
  );
  return transformSnakeToCamel<DeviceDetails>(data);
}

export async function restoreDevice(
  req: RestoreDeviceReq,
  options?: RequestOptions,
): Promise<DeviceDetails> {
  const data = await postJson<DeviceDetails>(
    '/api/device/restore',
    transformCamelToSnake(req),
    options,
  );
  return transformSnakeToCamel<DeviceDetails>(data);
}

export async function listDeviceFiles(
  req: ListDeviceFilesReq,
  options?: RequestOptions,
): Promise<ListDeviceFilesRsp> {
  const data = await postJson<ListDeviceFilesRsp>(
    '/api/device/files/list',
    transformCamelToSnake(req),
    options,
  );
  return transformSnakeToCamel<ListDeviceFilesRsp>(data);
}

export async function createDeviceFiles(
  req: CreateDeviceFilesReq,
  options?: RequestOptions,
): Promise<CreateDeviceFilesRsp> {
  const data = await postJson<CreateDeviceFilesRsp>(
    '/api/device/files/create',
    transformCamelToSnake(req),
    options,
  );
  return transformSnakeToCamel<CreateDeviceFilesRsp>(data);
}

export async function deleteDeviceFile(
  req: DeleteDeviceFileReq,
  options?: RequestOptions,
): Promise<DeviceFileEntry> {
  const data = await postJson<DeviceFileEntry>(
    '/api/device/files/delete',
    transformCamelToSnake(req),
    options,
  );
  return transformSnakeToCamel<DeviceFileEntry>(data);
}

export async function restoreDeviceFile(
  req: RestoreDeviceFileReq,
  options?: RequestOptions,
): Promise<DeviceFileEntry> {
  const data = await postJson<DeviceFileEntry>(
    '/api/device/files/restore',
    transformCamelToSnake(req),
    options,
  );
  return transformSnakeToCamel<DeviceFileEntry>(data);
}
