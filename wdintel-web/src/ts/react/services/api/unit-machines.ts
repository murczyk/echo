import type {
  UnitMachineArchiveReq,
  UnitMachineCreateReq,
  UnitMachineItem,
  UnitMachineListReq,
  UnitMachineListRsp,
  UnitMachineMutationRsp,
  UnitMachineUpdateReq,
} from '../../../../Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';
import { postJson } from './client';
import type { RequestOptions } from './client';

export async function listUnitMachines(req: UnitMachineListReq, options?: RequestOptions): Promise<UnitMachineItem[]> {
  const data = await postJson<UnitMachineListRsp>('/api/unit-machines/list', transformCamelToSnake(req), options);
  return transformSnakeToCamel<UnitMachineListRsp>(data).items ?? [];
}

export async function createUnitMachine(req: UnitMachineCreateReq): Promise<UnitMachineMutationRsp> {
  const data = await postJson<UnitMachineMutationRsp>('/api/unit-machines/create', transformCamelToSnake(req));
  return transformSnakeToCamel<UnitMachineMutationRsp>(data);
}

export async function updateUnitMachine(req: UnitMachineUpdateReq): Promise<UnitMachineMutationRsp> {
  const data = await postJson<UnitMachineMutationRsp>('/api/unit-machines/update', transformCamelToSnake(req));
  return transformSnakeToCamel<UnitMachineMutationRsp>(data);
}

export async function archiveUnitMachine(req: UnitMachineArchiveReq): Promise<UnitMachineMutationRsp> {
  const data = await postJson<UnitMachineMutationRsp>('/api/unit-machines/archive', transformCamelToSnake(req));
  return transformSnakeToCamel<UnitMachineMutationRsp>(data);
}

export async function restoreUnitMachine(req: UnitMachineArchiveReq): Promise<UnitMachineMutationRsp> {
  const data = await postJson<UnitMachineMutationRsp>('/api/unit-machines/restore', transformCamelToSnake(req));
  return transformSnakeToCamel<UnitMachineMutationRsp>(data);
}
