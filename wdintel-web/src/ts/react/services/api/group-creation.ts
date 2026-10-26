import type { GroupCreationInfo } from '../../../../Bindings';
import { transformSnakeToCamel } from '../../../snake-to-camel';
import { postJson, type RequestOptions } from './client';

export async function getGroupCreationInfo(
  masterKey: string,
  options?: RequestOptions,
): Promise<GroupCreationInfo> {
  return transformSnakeToCamel(
    await postJson('/api/messenger/group-creation-info', masterKey, options),
  );
}
