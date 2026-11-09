/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  BrowseDeviceFilesRsp,
  DeviceArchiveStatus,
  DeviceFileTreeEntry,
} from '../../../../../../Bindings';
import { transformCamelToSnake } from '../../../../../snake-to-camel';
import { DeviceArchiveTree } from '../DeviceArchiveTree';
import { DeviceArchiveActivityContext } from '../../use-device-archive';
import { locatedFileSelection } from '../../device-file-archive';
import type { DeviceFileTreeBranch } from '../../use-device-file-tree';

const deviceId = '00000000-0000-4000-8000-000000000001';
const fileId = '00000000-0000-4000-8000-000000000002';
const archiveId = '00000000-0000-4000-8000-000000000003';
const rootEntryId = '00000000-0000-4000-8000-000000000004';
const memberId = '00000000-0000-4000-8000-000000000005';
const base = `/api/device/files/${deviceId}/${fileId}/revisions/7/archive`;
const file: DeviceFileTreeEntry = {
  entryId: fileId,
  parentEntryId: rootEntryId,
  kind: 'file',
  fileId,
  name: 'bundle.zip',
  pathComponents: ['bundle.zip'],
  absolutePath: 'C:\\bundle.zip',
  hasContent: true,
  mimeType: 'application/zip',
  extension: 'zip',
  contentUploadedAt: null,
  fileMetadataCreatedAt: null,
  fileMetadataModifiedAt: null,
  createdAt: '2026-10-14T00:00:00Z',
  updatedAt: '2026-10-14T00:00:00Z',
  revision: 7,
  syncId: null,
  sourceFileState: null,
  tags: [],
  archive: null,
};
const status: DeviceArchiveStatus = {
  source: { deviceId, fileId, revision: 7 },
  archive: { archiveId, rootEntryId, state: 'ready', reason: null, message: null, limitName: null },
  nextAttemptAt: null,
  pollAfterMs: 2000,
  updatedAt: '2026-10-14T00:00:00Z',
};
const member: DeviceFileTreeEntry = {
  ...file,
  entryId: memberId,
  fileId: memberId,
  revision: 7,
  parentEntryId: fileId,
  name: 'Report.txt',
  kind: 'file',
  hasContent: true,
  mimeType: 'text/plain',
  extension: 'txt',
  tags: [],
  archive: null,
  archiveOrigin: { archiveId, sourceFileId: fileId, sourceRevision: 7 },
};
let root: Root;
let container: HTMLDivElement;
let pages: BrowseDeviceFilesRsp[];
let states: DeviceArchiveStatus[];
let requests: Array<{ url: string; method: string; body: Record<string, unknown> }>;
const select = vi.fn();
const denied = vi.fn();

beforeEach(() => {
  pages = [{ entries: [], archiveSource: null, breadcrumbs: [], nextCursor: null }];
  states = [];
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      requests.push({ url, method, body });
      const response =
        url === base
          ? (states.shift() ?? status)
          : url === '/api/device/files/browse'
            ? pages.shift()
            : undefined;
      return new Response(
        JSON.stringify(
          response ? transformCamelToSnake(response) : { error: 'Unexpected content-byte request' },
        ),
        {
          status: response ? 200 : 409,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }),
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  select.mockReset();
  denied.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function expand() {
  await act(async () =>
    root.render(
      <DeviceArchiveTree
        showStatus
        deviceId={deviceId}
        file={file}
        depth={0}
        onSelectFile={select}
        onAccessDenied={denied}
        filters={{ tagIds: [], tagMatch: 'any', untagged: false }}
      />,
    ),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Розгорнути каталог bundle.zip"]')!
      .click(),
  );
}

it('#3930 shows a lock when preparation discovers a password and keeps it after collapse', async () => {
  states = [
    {
      ...status,
      archive: {
        ...status.archive,
        state: 'failed',
        reason: 'password_protected',
        message: 'Архів захищений паролем',
      },
    },
  ];
  await act(async () =>
    root.render(
      <DeviceArchiveTree deviceId={deviceId} file={file} depth={0} onSelectFile={select} />,
    ),
  );
  expect(container.querySelector('svg title')).toBeNull();
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Розгорнути каталог bundle.zip"]')!
      .click(),
  );
  await vi.waitFor(() =>
    expect(container.querySelector('svg title')?.textContent).toBe('Архів захищений паролем'),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Згорнути файл bundle.zip"]')!.click(),
  );
  expect(container.querySelector('svg title')?.textContent).toBe('Архів захищений паролем');
  expect(requests.every((request) => !request.url.endsWith('/content'))).toBe(true);
});

it('#3778 renders one empty archive folder without reading ZIP bytes', async () => {
  await expand();
  await vi.waitFor(() => expect(container.textContent).toContain('Каталог порожній'));
  expect(container.querySelectorAll('[aria-label="Згорнути каталог bundle.zip"]')).toHaveLength(1);
  expect(requests.some((request) => request.url.endsWith('/content'))).toBe(false);
  expect(requests.find((request) => request.url.endsWith('/browse'))?.body).toMatchObject({
    tag_ids: null,
    tag_match: null,
  });
});

it('#3778 selects the persisted member revision and preserves case-distinct names across pages', async () => {
  pages = [
    { entries: [member], archiveSource: null, breadcrumbs: [], nextCursor: 'next-page' },
    {
      entries: [
        {
          ...member,
          entryId: '00000000-0000-4000-8000-000000000006',
          name: 'report.txt',
          fileId: '00000000-0000-4000-8000-000000000006',
        },
      ],
      archiveSource: null,
      breadcrumbs: [],
      nextCursor: null,
    },
  ];
  await expand();
  await vi.waitFor(() =>
    expect(container.querySelector('[aria-label="Report.txt"]')).not.toBeNull(),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Report.txt"]')!.click(),
  );
  expect(select.mock.lastCall?.[0]).toMatchObject({
    entryId: memberId,
    fileId: memberId,
    revision: 7,
    name: 'Report.txt',
    absolutePath: file.absolutePath,
  });
  expect(select.mock.lastCall?.[0].archiveMember).toBeUndefined();
  const more = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('ще'),
  );
  expect(more).toBeDefined();
  await act(async () => more!.click());
  await vi.waitFor(() =>
    expect(container.querySelector('[aria-label="report.txt"]')).not.toBeNull(),
  );
  expect(container.querySelector('[aria-label="Report.txt"]')).not.toBeNull();
  expect(
    requests
      .filter((request) => request.url === '/api/device/files/browse')
      .map((request) => request.body.cursor ?? null),
  ).toEqual([null, 'next-page']);
});

