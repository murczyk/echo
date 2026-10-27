/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DeviceFileGeodataPreviewRsp } from '../../../../../Bindings';
import { HttpRequestError } from '../../../services/api/client';
import { useDeviceFileGeodataPreview } from '../use-device-file-geodata-preview';
import type { DeviceFilePreviewSource } from '../use-device-file-preview';
const api = vi.hoisted(() => ({ get: vi.fn(), prepare: vi.fn(), retry: vi.fn() }));
vi.mock('../../../services/api/device-file-preview', async (original) => ({
  ...(await original<object>()),
  getDeviceFileGeodataStatus: api.get,
  prepareDeviceFileGeodata: api.prepare,
  retryDeviceFileGeodata: api.retry,
}));
const source: DeviceFilePreviewSource = {
  key: 'device/file/1',
  deviceId: 'device',
  fileId: 'file',
  revision: 1,
  originalHref: '/original',
  fileName: 'map.gpx',
  extension: 'gpx',
  contentType: 'application/gpx+xml',
  sizeBytes: 100,
};
function status(state: DeviceFileGeodataPreviewRsp['status']): DeviceFileGeodataPreviewRsp {
  return {
    fileId: source.fileId,
    revision: 1,
    generation: state === 'idle' ? null : 'generation',
    status: state,
    retryable: state === 'failed',
    retryAfterMs: null,
    resultSizeBytes: state === 'ready' ? 100 : null,
    resultUrl:
      state === 'ready'
        ? '/api/device/files/device/file/revisions/1/preview/geodata/generation/content'
        : null,
    errorCode: null,
    errorMessage: null,
  };
}
let host: HTMLDivElement;
let root: Root;
let controller: AbortController;
let latest: ReturnType<typeof useDeviceFileGeodataPreview>;
const onError = vi.fn();
const lifecycle = {
  signal: new AbortController().signal,
  onError,
  isCurrent: () => true,
  registerCleanup: () => () => {},
};
function Harness({ selected = source }: { selected?: DeviceFilePreviewSource }) {
  latest = useDeviceFileGeodataPreview(selected, { ...lifecycle, signal: controller.signal });
  return <span>{latest.state}</span>;
}
beforeEach(() => {
  vi.useFakeTimers();
  controller = new AbortController();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  api.get.mockReset();
  api.prepare.mockReset();
  api.retry.mockReset();
  onError.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});
async function mount() {
  await act(async () => root.render(<Harness />));
}
it('prepares only idle selected revision and receives current generation', async () => {
  api.get.mockResolvedValueOnce(status('idle')).mockResolvedValue(status('ready'));
  api.prepare.mockResolvedValue(status('queued'));
  await mount();
  expect(api.prepare).toHaveBeenCalledTimes(1);
  expect(latest.state).toBe('preparing');
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(latest.status?.generation).toBe('generation');
  expect(latest.state).toBe('ready');
});
it('stops the visible window and refreshes status without a second job', async () => {
  api.get.mockResolvedValue(status('running'));
  await mount();
  await act(async () => vi.advanceTimersByTimeAsync(120000));
  expect(latest.state).toBe('waiting');
  expect(api.get.mock.calls.length).toBeLessThanOrEqual(60);
  expect(api.prepare).not.toHaveBeenCalled();
  const previous = api.get.mock.calls.length;
  await act(async () => latest.refresh());
  expect(api.get.mock.calls.length).toBeGreaterThan(previous);
  expect(api.prepare).not.toHaveBeenCalled();
});
it('aborts polling and forwards typed current access denial', async () => {
  const error = new HttpRequestError(403, 'Denied');
  api.get.mockRejectedValue(error);
  await mount();
  expect(onError).toHaveBeenCalledWith(error);
  controller.abort();
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(api.get).toHaveBeenCalledTimes(1);
});
it('refreshes409 after a retry with the displayed generation', async () => {
  api.get.mockResolvedValueOnce(status('failed')).mockResolvedValue(status('ready'));
  api.retry.mockRejectedValue(new HttpRequestError(409, 'Changed'));
  await mount();
  await act(async () => latest.retry());
  expect(api.retry).toHaveBeenCalledWith(
    source,
    { expectedGeneration: 'generation' },
    expect.any(AbortSignal),
  );
  expect(latest.state).toBe('ready');
  expect(onError).not.toHaveBeenCalled();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const other = { ...source, key: 'device/other/2', fileId: 'other', revision: 2 };
async function select(selected: DeviceFilePreviewSource) {
  await act(async () => root.render(<Harness selected={selected} />));
}
it('ignores retired status and errors after A to B to A', async () => {
  const retired = deferred<DeviceFileGeodataPreviewRsp>();
  const retiredError = deferred<DeviceFileGeodataPreviewRsp>();
  api.get
    .mockReturnValueOnce(retired.promise)
    .mockReturnValueOnce(retiredError.promise)
    .mockResolvedValue(status('ready'));
  await mount();
  await select(other);
  await select(source);
  await act(async () => {
    retired.resolve(status('idle'));
    retiredError.reject(new HttpRequestError(403, 'Retired denial'));
  });
  expect(latest.state).toBe('ready');
  expect(api.prepare).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
});
it('rejects a different revision and external ready-result URL', async () => {
  api.get.mockResolvedValueOnce({ ...status('ready'), revision: 2 });
  await mount();
  expect(onError).toHaveBeenCalledTimes(1);
  expect(latest.state).not.toBe('ready');
  onError.mockReset();
  api.get.mockResolvedValue({ ...status('ready'), resultUrl: 'https://example.test/result.kmz' });
  await act(async () => latest.refresh());
  expect(onError).toHaveBeenCalledTimes(1);
  expect(latest.state).not.toBe('ready');
});
it('enables only the current failed generation after its cooldown', async () => {
  api.get.mockResolvedValue({ ...status('failed'), retryAfterMs: 3000 });
  await mount();
  expect(latest.canRetry).toBe(false);
  await act(async () => latest.retry());
  expect(api.retry).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(latest.canRetry).toBe(true);
});
it('lets a new session retry while a retired retry is still pending', async () => {
  const retired = deferred<DeviceFileGeodataPreviewRsp>();
  api.get.mockImplementation((selected: DeviceFilePreviewSource) =>
    Promise.resolve({ ...status('failed'), fileId: selected.fileId, revision: selected.revision }),
  );
  api.retry.mockReturnValueOnce(retired.promise).mockResolvedValue(status('queued'));
  await mount();
  act(() => void latest.retry());
  await select(other);
  await select(source);
  act(() => void latest.retry());
  expect(api.retry).toHaveBeenCalledTimes(2);
  await act(async () => retired.resolve(status('queued')));
});
