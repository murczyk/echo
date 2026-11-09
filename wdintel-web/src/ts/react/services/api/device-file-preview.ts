import type {
  DeviceFileGeodataPreviewRsp,
  RetryDeviceFileGeodataPreviewReq,
} from '../../../../Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';
import type { DeviceFilePreviewSource } from '../../routes/device-files/use-device-file-preview';
import { getJson, getResponse, HttpRequestError, postJson } from './client';
import { getDeviceFileContent, getDeviceFileContentSize } from './devices';

export const DEVICE_FILE_PREVIEW_ACCESS_TIMEOUT_MS = 20_000;
export const DEVICE_IMAGE_PREVIEW_TIMEOUT_MS = 75_000;
export const DEVICE_MEDIA_PREVIEW_TIMEOUT_MS = 75_000;
export const DEVICE_GEODATA_PREVIEW_TIMEOUT_MS = 20_000;
const DEVICE_MEDIA_AUDIO_PREFIX_BYTES = 10;
function revisionPreviewUrl(source: DeviceFilePreviewSource) {
  return `/api/device/files/${encodeURIComponent(source.deviceId)}/${encodeURIComponent(source.fileId)}/revisions/${source.revision}/preview`;
}
export function deviceFileThumbnailUrl(
  source: Pick<DeviceFilePreviewSource, 'deviceId' | 'fileId' | 'revision'>,
) {
  return `/api/device/files/${encodeURIComponent(source.deviceId)}/${encodeURIComponent(source.fileId)}/revisions/${source.revision}/thumbnail`;
}
export function deviceFileMediaPreviewUrl(source: DeviceFilePreviewSource) {
  return `${revisionPreviewUrl(source)}/media`;
}
export async function withDevicePreviewDeadline<T>(
  signal: AbortSignal,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new HttpRequestError(0, 'Час очікування перегляду вичерпано. Повторіть спробу.'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}
export function getDeviceFilePreviewContentSize(href: string, signal: AbortSignal) {
  return withDevicePreviewDeadline(signal, DEVICE_FILE_PREVIEW_ACCESS_TIMEOUT_MS, (requestSignal) =>
    getDeviceFileContentSize(href, { signal: requestSignal }),
  );
}
export function getDeviceFilePreviewImage(href: string, signal: AbortSignal) {
  return withDevicePreviewDeadline(signal, DEVICE_IMAGE_PREVIEW_TIMEOUT_MS, (requestSignal) =>
    getDeviceFileContent(href, { signal: requestSignal }),
  );
}
export async function preflightDeviceFileMedia(
  source: DeviceFilePreviewSource,
  signal: AbortSignal,
) {
  const href = deviceFileMediaPreviewUrl(source);
  await withDevicePreviewDeadline(
    signal,
    DEVICE_MEDIA_PREVIEW_TIMEOUT_MS,
    async (requestSignal) => {
      const response = await getResponse(href, {
        signal: requestSignal,
        headers: { Range: 'bytes=0-0' },
      });
      const range = /^bytes 0-0\/([1-9]\d*)$/.exec(response.headers.get('content-range') ?? '');
      if (response.status !== 206 || response.headers.get('content-length') !== '1' || !range) {
        await response.body?.cancel();
        throw new HttpRequestError(0, 'Сервер не підтвердив доступ до медіафайлу.');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new HttpRequestError(0, 'Медіафайл не містить очікуваних даних.');
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1) throw new HttpRequestError(0, 'Некоректна відповідь медіафайлу.');
        }
        if (size !== 1) throw new HttpRequestError(0, 'Медіафайл не містить очікуваних даних.');
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    },
  );
  return href;
}
export function getDeviceFileMediaAudioPrefix(
  source: DeviceFilePreviewSource,
  signal: AbortSignal,
) {
  return withDevicePreviewDeadline(
    signal,
    DEVICE_FILE_PREVIEW_ACCESS_TIMEOUT_MS,
    async (requestSignal) => {
      const response = await getResponse(deviceFileMediaPreviewUrl(source), {
        signal: requestSignal,
        headers: { Range: `bytes=0-${DEVICE_MEDIA_AUDIO_PREFIX_BYTES - 1}` },
      });
      const range = /^bytes 0-(\d+)\/([1-9]\d*)$/.exec(response.headers.get('content-range') ?? '');
      const length = Math.min(DEVICE_MEDIA_AUDIO_PREFIX_BYTES, Number(range?.[2] ?? 0));
      if (
        response.status !== 206 ||
        !range ||
        Number(range[1]) !== length - 1 ||
        response.headers.get('content-length') !== String(length)
      ) {
        await response.body?.cancel();
        return null;
      }
      const reader = response.body?.getReader();
      if (!reader) return null;
      const prefix = new Uint8Array(length);
      let size = 0;
      try {
        while (size < length) {
          const { value, done } = await reader.read();
          if (done || value.byteLength > length - size) return null;
          prefix.set(value, size);
          size += value.byteLength;
        }
        return prefix;
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    },
  );
}
function geodataUrl(source: DeviceFilePreviewSource, suffix = '') {
  return `${revisionPreviewUrl(source)}/geodata${suffix}`;
}
export async function getDeviceFileGeodataStatus(
  source: DeviceFilePreviewSource,
  signal: AbortSignal,
) {
  return withDevicePreviewDeadline(
    signal,
    DEVICE_GEODATA_PREVIEW_TIMEOUT_MS,
    async (requestSignal) =>
      transformSnakeToCamel<DeviceFileGeodataPreviewRsp>(
        await getJson(geodataUrl(source), { signal: requestSignal }),
      ),
  );
}
export async function prepareDeviceFileGeodata(
  source: DeviceFilePreviewSource,
  signal: AbortSignal,
) {
  return withDevicePreviewDeadline(
    signal,
    DEVICE_GEODATA_PREVIEW_TIMEOUT_MS,
    async (requestSignal) =>
      transformSnakeToCamel<DeviceFileGeodataPreviewRsp>(
        await postJson(geodataUrl(source), undefined, {
          signal: requestSignal,
        }),
      ),
  );
}
export async function retryDeviceFileGeodata(
  source: DeviceFilePreviewSource,
  request: RetryDeviceFileGeodataPreviewReq,
  signal: AbortSignal,
) {
  return withDevicePreviewDeadline(
    signal,
    DEVICE_GEODATA_PREVIEW_TIMEOUT_MS,
    async (requestSignal) =>
      transformSnakeToCamel<DeviceFileGeodataPreviewRsp>(
        await postJson(geodataUrl(source, '/retry'), transformCamelToSnake(request), {
          signal: requestSignal,
        }),
      ),
  );
}
export function deviceFileGeodataResultUrl(source: DeviceFilePreviewSource, generation: string) {
  return geodataUrl(source, `/${encodeURIComponent(generation)}/content`);
}