it('#3778 browses persisted directory IDs instead of downloading the parent archive', async () => {
  const directoryId = '00000000-0000-4000-8000-000000000007';
  pages = [
    {
      entries: [
        {
          ...member,
          entryId: directoryId,
          name: 'docs',
          kind: 'directory',
          fileId: null,
          hasContent: false,
        },
      ],
      archiveSource: null,
      breadcrumbs: [],
      nextCursor: null,
    },
    {
      entries: [
        { ...member, parentEntryId: directoryId, virtualPath: 'C:\\bundle.zip/docs/Report.txt' },
      ],
      archiveSource: null,
      breadcrumbs: [],
      nextCursor: null,
    },
  ];
  await expand();
  await vi.waitFor(() =>
    expect(container.querySelector('[aria-label="Розгорнути каталог docs"]')).not.toBeNull(),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Розгорнути каталог docs"]')!.click(),
  );
  await vi.waitFor(() =>
    expect(container.querySelector('[aria-label="Report.txt"]')).not.toBeNull(),
  );
  expect(
    requests
      .filter((request) => request.url === '/api/device/files/browse')
      .map((request) => request.body.parent_entry_id ?? null),
  ).toEqual([fileId, directoryId]);
  expect(requests.some((request) => request.url.endsWith('/content'))).toBe(false);
});

it('#3778 ensures a legacy archive once and polls only while expanded', async () => {
  vi.useFakeTimers();
  states = [
    {
      ...status,
      archive: { ...status.archive, state: 'not_prepared', archiveId: null, rootEntryId: null },
    },
    { ...status, archive: { ...status.archive, state: 'running', rootEntryId: null } },
  ];
  await expand();
  expect(
    requests.filter((request) => request.url === base).map((request) => request.method),
  ).toEqual(['GET', 'POST']);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1999);
  });
  expect(requests.filter((request) => request.url === base)).toHaveLength(2);
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Згорнути каталог bundle.zip"]')!
      .click(),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(requests.filter((request) => request.url === base)).toHaveLength(2);
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Розгорнути каталог bundle.zip"]')!
      .click(),
  );
  expect(container.textContent).toContain('Каталог порожній');
  expect(
    requests.filter((request) => request.url === base && request.method === 'POST'),
  ).toHaveLength(1);
});

