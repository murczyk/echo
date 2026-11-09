/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  BrowseDeviceFilesRsp,
  DeviceArchiveStatus,
  DeviceFileTreeEntry,
} from '../../../../../../Bindings';
import { AUTH_UNAUTHORIZED_EVENT } from '../../../../auth-redirect';
import { FORCED_NAVIGATION_EVENT } from '../../../../../browser/navigation-guard';
import type { useDeviceFilePreview } from '../../use-device-file-preview';
import { DeviceFileContentPane } from '../DeviceFileContentPane';
import { transformCamelToSnake } from '../../../../../snake-to-camel';

let realArchive = false;
const notify = vi.fn();
vi.mock('../../../../components/PowerSnackbar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../components/PowerSnackbar')>()),
  useOptionalPowerSnackbar: () => ({ notify }),
}));

vi.mock('../../use-device-file-preview', () => ({ useDeviceFilePreview: () => preview }));
vi.mock('../DeviceArchiveExplorer', async (importOriginal) => {
  const { DeviceArchiveExplorer } =
    await importOriginal<typeof import('../DeviceArchiveExplorer')>();
  return {
    DeviceArchiveExplorer: (props: React.ComponentProps<typeof DeviceArchiveExplorer>) =>
      realArchive ? (
        <DeviceArchiveExplorer {...props} />
      ) : (
        <button onClick={() => props.onSelectFile(file)}>Open persisted member</button>
      ),
  };
});
vi.mock('../../../shared/message-card/renderers/DocumentFilePreview', () => ({
  DocumentFilePreview: ({ zoom }: { zoom: number }) => (
    <canvas data-pdf-leaf data-zoom={zoom} width={(400 * zoom) / 100} height={(600 * zoom) / 100} />
  ),
}));

const file: DeviceFileTreeEntry = {
  entryId: 'file',
  parentEntryId: 'root',
  kind: 'file',
  fileId: 'file',
  name: 'selected.pdf',
  pathComponents: ['selected.pdf'],
  absolutePath: 'C:\\selected.pdf',
  hasContent: true,
  mimeType: 'application/pdf',
  extension: 'pdf',
  contentUploadedAt: null,
  fileMetadataCreatedAt: null,
  fileMetadataModifiedAt: null,
  createdAt: '2026-10-07T00:00:00Z',
  updatedAt: '2026-10-07T00:00:00Z',
  revision: 1,
  syncId: null,
  sourceFileState: null,
  tags: [],
};
const controller = new AbortController();
const preview: ReturnType<typeof useDeviceFilePreview> = {
  state: 'ready',
  source: {
    key: 'device/file/1',
    deviceId: 'device',
    fileId: 'file',
    revision: 1,
    fileName: file.name,
    extension: 'pdf',
    contentType: 'application/pdf',
    sizeBytes: 10,
    originalHref: '/api/device/files/device/file/revisions/1/content',
  },
  epoch: 1,
  signal: controller.signal,
  error: null,
  errorRetryable: true,
  canDownload: true,
  downloading: false,
  download: async () => {},
  retry: () => {},
  onError: () => {},
  registerCleanup: () => () => {},
  isCurrent: () => true,
  checkAccess: async () => true,
};
let root: Root;
let container: HTMLDivElement;
const pageObservers = new Map<Element, IntersectionObserverCallback>();
beforeEach(() => {
  realArchive = false;
  notify.mockClear();
  pageObservers.clear();
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      private target: Element | null = null;
      constructor(private callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.target = target;
        pageObservers.set(target, this.callback);
      }
      disconnect() {
        if (this.target) pageObservers.delete(this.target);
      }
    },
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function openFullscreen() {
  await act(async () => root.render(<DeviceFileContentPane deviceId="device" file={file} />));
  await vi.waitFor(() => expect(container.querySelector('[data-pdf-leaf]')).not.toBeNull());
  expect(container.querySelector('[aria-label="Збільшити масштаб"]')).toBeNull();
  expect(
    [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Скачати файл'),
    )?.disabled,
  ).toBe(false);
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="На весь екран"]')!;
  await act(async () => trigger.click());
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog).not.toBeNull();
  expect(dialog.querySelector('[data-pdf-leaf]')).not.toBeNull();
  return { dialog, trigger };
}

