/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { DeviceFileTreeEntry } from '../../../../../../Bindings';
import { DeviceFileCards } from '../DeviceFileCards';

vi.mock('../../../../auth-redirect', () => ({
  AUTH_UNAUTHORIZED_EVENT: 'echo:api-unauthorized',
  emitUnauthorizedEvent: () => window.dispatchEvent(new Event('echo:api-unauthorized')),
}));

let container: HTMLDivElement;
let root: Root;
const onOpen = vi.fn();
const onFavorite = vi.fn();
function entry(overrides: Partial<DeviceFileTreeEntry> = {}): DeviceFileTreeEntry {
  return {
    entryId: 'file-1',
    parentEntryId: 'root',
    fileId: 'file-1',
    kind: 'file',
    name: 'report.pdf',
    pathComponents: ['report.pdf'],
    absolutePath: 'C:\\report.pdf',
    hasContent: false,
    mimeType: 'application/pdf',
    extension: 'pdf',
    contentUploadedAt: null,
    fileMetadataCreatedAt: '2026-10-01T12:00:00Z',
    fileMetadataModifiedAt: '2026-10-02T12:00:00Z',
    createdAt: '2026-10-03T12:00:00Z',
    updatedAt: '2026-10-03T12:00:00Z',
    revision: 1,
    syncId: null,
    sourceFileState: null,
    tags: [],
    archive: null,
    isArchive: false,
    archiveOrigin: null,
    virtualPath: null,
    isFavorite: false,
    isViewed: false,
    sizeBytes: 2048,
    ...overrides,
  };
}
beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', undefined);
  vi.stubGlobal('fetch', vi.fn());
  let imageNumber = 0;
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => `blob:thumbnail-${++imageNumber}`);
      static revokeObjectURL = vi.fn();
    },
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mediaEntry(overrides: Partial<DeviceFileTreeEntry> = {}) {
  return entry({
    name: 'image.jpg',
    extension: 'jpg',
    mimeType: 'image/jpeg',
    hasContent: true,
    ...overrides,
  });
}

function response(status: number) {
  return {
    status,
    headers: new Headers({ 'Retry-After': '2' }),
    blob: async () => new Blob(['jpeg'], { type: 'image/jpeg' }),
  } as Response;
}

async function renderFiles(entries: DeviceFileTreeEntry[], viewMode: 'grid' | 'list' = 'grid') {
  await act(async () =>
    root.render(
      <DeviceFileCards
        deviceId="device-1"
        entries={entries}
        viewMode={viewMode}
        onOpen={onOpen}
        onFavorite={onFavorite}
      />,
    ),
  );
}

function observeThumbnails() {
  const observers = new Map<Element, IntersectionObserverCallback>();
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        observers.set(target, this.callback);
      }
      disconnect() {}
    },
  );
  return async (active: boolean) => {
    await act(async () => {
      for (const [target, callback] of observers)
        callback(
          [{ target, isIntersecting: active } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
    });
  };
}

it('#3930 requests exact member thumbnails lazily without opening or downloading originals', async () => {
  const activate = observeThumbnails();
  vi.mocked(fetch).mockResolvedValue(response(200));
  const member = mediaEntry({
    fileId: 'archive-member',
    revision: 7,
    archiveOrigin: { archiveId: 'archive-job', sourceFileId: 'archive-file', sourceRevision: 3 },
    sizeBytes: 1_000_000_000,
  });
  await renderFiles([
    member,
    mediaEntry({ entryId: 'missing', hasContent: false }),
    mediaEntry({ entryId: 'large', sizeBytes: 1_000_000_001 }),
    entry({ entryId: 'text', hasContent: true }),
  ]);
  expect(fetch).not.toHaveBeenCalled();
  await activate(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(
    '/api/device/files/device-1/archive-member/revisions/7/thumbnail',
    expect.objectContaining({ cache: 'no-store', credentials: 'same-origin' }),
  );
  const image = container.querySelector<HTMLImageElement>('[data-device-file-thumbnail-image]')!;
  await act(async () => image.dispatchEvent(new Event('load')));
  expect(image.classList.contains('object-cover')).toBe(true);
  expect(container.querySelector('video')).toBeNull();
  expect(container.querySelector('button button')).toBeNull();
  expect(onOpen).not.toHaveBeenCalled();
  expect(container.textContent).toContain('нове');
  await activate(false);
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  await activate(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  act(() =>
    container.querySelector<HTMLButtonElement>('[aria-label="Відкрити файл image.jpg"]')!.click(),
  );
  expect(onOpen).toHaveBeenCalledWith(member);
});

it('#3930 limits grid requests to four and cancels queued thumbnails when switching to the table', async () => {
  const complete: ((result: Response) => void)[] = [];
  vi.mocked(fetch).mockImplementation(() => new Promise((resolve) => complete.push(resolve)));
  const files = Array.from({ length: 8 }, (_, i) =>
    mediaEntry({ entryId: `entry-${i}`, fileId: `file-${i}` }),
  );
  await renderFiles(files);
  expect(fetch).toHaveBeenCalledTimes(4);
  const signals = vi.mocked(fetch).mock.calls.map(([, options]) => options?.signal);
  await renderFiles(files, 'list');
  expect(signals.every((signal) => signal?.aborted)).toBe(true);
  await act(async () => complete.forEach((finish) => finish(response(200))));
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it('#3930 rejects late revision responses and removes loaded blobs on access loss', async () => {
  let finishOld!: (result: Response) => void;
  vi.mocked(fetch)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    )
    .mockResolvedValueOnce(response(200));
  await renderFiles([mediaEntry()]);
  const oldSignal = vi.mocked(fetch).mock.calls[0][1]?.signal;
  await renderFiles([mediaEntry({ revision: 2 })]);
  expect(oldSignal?.aborted).toBe(true);
  const image = container.querySelector<HTMLImageElement>('[data-device-file-thumbnail-image]')!;
  await act(async () => image.dispatchEvent(new Event('load')));
  await act(async () => finishOld(response(422)));
  expect(container.querySelector('[data-device-file-thumbnail-state="loaded"]')).not.toBeNull();
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  await act(async () => window.dispatchEvent(new Event('echo:api-unauthorized')));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:thumbnail-1');
  expect(container.querySelector('[data-device-file-thumbnail-image]')).toBeNull();
  expect(container.querySelector('[data-device-file-thumbnail-state="failed"]')).not.toBeNull();
});

it('#3930 stops pending thumbnails after three minutes and preserves opening without an original fallback', async () => {
  vi.useFakeTimers();
  vi.mocked(fetch).mockResolvedValue(response(202));
  await renderFiles([mediaEntry()]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(180_000);
  });
  expect(container.querySelector('[data-device-file-thumbnail-state="failed"]')).not.toBeNull();
  const requests = vi.mocked(fetch).mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(fetch).toHaveBeenCalledTimes(requests);
  expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url).includes('/thumbnail'))).toBe(
    true,
  );
  expect(container.querySelector('img')).toBeNull();
  act(() =>
    container.querySelector<HTMLButtonElement>('[aria-label="Відкрити файл image.jpg"]')!.click(),
  );
  expect(onOpen).toHaveBeenCalledTimes(1);
});

