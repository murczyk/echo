import type { GroupSendingSettings } from '../../../../Bindings';
import { transformSnakeToCamel } from '../../../snake-to-camel';
import { postJson, type RequestOptions } from './client';

export async function getGroupSendingSettings(
  masterKey: string,
  options?: RequestOptions,
): Promise<GroupSendingSettings> {
  return transformSnakeToCamel(
    await postJson('/api/messenger/group-sending-settings', masterKey, options),
  );
}