it('#3930 fullscreen uses shared document gestures and reset without header zoom controls', async () => {
  const { dialog } = await openFullscreen();
  const stage = dialog.querySelector<HTMLElement>('[data-document-preview-stage]')!;
  expect(stage).not.toBeNull();
  expect(dialog.querySelector('[aria-label="Збільшити масштаб"]')).toBeNull();
  const wheel = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
  Object.defineProperty(wheel, 'ctrlKey', { value: true });
  await act(async () => {
    stage.dispatchEvent(wheel);
  });
  expect(
    Number(dialog.querySelector('[data-pdf-leaf]')?.getAttribute('data-zoom')),
  ).toBeGreaterThan(100);
  const reset = dialog.querySelector<HTMLButtonElement>('[aria-label="Скинути масштаб (100%)"]')!;
  await act(async () => reset.click());
  expect(dialog.querySelector('[data-pdf-leaf]')?.getAttribute('data-zoom')).toBe('100');
});

it('fullscreen keeps the authorized original download action available', async () => {
  const { dialog } = await openFullscreen();
  const download = [...dialog.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Скачати файл'),
  );
  expect(download).toBeDefined();
  expect(download!.disabled).toBe(false);
});

it('#3930 retains fullscreen while the next file loads without duplicating its path', async () => {
  const { dialog } = await openFullscreen();
  const next = { ...file, entryId: 'next', fileId: 'next', name: 'next.pdf' };
  try {
    preview.state = 'loading';
    preview.epoch = null;
    await act(async () => root.render(<DeviceFileContentPane deviceId="device" file={next} />));
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    expect(dialog.querySelector('[aria-label="Завантаження вмісту файлу"]')).not.toBeNull();
    preview.state = 'ready';
    preview.epoch = 2;
    await act(async () => root.render(<DeviceFileContentPane deviceId="device" file={next} />));
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    expect(dialog.querySelector('#device-file-fullscreen-title')?.textContent).toBe('next.pdf');
    expect(dialog.textContent).not.toContain(next.absolutePath);
  } finally {
    preview.state = 'ready';
    preview.epoch = 1;
  }
});

it('#3778 keeps derived preview usable without source-only document details', async () => {
  await act(async () =>
    root.render(<DeviceFileContentPane deviceId="device" file={file} showDocumentDetails />),
  );
  expect(container.textContent).toContain('Підсумок, текст і позиції');
  const member = {
    ...file,
    archiveOrigin: { archiveId: 'archive', sourceFileId: 'source', sourceRevision: 1 },
  };
  await act(async () =>
    root.render(<DeviceFileContentPane deviceId="device" file={member} showDocumentDetails />),
  );
  expect(container.textContent).not.toContain('Підсумок, текст і позиції');
  expect(container.querySelector('[data-pdf-leaf]')).not.toBeNull();
  expect(
    [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Скачати файл'),
    )?.disabled,
  ).toBe(false);
});

it('#3778 clears archive member selection after selecting another source and returning', async () => {
  const archive = {
    ...file,
    fileId: 'archive',
    entryId: 'archive',
    name: 'bundle.zip',
    extension: 'zip',
    mimeType: 'application/zip',
    absolutePath: 'C:\\bundle.zip',
  };
  const other = { ...file, fileId: 'other', entryId: 'other', absolutePath: 'C:\\other.pdf' };
  const render = (selected: DeviceFileTreeEntry) =>
    act(async () => root.render(<DeviceFileContentPane deviceId="device" file={selected} />));
  await render(archive);
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Open persisted member')!
      .click(),
  );
  expect(container.querySelector('#device-file-content-title')?.textContent).toContain(
    'selected.pdf',
  );
  await render(other);
  await render(archive);
  expect(container.querySelector('#device-file-content-title')?.textContent).toContain(
    'bundle.zip',
  );
});

const zip: DeviceFileTreeEntry = {
  ...file,
  fileId: 'archive',
  entryId: 'archive',
  name: 'bundle.zip',
  extension: 'zip',
  mimeType: 'application/zip',
  absolutePath: 'C:\\bundle.zip',
};
const zipStatus: DeviceArchiveStatus = {
  source: { deviceId: 'device', fileId: 'archive', revision: 1 },
  archive: {
    archiveId: 'durable-job',
    rootEntryId: null,
    state: 'queued',
    reason: null,
    message: null,
    limitName: null,
  },
  nextAttemptAt: null,
  pollAfterMs: 2000,
  updatedAt: '2026-10-15T00:00:00Z',
};
function archiveResponse(status: DeviceArchiveStatus) {
  return new Response(JSON.stringify(transformCamelToSnake(status)), {
    headers: { 'Content-Type': 'application/json' },
  });
}
async function renderArchive(
  selected = zip,
  onArchiveReady?: (entryId: string, revision: number) => void,
) {
  realArchive = true;
  await act(async () =>
    root.render(
      <DeviceFileContentPane deviceId="device" file={selected} onArchiveReady={onArchiveReady} />,
    ),
  );
}