it('#3778 pauses status polling while hidden and resumes the same durable archive', async () => {
  vi.useFakeTimers();
  let visibility: DocumentVisibilityState = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  states = [{ ...status, archive: { ...status.archive, state: 'running', rootEntryId: null } }];
  await expand();
  await act(async () => {
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(requests.filter((request) => request.url === base)).toHaveLength(1);
  await act(async () => {
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(container.textContent).toContain('Каталог порожній');
  expect(
    requests.filter((request) => request.url === base).map((request) => request.method),
  ).toEqual(['GET', 'GET']);
});

it('#3778 keeps nested archives collapsed when the content pane opens the parent', async () => {
  pages = [
    {
      entries: [
        {
          ...member,
          name: 'nested.zip',
          extension: 'zip',
          mimeType: 'application/zip',
          archive: status.archive,
        },
      ],
      archiveSource: null,
      breadcrumbs: [],
      nextCursor: null,
    },
  ];
  await act(async () =>
    root.render(
      <DeviceArchiveTree
        showStatus
        deviceId={deviceId}
        file={file}
        depth={0}
        onSelectFile={select}
        initialExpanded
      />,
    ),
  );
  await vi.waitFor(() =>
    expect(container.querySelector('[aria-label="Розгорнути каталог nested.zip"]')).not.toBeNull(),
  );
  expect(
    requests.every((request) => request.url === base || request.url === '/api/device/files/browse'),
  ).toBe(true);
});

it('#3778 reveals located nested ancestors and off-page members at their historical revision', async () => {
  const nestedArchiveId = '00000000-0000-4000-8000-000000000006';
  const nestedOrigin = { archiveId: nestedArchiveId, sourceFileId: memberId, sourceRevision: 7 };
  const nested = {
    ...member,
    name: 'nested.zip',
    extension: 'zip',
    mimeType: 'application/zip',
    isArchive: true,
  };
  const directory: DeviceFileTreeEntry = {
    ...member,
    entryId: 'directory',
    fileId: null,
    parentEntryId: memberId,
    kind: 'directory',
    name: 'docs',
    isArchive: false,
    archiveOrigin: nestedOrigin,
  };
  const target = {
    ...member,
    entryId: 'target',
    fileId: 'target',
    parentEntryId: 'directory',
    name: 'outside-page.txt',
    archiveOrigin: nestedOrigin,
  };
  const branch = (entries: DeviceFileTreeEntry[]): DeviceFileTreeBranch => ({
    archiveRevision: 7,
    entries,
    nextCursor: null,
    loading: false,
    refreshing: false,
    loadingMore: false,
    error: null,
    loadMoreError: null,
  });
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    requests.push({ url, method: init?.method ?? 'GET', body });
    const response = url.endsWith('/archive')
      ? {
          ...status,
          source: { ...status.source, fileId: url === base ? fileId : memberId },
          archive: { ...status.archive, archiveId: url === base ? archiveId : nestedArchiveId },
        }
      : { entries: [], archiveSource: null, breadcrumbs: [], nextCursor: 'later-page' };
    return new Response(JSON.stringify(transformCamelToSnake(response)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  await act(async () =>
    root.render(
      <DeviceArchiveTree
        showStatus
        deviceId={deviceId}
        file={file}
        depth={0}
        onSelectFile={select}
        selectedEntryId={target.entryId}
        expandedEntryIds={new Set([fileId, memberId, directory.entryId])}
        revealedBranches={{
          [fileId]: branch([
            nested,
            { ...member, entryId: 'stale', fileId: 'stale', revision: 6, name: 'stale.txt' },
            {
              ...member,
              entryId: 'other-job',
              fileId: 'other-job',
              name: 'other-job.txt',
              archiveOrigin: nestedOrigin,
            },
          ]),
          [memberId]: branch([directory]),
          [directory.entryId]: branch([target]),
        }}
      />,
    ),
  );
  await vi.waitFor(() =>
    expect(container.querySelector('[aria-label="outside-page.txt"]')).not.toBeNull(),
  );
  expect(container.querySelector('[aria-label="stale.txt"]')).toBeNull();
  expect(container.querySelector('[aria-label="other-job.txt"]')).toBeNull();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="outside-page.txt"]')!.click(),
  );
  expect(
    select.mock.calls[0][0].archiveParents.map((entry: DeviceFileTreeEntry) => entry.fileId),
  ).toEqual([fileId, memberId]);
  expect(
    requests
      .filter((request) => request.url.endsWith('/browse'))
      .map((request) => request.body.archive_revision),
  ).toEqual([7, 7, 7]);
  const selected = locatedFileSelection({
    rootEntryId,
    currentRevision: 8,
    ancestors: [file, nested, directory],
    file: target,
  });
  expect(selected.archiveParents?.map((entry) => entry.fileId)).toEqual([fileId, memberId]);
});

it('#3778 pauses an expanded archive when its sidebar surface is inactive', async () => {
  vi.useFakeTimers();
  states = [{ ...status, archive: { ...status.archive, state: 'running', rootEntryId: null } }];
  const render = (active: boolean) =>
    act(async () =>
      root.render(
        <DeviceArchiveActivityContext.Provider value={active}>
          <DeviceArchiveTree
            showStatus
            deviceId={deviceId}
            file={file}
            depth={0}
            onSelectFile={select}
            initialExpanded
          />
        </DeviceArchiveActivityContext.Provider>,
      ),
    );
  await render(true);
  await render(false);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(requests.filter((request) => request.url === base)).toHaveLength(1);
  await render(true);
  expect(container.textContent).toContain('Каталог порожній');
  expect(requests.filter((request) => request.url === base)).toHaveLength(2);
});

it('#3778 preserves Retry-After when a hidden tab becomes visible', async () => {
  vi.useFakeTimers();
  let visibility: DocumentVisibilityState = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  vi.mocked(fetch).mockImplementationOnce(
    async () =>
      new Response('{}', {
        status: 503,
        headers: { 'Retry-After': '8', 'Content-Type': 'application/json' },
      }),
  );
  await expand();
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => {
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await act(async () => {
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(7999);
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(container.textContent).toContain('Каталог порожній');
});

it('#3778 restarts at the first page after access to a later page was denied', async () => {
  pages = [{ entries: [member], archiveSource: null, breadcrumbs: [], nextCursor: 'next-page' }];
  await expand();
  vi.mocked(fetch).mockImplementationOnce(
    async () =>
      new Response('{}', { status: 403, headers: { 'Content-Type': 'application/json' } }),
  );
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Показати ще'))!
      .click(),
  );
  expect(container.querySelector('[aria-label="Report.txt"]')).toBeNull();
  expect(denied).toHaveBeenCalledTimes(1);
  pages = [{ entries: [member], archiveSource: null, breadcrumbs: [], nextCursor: null }];
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Повторити читання'))!
      .click(),
  );
  expect(container.querySelector('[aria-label="Report.txt"]')).not.toBeNull();
  expect(
    requests.filter((request) => request.url === '/api/device/files/browse').at(-1)?.body.cursor,
  ).toBeNull();
});

it('#3778 clears the entire archive when a nested directory denies access', async () => {
  pages = [
    {
      entries: [
        member,
        {
          ...member,
          entryId: 'directory',
          name: 'docs',
          kind: 'directory',
          fileId: null,
          hasContent: false,
        },
      ],
      archiveSource: null,
      breadcrumbs: [],
      nextCursor: null,
    },
  ];
  await expand();
  vi.mocked(fetch).mockImplementationOnce(
    async () =>
      new Response('{}', { status: 403, headers: { 'Content-Type': 'application/json' } }),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Розгорнути каталог docs"]')!.click(),
  );
  expect(container.querySelector('[aria-label="Report.txt"]')).toBeNull();
  expect(container.querySelector('[aria-label="docs"]')).toBeNull();
  expect(denied).toHaveBeenCalledTimes(1);
});

it('#3778 observes content published for the open metadata-only revision without reselection', async () => {
  vi.useFakeTimers();
  states = [
    {
      ...status,
      archive: { ...status.archive, archiveId: null, rootEntryId: null, state: 'missing_content' },
    },
    { ...status, archive: { ...status.archive, state: 'not_prepared' } },
    { ...status, archive: { ...status.archive, state: 'queued' } },
    status,
  ];
  pages = [{ entries: [member], archiveSource: null, breadcrumbs: [], nextCursor: null }];
  await act(async () =>
    root.render(
      <DeviceArchiveTree
        showStatus
        deviceId={deviceId}
        file={{ ...file, hasContent: false }}
        depth={0}
        onSelectFile={select}
        initialExpanded
      />,
    ),
  );
  expect(container.textContent).toContain('Контент файлу відсутній');
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(container.textContent).toContain('Очікує підготовки');
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(container.querySelector('[aria-label="Report.txt"]')).not.toBeNull();
  expect(requests.map(({ method, url }) => [method, url])).toEqual([
    ['GET', base],
    ['GET', base],
    ['POST', base],
    ['GET', base],
    ['POST', '/api/device/files/browse'],
  ]);
});

it('#3930 opens an archive directory with its revision while its chevron only expands', async () => {
  const directory = { ...member, kind: 'directory' as const, name: 'documents', fileId: null };
  const openDirectory = vi.fn();
  pages = [
    { entries: [directory], archiveSource: null, breadcrumbs: [], nextCursor: null },
    { entries: [], archiveSource: null, breadcrumbs: [], nextCursor: null },
  ];
  await act(async () =>
    root.render(
      <DeviceArchiveTree
        deviceId={deviceId}
        file={file}
        depth={0}
        initialExpanded
        onSelectFile={select}
        onOpenDirectory={openDirectory}
      />,
    ),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Розгорнути каталог documents"]')!
      .click(),
  );
  expect(openDirectory).not.toHaveBeenCalled();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="documents"]')!.click(),
  );
  expect(openDirectory).toHaveBeenCalledWith(directory.entryId, 7);
  expect(select).not.toHaveBeenCalled();
});
