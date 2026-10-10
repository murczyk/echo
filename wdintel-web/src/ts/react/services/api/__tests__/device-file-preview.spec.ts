import { afterEach, expect, it, vi } from 'vitest';
import { HttpRequestError } from '../client';
import { preflightDeviceFileMedia, withDevicePreviewDeadline } from '../device-file-preview';
import type { DeviceFilePreviewSource } from '../../../routes/device-files/use-device-file-preview';
const source: DeviceFilePreviewSource = {
  key: 'device/file/2',
  deviceId: 'device',
  fileId: 'file',
  revision: 2,
  originalHref: '/original',
  fileName: 'clip.mp4',
  extension: 'mp4',
  contentType: 'video/mp4',
  sizeBytes: 3,
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('requires authenticated206 and exactly one byte before returning a native src', async () => {
  const fetch = vi.fn().mockResolvedValue(
    new Response(new Uint8Array([5]), {
      status: 206,
      headers: { 'Content-Range': 'bytes 0-0/3', 'Content-Length': '1' },
    }),
  );
  vi.stubGlobal('fetch', fetch);
  expect(await preflightDeviceFileMedia(source, new AbortController().signal)).toBe(
    '/api/device/files/device/file/revisions/2/preview/media',
  );
  expect(fetch.mock.calls[0][1]).toMatchObject({
    credentials: 'include',
    headers: { Range: 'bytes=0-0' },
  });
  expect(fetch.mock.calls[0][1].headers).not.toHaveProperty('If-Range');
});
it.each([
  [200, 'bytes 0-0/3', '1', 1],
  [206, 'bytes 1-1/3', '1', 1],
  [206, 'bytes 0-0/3', '2', 2],
  [206, 'bytes 0-0/3', '1', 0],
  [206, 'bytes 0-0/3', '1', 2],
])('rejects invalid preflight%s %s %s with%s bytes', async (status, range, length, bytes) => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(new Uint8Array(bytes), {
        status,
        headers: { 'Content-Range': range, 'Content-Length': length },
      }),
    ),
  );
  await expect(
    preflightDeviceFileMedia(source, new AbortController().signal),
  ).rejects.toBeInstanceOf(HttpRequestError);
});
it('retains typed denial', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Forbidden', { status: 403 })));
  await expect(
    preflightDeviceFileMedia(source, new AbortController().signal),
  ).rejects.toMatchObject({ status: 403 });
});
it('times out at75s, aborts the operation and reports a transport error', async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const operation = withDevicePreviewDeadline(new AbortController().signal, 75000, (current) => {
    signal = current;
    return new Promise(() => {});
  });
  const rejected = expect(operation).rejects.toMatchObject({ status: 0 });
  await vi.advanceTimersByTimeAsync(74999);
  expect(signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
  expect(signal?.aborted).toBe(true);
});
it('pre-aborted lifecycle issues no request', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  controller.abort();
  await expect(preflightDeviceFileMedia(source, controller.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(fetch).not.toHaveBeenCalled();
});