it('#3930 opens the archive directory only after preparation reaches ready', async () => {
  vi.useFakeTimers();
  const onReady = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi
      .fn(async () =>
        archiveResponse({
          ...zipStatus,
          archive: { ...zipStatus.archive, state: 'ready' },
        }),
      )
      .mockImplementationOnce(async () => archiveResponse(zipStatus)),
  );
  await renderArchive(zip, onReady);
  expect(onReady).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(onReady).toHaveBeenCalledExactlyOnceWith(zip.entryId, zip.revision);
  await renderArchive(zip, onReady);
  expect(onReady).toHaveBeenCalledTimes(1);
  expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url).endsWith('/archive'))).toBe(true);
  expect(container.querySelector('[aria-label="Вміст папки"]')).toBeNull();
});

it('#3930 does not open a denied archive from a stale ready summary', async () => {
  const onReady = vi.fn();
  let finishStatus!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finishStatus = resolve;
        }),
    ),
  );
  await renderArchive({ ...zip, archive: { ...zipStatus.archive, state: 'ready' } }, onReady);
  expect(onReady).not.toHaveBeenCalled();
  await act(async () =>
    finishStatus(
      new Response('{}', { status: 403, headers: { 'Content-Type': 'application/json' } }),
    ),
  );
  expect(onReady).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Помилка перегляду архіву');
  expect(fetch).toHaveBeenCalledTimes(1);
});

const archivedFile: DeviceFileTreeEntry = {
  ...file,
  parentEntryId: zip.fileId!,
  archiveOrigin: { archiveId: 'durable-job', sourceFileId: zip.fileId!, sourceRevision: 1 },
};
function archivePage(entries: DeviceFileTreeEntry[], nextCursor: string | null = null) {
  const page: BrowseDeviceFilesRsp = { archiveSource: null, entries, breadcrumbs: [], nextCursor };
  return new Response(JSON.stringify(transformCamelToSnake(page)), {
    headers: { 'Content-Type': 'application/json' },
  });
}
async function loadMoreArchive() {
  const target = container.querySelector('[data-testid="device-files-load-more"]')!;
  expect(target).not.toBeNull();
  const callback = pageObservers.get(target)!;
  expect(callback).toBeDefined();
  await act(async () =>
    callback(
      [{ target, isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    ),
  );
}

it.each([AUTH_UNAUTHORIZED_EVENT, FORCED_NAVIGATION_EVENT])(
  '#3930 clears archive cards and ignores a late page after %s',
  async (event) => {
    let finishPage!: (response: Response) => void;
    let pendingSignal: AbortSignal | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('/archive'))
          return archiveResponse({
            ...zipStatus,
            archive: { ...zipStatus.archive, state: 'ready' },
          });
        expect(String(input)).toBe('/api/device/files/browse');
        const request = JSON.parse(String(init?.body));
        expect(request.archive_revision).toBe(1);
        expect(request.parent_entry_id).toBe(zip.fileId);
        if (!request.cursor) return archivePage([archivedFile], 'page-2');
        pendingSignal = init?.signal ?? null;
        return new Promise<Response>((resolve) => {
          finishPage = resolve;
        });
      }),
    );
    await renderArchive();
    expect(container.querySelector('[data-entry-id="file"]')).not.toBeNull();
    await loadMoreArchive();
    await act(async () => window.dispatchEvent(new Event(event)));
    expect(pendingSignal!.aborted).toBe(true);
    expect(container.querySelector('[data-entry-id]')).toBeNull();
    await act(async () => finishPage(archivePage([{ ...archivedFile, entryId: 'late' }])));
    expect(container.querySelector('[data-entry-id]')).toBeNull();
    expect(container.textContent).toContain('Помилка доступу до архіву');
    expect(fetch).toHaveBeenCalledTimes(3);
  },
);

it('#3930 clears visible archive cards and pagination after a denied browse', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/archive'))
        return archiveResponse({
          ...zipStatus,
          archive: { ...zipStatus.archive, state: 'ready' },
        });
      expect(String(input)).toBe('/api/device/files/browse');
      return JSON.parse(String(init?.body)).cursor
        ? new Response('{}', { status: 403, headers: { 'Content-Type': 'application/json' } })
        : archivePage([archivedFile], 'page-2');
    }),
  );
  await renderArchive();
  expect(container.querySelector('[data-entry-id="file"]')).not.toBeNull();
  await loadMoreArchive();
  expect(container.querySelector('[data-entry-id]')).toBeNull();
  expect(container.textContent).not.toContain('Завантажити ще');
  expect(container.textContent).toContain('Помилка перегляду каталогу');
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ severity: 'error' }));
});

