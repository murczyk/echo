import type {
  DeviceAudioDetailReq,
  DeviceAudioPreparation,
  PrepareDeviceAudioReq,
  DeviceAudioDetails,
  ListDeviceAudioReq,
  ListDeviceAudioRsp,
  SaveDeviceAudioTranscriptionReq,
  SaveDeviceAudioTranscriptionRsp,
  SetDeviceAudioProcessingReq,
  SetDeviceAudioProcessingRsp,
} from '../../../../Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';
import { headResponse, postJson, type RequestOptions } from './client';

export async function listDeviceAudio(
  req: ListDeviceAudioReq,
  options?: RequestOptions,
): Promise<ListDeviceAudioRsp> {
  return transformSnakeToCamel(
    await postJson('/api/device/audio/list', transformCamelToSnake(req), options),
  );
}

export async function getDeviceAudioDetail(
  req: DeviceAudioDetailReq,
  options?: RequestOptions,
): Promise<DeviceAudioDetails> {
  return transformSnakeToCamel(
    await postJson('/api/device/audio/detail', transformCamelToSnake(req), options),
  );
}

export async function saveDeviceAudioTranscription(
  req: SaveDeviceAudioTranscriptionReq,
  options?: RequestOptions,
): Promise<SaveDeviceAudioTranscriptionRsp> {
  return transformSnakeToCamel(
    await postJson('/api/device/audio/transcription/save', transformCamelToSnake(req), options),
  );
}

export async function setDeviceAudioProcessing(
  req: SetDeviceAudioProcessingReq,
  options?: RequestOptions,
): Promise<SetDeviceAudioProcessingRsp> {
  return transformSnakeToCamel(
    await postJson('/api/device/audio/processing/set', transformCamelToSnake(req), options),
  );
}

export function headDeviceAudioContent(
  deviceId: string,
  audioId: string,
  options?: RequestOptions,
) {
  return headResponse(
    `/api/device/audio/${encodeURIComponent(deviceId)}/${encodeURIComponent(audioId)}/content`,
    options,
  );
}

export async function prepareDeviceAudio(
  req: PrepareDeviceAudioReq,
  options?: RequestOptions,
): Promise<DeviceAudioPreparation> {
  return transformSnakeToCamel(
    await postJson('/api/device/audio/playback/prepare', transformCamelToSnake(req), options),
  );
}
