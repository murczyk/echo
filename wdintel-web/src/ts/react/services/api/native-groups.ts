import type {
  NativeGroupCreateReq,
  NativeGroupDetail,
  NativeGroupUpdateReq,
} from '../../../../Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';
import { postJson, type RequestOptions } from './client';

export async function createNativeGroup(req: NativeGroupCreateReq): Promise<NativeGroupDetail> {
  return transformSnakeToCamel(
    await postJson('/api/messenger/native-groups/create', transformCamelToSnake(req)),
  );
}

export async function getNativeGroup(
  masterKey: string,
  options?: RequestOptions,
): Promise<NativeGroupDetail> {
  return transformSnakeToCamel(
    await postJson('/api/messenger/native-groups/get', masterKey, options),
  );
}

export async function updateNativeGroup(req: NativeGroupUpdateReq): Promise<NativeGroupDetail> {
  return transformSnakeToCamel(
    await postJson('/api/messenger/native-groups/update', transformCamelToSnake(req)),
  );
}