it('#3778 observes a metadata-only ZIP without requesting bytes or preparation', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      archiveResponse({
        ...zipStatus,
        archive: { ...zipStatus.archive, archiveId: null, state: 'missing_content' },
      }),
    ),
  );
  await renderArchive({ ...zip, hasContent: false });
  expect(container.textContent).toContain('Контент файлу відсутній');
  expect(container.querySelector('[aria-label*="каталог bundle.zip"]')).toBeNull();
  expect(container.textContent).not.toMatch(/Каталог порожній|Готується/);
  expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
  expect(String(vi.mocked(fetch).mock.calls[0][0])).toMatch(/\/archive$/);
  expect(vi.mocked(fetch).mock.calls[0][1]?.method ?? 'GET').toBe('GET');
});

it.each([
  ['password_protected', 'Архів захищений паролем', null],
  ['safety_limit', 'Розпакування зупинено: перевищено ліміти безпеки архіву', 'expanded_bytes'],
] as const)(
  '#3778 shows %s with its original and never offers extraction retry',
  async (reason, message, limitName) => {
    const state: DeviceArchiveStatus = {
      ...zipStatus,
      archive: { ...zipStatus.archive, state: 'failed', reason, message, limitName },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => archiveResponse(state)),
    );
    await renderArchive();
    expect(container.textContent).toContain(message);
    if (limitName) expect(container.textContent).toContain(limitName);
    expect(
      [...container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Скачати файл'),
      )?.disabled,
    ).toBe(false);
    expect(
      [...container.querySelectorAll('button')].some((button) =>
        /Повторити/.test(button.textContent ?? ''),
      ),
    ).toBe(false);
    await act(async () => root.render(null));
    await renderArchive();
    expect(
      vi.mocked(fetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET'),
    ).toBe(true);
  },
);

it.each([
  ['queued', 'Очікує підготовки'],
  ['running', 'Готується'],
  ['retry_wait', 'Тимчасова помилка сховища. Очікується повторна спроба'],
] as const)('#3778 distinguishes %s from an empty archive', async (state, message) => {
  const onReady = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      archiveResponse({
        ...zipStatus,
        nextAttemptAt: state === 'retry_wait' ? '2026-10-15T09:00:00Z' : null,
        archive: { ...zipStatus.archive, state },
      }),
    ),
  );
  await renderArchive(zip, onReady);
  expect(onReady).not.toHaveBeenCalled();
  expect(container.textContent).toContain(message);
  expect(container.textContent).not.toContain('Каталог порожній');
  if (state === 'retry_wait')
    expect(container.querySelector('time')?.dateTime).toBe('2026-10-15T09:00:00Z');
});

it('#3778 keeps the last known state and toasts a 503 while respecting Retry-After', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi
      .fn(async () => archiveResponse(zipStatus))
      .mockImplementationOnce(async () => archiveResponse(zipStatus))
      .mockImplementationOnce(
        async () =>
          new Response('{}', {
            status: 503,
            headers: { 'Content-Type': 'application/json', 'Retry-After': '8' },
          }),
      ),
  );
  await renderArchive();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(container.textContent).toContain('Очікує підготовки');
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ severity: 'error' }));
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(7999);
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(
    vi.mocked(fetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET'),
  ).toBe(true);
});

it('#3778 discards a late status after selection changes without ensuring the old source', async () => {
  let resolve!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi
      .fn(async () =>
        archiveResponse({
          ...zipStatus,
          source: { ...zipStatus.source, fileId: 'other-zip' },
          archive: {
            ...zipStatus.archive,
            state: 'failed',
            reason: 'password_protected',
            message: 'Архів захищений паролем',
          },
        }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      ),
  );
  await renderArchive();
  await renderArchive({
    ...zip,
    fileId: 'other-zip',
    entryId: 'other-zip',
    name: 'other.zip',
    absolutePath: 'C:\\other.zip',
  });
  await act(async () =>
    resolve(
      archiveResponse({ ...zipStatus, archive: { ...zipStatus.archive, state: 'not_prepared' } }),
    ),
  );
  expect(container.textContent).toContain('Архів захищений паролем');
  expect(container.querySelector('#device-file-content-title')?.textContent).toContain('other.zip');
  expect(
    vi
      .mocked(fetch)
      .mock.calls.some(
        ([url, init]) => String(url).includes('/archive/revisions/') && init?.method === 'POST',
      ),
  ).toBe(false);
});
