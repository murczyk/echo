import type {
  ListDeviceAudioForwardingReq,
  ListDeviceAudioForwardingRsp,
  RemoveDeviceAudioForwardingReq,
} from '../../../../Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';
import { postJson, type RequestOptions } from './client';

export async function listDeviceAudioForwarding(
  request: ListDeviceAudioForwardingReq,
  options?: RequestOptions,
): Promise<ListDeviceAudioForwardingRsp> {
  const data = await postJson(
    '/api/device/audio/forwarding/list',
    transformCamelToSnake(request),
    options,
  );
  return transformSnakeToCamel<ListDeviceAudioForwardingRsp>(data);
}

export async function removeDeviceAudioForwarding(
  request: RemoveDeviceAudioForwardingReq,
): Promise<void> {
  await postJson('/api/device/audio/forwarding/remove', transformCamelToSnake(request));
}
