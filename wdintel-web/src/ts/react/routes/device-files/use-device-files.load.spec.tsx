/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  DeviceFileRoot,
  DeviceFileTreeEntry,
  SearchDeviceFilesRsp,
} from '../../../../Bindings';
import { HttpRequestError } from '../../services/api/client';
import { useDeviceFilesLoad } from './use-device-files.load';

const apiMock = vi.hoisted(() => ({
  listDeviceFileRoots: vi.fn(),
  searchDeviceFiles: vi.fn(),
}));

vi.mock('../../services/api/devices', () => apiMock);

const DEVICE_ID = '018f0000-0000-7000-8000-000000000000';
const ROOT_ONE_ID = '018f0000-0000-7000-8000-000000000001';
const ROOT_TWO_ID = '018f0000-0000-7000-8000-000000000002';
const NOW = '2026-07-24T08:00:00Z';

function buildRoot(entryId: string, name: string): DeviceFileRoot {
  return {
    entryId,
    deviceId: DEVICE_ID,
    parentEntryId: null,
    kind: 'directory',
    name,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function buildEntry(entryId: string, parentEntryId: string): DeviceFileTreeEntry {
  return {
    entryId,
    parentEntryId,
    kind: 'file',
    fileId: `${entryId}-file`,
    name: 'duplicate.log',
    pathComponents: ['duplicate.log'],
    absolutePath: 'C:\\duplicate.log',
    hasContent: false,
    mimeType: 'text/plain',
    extension: 'log',
    fileMetadataCreatedAt: null,
    fileMetadataModifiedAt: null,
    createdAt: NOW,
    tags: [],
    updatedAt: NOW,
  };
}

function deferred<T>() {
  return Promise.withResolvers<T>();
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: ReturnType<typeof useDeviceFilesLoad> | null = null;

let selectedSyncId: string | null = null;
let enabled = true;

function Harness() {
  latest = useDeviceFilesLoad({
    deviceId: DEVICE_ID,
    enabled,
    syncId: selectedSyncId,
    tagFilter: { tagIds: [], tagMatch: 'any', untagged: false },
  });
  return null;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  selectedSyncId = null;
  enabled = true;
  apiMock.listDeviceFileRoots.mockResolvedValue({
    roots: [buildRoot(ROOT_TWO_ID, 'D:\\'), buildRoot(ROOT_ONE_ID, 'C:\\')],
  });
  apiMock.searchDeviceFiles.mockResolvedValue({ entries: [], nextCursor: null });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  latest = null;
  vi.clearAllMocks();
});

async function mountHook() {
  await act(async () => {
    root?.render(<Harness />);
  });
  await flush();
}

describe('useDeviceFilesLoad', () => {
  it('#3390 preserves search input across session validation and ignores the previous session response', async () => {
    const previous = deferred<SearchDeviceFilesRsp>();
    apiMock.searchDeviceFiles
      .mockReturnValueOnce(previous.promise)
      .mockResolvedValue({ entries: [], nextCursor: null });
    await mountHook();
    act(() => latest?.setSearchDraft({ ...latest.searchDraft, nameQuery: 'report' }));
    await flush();
    act(() => latest?.submitSearch());
    selectedSyncId = '018f0000-0000-7000-8000-000000000030';
    enabled = false;
    await mountHook();
    expect(latest?.searchEntries).toEqual([]);
    expect(latest?.searchNextCursor).toBeNull();
    enabled = true;
    await mountHook();
    expect(apiMock.searchDeviceFiles.mock.calls.at(-1)?.[0]).toMatchObject({
      syncId: selectedSyncId,
      nameQuery: 'report',
      cursor: null,
    });
    expect(latest?.searchDraft.nameQuery).toBe('report');
    expect(latest?.searchActive).toBe(true);
    previous.resolve({ entries: [buildEntry('stale', ROOT_TWO_ID)], nextCursor: 'stale-cursor' });
    await flush();
    expect(latest?.searchEntries).toEqual([]);
    expect(latest?.searchNextCursor).toBeNull();
  });

  it('keeps root server order and selects the first root as the initial search scope', async () => {
    await mountHook();

    expect(latest?.roots.map((item) => item.entryId)).toEqual([ROOT_TWO_ID, ROOT_ONE_ID]);
    expect(latest?.searchScope).toEqual({
      entryId: ROOT_TWO_ID,
      rootEntryId: ROOT_TWO_ID,
      label: 'D:\\',
    });
    expect(apiMock.searchDeviceFiles).not.toHaveBeenCalled();
  });

  it('ignores a stale search response after the search scope changes', async () => {
    const first = deferred<SearchDeviceFilesRsp>();
    const second = deferred<SearchDeviceFilesRsp>();
    apiMock.searchDeviceFiles
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await mountHook();

    act(() =>
      latest?.setSearchDraft({
        ...latest.searchDraft,
        nameQuery: 'first',
      }),
    );
    await flush();
    act(() => latest?.submitSearch());

    act(() =>
      latest?.selectSearchScope({
        entryId: ROOT_ONE_ID,
        rootEntryId: ROOT_ONE_ID,
        label: 'C:\\',
      }),
    );
    act(() =>
      latest?.setSearchDraft({
        ...latest.searchDraft,
        nameQuery: 'second',
      }),
    );
    await flush();
    act(() => latest?.submitSearch());

    second.resolve({
      entries: [buildEntry('018f0000-0000-7000-8000-000000000020', ROOT_ONE_ID)],
      nextCursor: null,
    });
    await flush();
    first.resolve({
      entries: [buildEntry('018f0000-0000-7000-8000-000000000010', ROOT_TWO_ID)],
      nextCursor: null,
    });
    await flush();

    expect(latest?.searchScope?.entryId).toBe(ROOT_ONE_ID);
    expect(latest?.searchEntries.map((entry) => entry.parentEntryId)).toEqual([ROOT_ONE_ID]);
  });

  it('appends cursor pages while preserving distinct duplicate paths', async () => {
    apiMock.searchDeviceFiles
      .mockResolvedValueOnce({
        entries: [buildEntry('018f0000-0000-7000-8000-000000000010', ROOT_TWO_ID)],
        nextCursor: 'next-page',
      })
      .mockResolvedValueOnce({
        entries: [buildEntry('018f0000-0000-7000-8000-000000000011', ROOT_TWO_ID)],
        nextCursor: null,
      });
    await mountHook();
    act(() =>
      latest?.setSearchDraft({
        ...latest.searchDraft,
        nameQuery: 'duplicate',
      }),
    );
    await flush();
    act(() => latest?.submitSearch());
    await flush();

    await act(async () => {
      await latest?.loadMoreSearch();
    });

    expect(apiMock.searchDeviceFiles.mock.calls[1][0].cursor).toBe('next-page');
    expect(latest?.searchEntries).toHaveLength(2);
    expect(latest?.searchEntries.map((entry) => entry.absolutePath)).toEqual([
      'C:\\duplicate.log',
      'C:\\duplicate.log',
    ]);
  });

  it('falls back to refreshed roots when the selected search scope was pruned', async () => {
    apiMock.searchDeviceFiles.mockRejectedValueOnce(new HttpRequestError(404, 'not found'));
    await mountHook();
    act(() =>
      latest?.setSearchDraft({
        ...latest.searchDraft,
        nameQuery: 'missing',
      }),
    );
    await flush();
    act(() => latest?.submitSearch());
    await flush();

    expect(latest?.searchScope?.entryId).toBe(ROOT_TWO_ID);
    expect(apiMock.listDeviceFileRoots).toHaveBeenCalledTimes(2);
    expect(latest?.scopeNotice).toContain('Область пошуку більше не існує');
  });
});