it('#3930 favorites a folder without navigating and leaves opening to its separate control', () => {
  const folder = entry({ entryId: 'folder', kind: 'directory', name: 'Documents', fileId: null });
  act(() =>
    root.render(
      <DeviceFileCards
        deviceId="device-1"
        entries={[folder]}
        viewMode="grid"
        onOpen={onOpen}
        onFavorite={onFavorite}
      />,
    ),
  );
  act(() =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Додати в обране: Documents"]')!
      .click(),
  );
  expect(onFavorite).toHaveBeenCalledWith(folder);
  expect(container.textContent).toContain('2 КБ');
  expect(onOpen).not.toHaveBeenCalled();
  act(() =>
    container.querySelector<HTMLButtonElement>('[aria-label="Відкрити папку Documents"]')!.click(),
  );
  expect(onOpen).toHaveBeenCalledWith(folder);
  expect(container.textContent).not.toContain('Нове');
});

it('#3930 displays viewed state independently from content availability and keeps unloaded files openable', () => {
  const file = entry({
    isViewed: true,
    fileMetadataModifiedAt: null,
    sizeBytes: 0,
    tags: [{ id: 'tag-1', name: 'Документи' }],
  });
  act(() =>
    root.render(
      <DeviceFileCards
        deviceId="device-1"
        entries={[file]}
        viewMode="list"
        onOpen={onOpen}
        onFavorite={onFavorite}
      />,
    ),
  );
  expect(container.querySelector('[aria-label="Переглянуто"]')).not.toBeNull();
  expect(
    container.querySelector('tbody tr[data-entry-id="file-1"]')?.classList.contains('opacity-55'),
  ).toBe(true);
  expect(container.textContent).not.toContain('Нове');
  const cells = container.querySelectorAll('tbody tr[data-entry-id="file-1"] td');
  expect(cells[1]?.querySelector('[aria-label="Переглянуто"]')).not.toBeNull();
  expect(cells[2]?.querySelector('button')).not.toBeNull();
  expect(cells[3]?.textContent).toBe('—');
  expect(cells[4]?.textContent).toContain('01.10.2026');
  expect(cells[5]?.textContent).toBe('—');
  expect(cells[6]?.textContent).toBe('0 Б');
  expect(cells[8]?.textContent).toContain('Документи');
  act(() =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Додати в обране: report.pdf"]')!
      .click(),
  );
  expect(onFavorite).toHaveBeenCalledWith(file);
  expect(onOpen).not.toHaveBeenCalled();
  act(() =>
    container.querySelector<HTMLButtonElement>('[aria-label="Відкрити файл report.pdf"]')!.click(),
  );
  expect(onOpen).toHaveBeenCalledWith(file);
  act(() =>
    root.render(
      <DeviceFileCards
        deviceId="device-1"
        entries={[entry({ hasContent: true, tags: file.tags })]}
        viewMode="grid"
        onOpen={onOpen}
        onFavorite={onFavorite}
      />,
    ),
  );
  expect(container.textContent).toContain('нове');
  expect(container.textContent).not.toContain('Документи');
  expect(container.querySelector('[aria-label="Переглянуто"]')).toBeNull();
  expect(container.querySelector('li')?.classList.contains('opacity-55')).toBe(false);
});
