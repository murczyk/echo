import type {
  ArchiveDeviceReq,
  CreateDeviceReq,
  DeviceDetailReq,
  DeviceDetails,
  DeviceTag,
  DeviceUnitStatRow,
  ListDevicesReq,
  ListDevicesRsp,
  RestoreDeviceReq,
} from '../../../../Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';
import { postJson } from './client';
import type { RequestOptions } from './client';

export type DeviceUpdatePatchInput = {
  deviceId: string;
  sourceLabel?: string;
  name?: string;
  aorIds?: number[];
  unitId?: number | null;
  tags?: DeviceTag[];
  externalUrl?: string | null;
  customFields?: Record<string, string | null>;
};

type DeviceUpdatePatchReq = {
  deviceId: string;
  sourceLabel?: string;
  name?: string;
  aorIds?: number[];
  unitId?: number | null;
  tags?: DeviceTag[];
  externalUrl?: string | null;
  customFields?: Record<string, string | null>;
};

export function toDeviceUpdatePatchReq(input: DeviceUpdatePatchInput): DeviceUpdatePatchReq {
  const req: DeviceUpdatePatchReq = { deviceId: input.deviceId };

  const { sourceLabel, name, tags } = input;

  if (sourceLabel !== undefined && sourceLabel !== null) {
    req.sourceLabel = sourceLabel;
  }
  if (name !== undefined && name !== null) {
    req.name = name;
  }
  if (input.aorIds !== undefined) {
    req.aorIds = input.aorIds;
  }
  if (input.unitId !== undefined) {
    req.unitId = input.unitId;
  }
  if (tags !== undefined && tags !== null) {
    req.tags = tags;
  }
  if (input.externalUrl !== undefined) {
    req.externalUrl = input.externalUrl;
  }
  if (input.customFields !== undefined) {
    req.customFields = input.customFields;
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

export async function archiveDevice(
  req: ArchiveDeviceReq,
  options?: RequestOptions,
): Promise<DeviceDetails> {
  const data = await postJson<DeviceDetails>(
    '/api/device/archive',
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
