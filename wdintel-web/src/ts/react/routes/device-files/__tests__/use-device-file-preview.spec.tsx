/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceFileTreeEntry } from '../../../../../Bindings';
import { DeviceFileContentPane } from '../components/DeviceFileContentPane';
import { AUTH_UNAUTHORIZED_EVENT } from '../../../auth-redirect';
import { HttpRequestError } from '../../../services/api/client';
import { useDeviceFilePreview } from '../use-device-file-preview';

const entry: DeviceFileTreeEntry = {
  entryId: 'entry-a',
  parentEntryId: 'root',
  kind: 'file',
  fileId: 'file-a',
  name: 'notes.txt',
  pathComponents: ['notes.txt'],
  absolutePath: null,
  hasContent: true,
  mimeType: 'text/plain',
  extension: 'txt',
  contentUploadedAt: null,
  fileMetadataCreatedAt: null,
  fileMetadataModifiedAt: null,
  createdAt: '2026-10-07T00:00:00Z',
  updatedAt: '2026-10-07T00:00:00Z',
  revision: 1,
  syncId: null,
  sourceFileState: null,
  tags: [],
  archive: null,
};
let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn<typeof fetch>();
let latest: ReturnType<typeof useDeviceFilePreview>;
function Harness({ file }: { file: DeviceFileTreeEntry | null }) {
  latest = useDeviceFilePreview({ deviceId: 'device', file });
  return (
    <>
      <span data-testid="state">{latest.state}</span>
      <span data-testid="source">{latest.source?.fileName}</span>
      <span data-testid="error">{latest.error}</span>
      <button
        disabled={!latest.canDownload || latest.downloading}
        onClick={() => void latest.download()}
      >
        Скачати файл
      </button>
      <button onClick={latest.retry}>Повторити</button>
    </>
  );
}
async function select(file: DeviceFileTreeEntry | null = entry) {
  await act(async () => root.render(<Harness file={file} />));
}
function state() {
  return container.querySelector('[data-testid="state"]')?.textContent;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function head(size = '10') {
  return new Response(null, { headers: { 'content-length': size } });
}

async function show(file: DeviceFileTreeEntry | null = entry) {
  await act(async () => {
    root.render(<DeviceFileContentPane deviceId="device" file={file} />);
  });
}
function downloadButton() {
  return [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Скачати файл'),
  )!;
}
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// Authorization regression for specs/002-device-file-formats/contracts/ui.md.
describe('device file preview access', () => {
  it('#3778 opens A to B to A with fresh revision sessions and ignores the original A response', async () => {
    const first = deferred<Response>();
    fetchMock
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(head('22'))
      .mockResolvedValueOnce(head('11'));
    await select(entry);
    const firstSignal = latest.signal;
    const firstError = latest.onError;
    const firstEpoch = latest.epoch;
    const dispose = vi.fn();
    latest.registerCleanup(dispose);
    await select({ ...entry, revision: 2 });
    expect(latest.source?.key).toBe('device/file-a/2');
    await select(entry);
    await act(async () => {
      first.resolve(head('999'));
      firstError(new HttpRequestError(403, 'obsolete A'));
    });
    expect(firstSignal?.aborted).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(latest.epoch).not.toBe(firstEpoch);
    expect(latest.source).toMatchObject({ key: 'device/file-a/1', sizeBytes: 11 });
    expect(state()).toBe('ready');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/device/files/device/file-a/revisions/1/content',
      '/api/device/files/device/file-a/revisions/2/content',
      '/api/device/files/device/file-a/revisions/1/content',
    ]);
  });

  it.each(['request', 'body'])(
    'times out a stalled image %s and opens it after Retry',
    async (stage) => {
      await import('../components/DeviceFileImagePreview');
      vi.useFakeTimers();
      const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:image-retry');
      let pendingSignal: AbortSignal;
      fetchMock.mockResolvedValueOnce(head()).mockImplementationOnce((_url, options) => {
        pendingSignal = options!.signal!;
        const pending = new Promise<never>((_resolve, reject) => {
          pendingSignal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        });
        if (stage === 'request') return pending;
        const response = new Response(null);
        vi.spyOn(response, 'blob').mockReturnValue(pending);
        return Promise.resolve(response);
      });
      try {
        await show({ ...entry, name: 'capture.png', extension: 'png', mimeType: 'image/png' });
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        await act(async () => vi.advanceTimersByTimeAsync(75_000));
        expect(pendingSignal!.aborted).toBe(true);
        expect(container.textContent).toContain('Час очікування');
        expect(downloadButton().disabled).toBe(false);
        expect(createUrl).not.toHaveBeenCalled();
        const retry = [...container.querySelectorAll('button')].find(
          (button) => button.textContent === 'Повторити',
        )!;
        expect(retry).toBeDefined();
        fetchMock.mockResolvedValueOnce(head()).mockResolvedValueOnce(new Response('image bytes'));
        await act(async () => retry.click());
        expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:image-retry');
        expect(container.textContent).not.toContain('Час очікування');
        expect(fetchMock).toHaveBeenCalledTimes(4);
      } finally {
        createUrl.mockRestore();
      }
    },
  );

  it('times out a pending initial HEAD and recovers through a fresh Retry', async () => {
    await import('../../shared/message-card/renderers/DocumentFilePreview');
    vi.useFakeTimers();
    let pendingSignal: AbortSignal;
    fetchMock
      .mockImplementationOnce((_url, options) => {
        pendingSignal = options!.signal!;
        return new Promise((_resolve, reject) => {
          pendingSignal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        });
      })
      .mockResolvedValueOnce(head())
      .mockResolvedValueOnce(new Response('Перегляд відновлено'));
    await show();
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(container.textContent).toContain('Час очікування');
    expect(pendingSignal!.aborted).toBe(true);
    const retry = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Повторити',
    )!;
    expect(retry).toBeDefined();
    await act(async () => retry.click());
    expect(downloadButton().disabled).toBe(false);
    expect(container.textContent).not.toContain('Час очікування');
    vi.useRealTimers();
    await vi.waitFor(() => expect(container.textContent).toContain('Перегляд відновлено'));
  });

  it('times out a pending repeated access HEAD and keeps Retry available', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(head()).mockImplementationOnce(() => new Promise(() => {}));
    await select();
    let allowed: boolean | undefined;
    await act(async () => {
      void latest.checkAccess().then((result) => {
        allowed = result;
      });
    });
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(allowed).toBe(false);
    expect(state()).toBe('transient-error');
    expect(container.querySelector('[data-testid="error"]')?.textContent).toContain(
      'Час очікування',
    );
    fetchMock.mockResolvedValueOnce(head());
    await act(async () => latest.retry());
    expect(state()).toBe('ready');
  });

  it.each([403, 404])('disables original download after HEAD returns %s', async (status) => {
    fetchMock.mockResolvedValue(new Response('Access denied', { status }));
    await show();
    expect(container.textContent).toContain('Помилка');
    expect(downloadButton().disabled).toBe(true);
  });

  it('rejects late HEAD and leaf callbacks across A → B → A and aborts every replaced session', async () => {
    const requests = [deferred<Response>(), deferred<Response>(), deferred<Response>()];
    fetchMock
      .mockImplementationOnce(() => requests[0].promise)
      .mockImplementationOnce(() => requests[1].promise)
      .mockImplementationOnce(() => requests[2].promise);
    await select();
    const firstSignal = latest.signal;
    const firstError = latest.onError;
    await select({ ...entry, entryId: 'entry-b', fileId: 'file-b', name: 'other.txt' });
    const secondSignal = latest.signal;
    await select();
    expect(firstSignal?.aborted).toBe(true);
    expect(secondSignal?.aborted).toBe(true);
    await act(async () => {
      requests[0].resolve(head('0'));
      requests[1].resolve(head('0'));
      firstError(new HttpRequestError(403, 'stale worker callback'));
    });
    expect(state()).toBe('loading');
    expect(downloadButton().disabled).toBe(true);
    await act(async () => requests[2].resolve(head()));
    expect(state()).toBe('ready');
    expect(container.querySelector('[data-testid="source"]')?.textContent).toBe('notes.txt');
  });

  it('starts a fresh retry epoch and ignores callbacks from the previous attempt', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('Retry later', { status: 503 }))
      .mockResolvedValueOnce(head());
    await select();
    expect(state()).toBe('transient-error');
    const firstEpoch = latest.epoch;
    const oldError = latest.onError;
    await act(async () => latest.retry());
    expect(state()).toBe('ready');
    expect(latest.epoch).toBeGreaterThan(firstEpoch!);
    await act(async () => oldError(new HttpRequestError(404, 'old parse result')));
    expect(state()).toBe('ready');
    expect(downloadButton().disabled).toBe(false);
  });

  it('#3930 clears image dimensions and ignores stale loads after a revision change or denial', async () => {
    fetchMock.mockImplementation(async () => head());
    const imageFile = { ...entry, name: 'capture.png', extension: 'png', mimeType: 'image/png' };
    const image = document.createElement('img');
    Object.defineProperties(image, {
      naturalWidth: { value: 640 },
      naturalHeight: { value: 480 },
    });
    await select(imageFile);
    const firstLoad = latest.onImageLoad;
    await act(async () => firstLoad(image));
    expect(latest.imageSize).toEqual({ width: 640, height: 480 });
    await select({ ...imageFile, revision: 2 });
    expect(latest.imageSize).toBeNull();
    await act(async () => firstLoad(image));
    expect(latest.imageSize).toBeNull();
    const currentLoad = latest.onImageLoad;
    await act(async () => currentLoad(image));
    expect(latest.imageSize).toEqual({ width: 640, height: 480 });
    await act(async () => latest.onError(new HttpRequestError(403, 'revoked')));
    expect(latest.imageSize).toBeNull();
    await act(async () => currentLoad(image));
    expect(latest.imageSize).toBeNull();
    expect(latest.source).toBeNull();
  });

  it('#3930 clears media duration and ignores stale metadata after a revision change or denial', async () => {
    fetchMock.mockImplementation(async () => head());
    const audioFile = { ...entry, name: 'audio.m4a', extension: 'm4a', mimeType: 'audio/mp4' };
    await select(audioFile);
    const firstDuration = latest.onDurationChange;
    await act(async () => firstDuration(123.5));
    expect(latest.durationSeconds).toBe(123.5);
    await select({ ...audioFile, revision: 2 });
    expect(latest.durationSeconds).toBeNull();
    await act(async () => {
      firstDuration(123.5);
      latest.onDurationChange(Number.NaN);
      latest.onDurationChange(Number.POSITIVE_INFINITY);
    });
    expect(latest.durationSeconds).toBeNull();
    const currentDuration = latest.onDurationChange;
    await act(async () => currentDuration(456));
    expect(latest.durationSeconds).toBe(456);
    await act(async () => latest.onError(new HttpRequestError(403, 'revoked')));
    expect(latest.durationSeconds).toBeNull();
    await act(async () => currentDuration(789));
    expect(latest.durationSeconds).toBeNull();
    expect(latest.source).toBeNull();
  });

  it.each([403, 404])(
    'clears registered leaf resources and disables download for a revoked %s',
    async (status) => {
      fetchMock.mockResolvedValue(head());
      await select();
      const signal = latest.signal;
      const dispose = vi.fn();
      latest.registerCleanup(dispose);
      await act(async () => latest.onError(new HttpRequestError(status, 'revoked')));
      expect(state()).toBe('denied');
      expect(downloadButton().disabled).toBe(true);
      expect(signal?.aborted).toBe(true);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(latest.source).toBeNull();
    },
  );

  it('emits the existing logout event and denies a checked GET returning 401 after successful HEAD', async () => {
    const unauthorized = vi.fn();
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, unauthorized);
    fetchMock
      .mockResolvedValueOnce(head())
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    await select();
    await act(async () => downloadButton().click());
    expect(unauthorized).toHaveBeenCalled();
    expect(state()).toBe('denied');
    expect(downloadButton().disabled).toBe(true);
    expect(latest.signal?.aborted).toBe(true);
    window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, unauthorized);
  });

  it('does not fetch or prepare directories, metadata-only entries, or a closed selection', async () => {
    await select({ ...entry, kind: 'directory' });
    expect(state()).toBe('idle');
    await select({ ...entry, hasContent: false });
    expect(state()).toBe('idle');
    await select(null);
    expect(state()).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(downloadButton().disabled).toBe(true);
  });

  it('shows a zero-byte source as empty without starting a leaf GET', async () => {
    fetchMock.mockResolvedValue(head('0'));
    await show();
    expect(container.textContent).toContain('Файл порожній');
    expect(fetchMock.mock.calls.map(([, options]) => options?.method)).toEqual(['HEAD']);
    expect(downloadButton().disabled).toBe(false);
  });

  it('does not interpret missing byte metadata as an empty file', async () => {
    fetchMock.mockResolvedValue(head(''));
    await select();
    expect(state()).toBe('ready');
    expect(latest.source?.sizeBytes).toBeNull();
  });

  it('routes a typed 401 leaf callback to the existing logout lifecycle', async () => {
    const unauthorized = vi.fn();
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, unauthorized);
    fetchMock.mockResolvedValue(head());
    await select();
    await act(async () => latest.onError(new HttpRequestError(401, 'expired')));
    expect(state()).toBe('denied');
    expect(downloadButton().disabled).toBe(true);
    expect(unauthorized).toHaveBeenCalledTimes(1);
    window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, unauthorized);
  });

  it('never saves an old checked download after selection changes', async () => {
    const bytes = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(head())
      .mockImplementationOnce(() => bytes.promise)
      .mockResolvedValueOnce(head());
    const createUrl = vi.spyOn(URL, 'createObjectURL');
    await select();
    const download = latest.download;
    let pending: Promise<void>;
    await act(async () => {
      pending = download();
    });
    const oldSignal = latest.signal;
    await select({ ...entry, fileId: 'file-b', name: 'other.txt' });
    await act(async () => {
      bytes.resolve(new Response('old bytes'));
      await pending;
    });
    expect(state()).toBe('ready');
    expect(oldSignal?.aborted).toBe(true);
    expect(createUrl).not.toHaveBeenCalled();
    createUrl.mockRestore();
  });

  it('aborts and cleans resources on close, then rejects late callbacks on reopen', async () => {
    fetchMock.mockResolvedValue(head());
    await select();
    const signal = latest.signal;
    const dispose = vi.fn();
    latest.registerCleanup(dispose);
    const oldError = latest.onError;
    await select(null);
    expect(signal?.aborted).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
    await select();
    await act(async () => oldError(new HttpRequestError(403, 'closed worker result')));
    expect(state()).toBe('ready');
  });
});
