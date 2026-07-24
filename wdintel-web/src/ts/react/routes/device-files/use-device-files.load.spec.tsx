/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  BrowseDeviceFilesRsp,
  DeviceFileRoot,
  DeviceFileTreeEntry,
} from '../../../../Bindings';
import { HttpRequestError } from '../../services/api/client';
import { useDeviceFilesLoad } from './use-device-files.load';

const apiMock = vi.hoisted(() => ({
  listDeviceFileRoots: vi.fn(),
  browseDeviceFiles: vi.fn(),
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
    pathSyntax: 'posix',
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
    pathSyntax: 'posix',
    absolutePath: '/duplicate.log',
    mimeType: 'text/plain',
    extension: 'log',
    fileMetadataCreatedAt: null,
    fileMetadataModifiedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function browseResponse(
  parentEntryId: string,
  entries: DeviceFileTreeEntry[],
  nextCursor: string | null = null,
): BrowseDeviceFilesRsp {
  return {
    breadcrumbs: [{ entryId: parentEntryId, name: '/' }],
    entries,
    nextCursor,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: ReturnType<typeof useDeviceFilesLoad> | null = null;

function Harness() {
  latest = useDeviceFilesLoad({ deviceId: DEVICE_ID, enabled: true });
  return null;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  apiMock.listDeviceFileRoots.mockResolvedValue({
    roots: [buildRoot(ROOT_TWO_ID, '/srv'), buildRoot(ROOT_ONE_ID, '/')],
  });
  apiMock.browseDeviceFiles.mockResolvedValue(browseResponse(ROOT_ONE_ID, []));
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
  it('keeps root server order and requires explicit selection', async () => {
    await mountHook();

    expect(latest?.roots.map((item) => item.entryId)).toEqual([ROOT_TWO_ID, ROOT_ONE_ID]);
    expect(latest?.selectedRootId).toBeNull();
    expect(apiMock.browseDeviceFiles).not.toHaveBeenCalled();

    await act(async () => {
      latest?.selectRoot(buildRoot(ROOT_ONE_ID, '/'));
      await Promise.resolve();
    });

    expect(apiMock.browseDeviceFiles.mock.calls[0][0]).toMatchObject({
      parentEntryId: ROOT_ONE_ID,
      cursor: null,
    });
  });

  it('ignores a stale browse response after scope changes', async () => {
    const first = deferred<BrowseDeviceFilesRsp>();
    const second = deferred<BrowseDeviceFilesRsp>();
    apiMock.browseDeviceFiles
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await mountHook();

    act(() => latest?.selectRoot(buildRoot(ROOT_ONE_ID, '/')));
    act(() => latest?.selectRoot(buildRoot(ROOT_TWO_ID, '/srv')));
    second.resolve(
      browseResponse(ROOT_TWO_ID, [
        buildEntry('018f0000-0000-7000-8000-000000000020', ROOT_TWO_ID),
      ]),
    );
    await flush();
    first.resolve(
      browseResponse(ROOT_ONE_ID, [
        buildEntry('018f0000-0000-7000-8000-000000000010', ROOT_ONE_ID),
      ]),
    );
    await flush();

    expect(latest?.selectedRootId).toBe(ROOT_TWO_ID);
    expect(latest?.browseEntries.map((entry) => entry.parentEntryId)).toEqual([ROOT_TWO_ID]);
  });

  it('appends cursor pages while preserving distinct duplicate paths', async () => {
    apiMock.browseDeviceFiles
      .mockResolvedValueOnce(
        browseResponse(
          ROOT_ONE_ID,
          [buildEntry('018f0000-0000-7000-8000-000000000010', ROOT_ONE_ID)],
          'next-page',
        ),
      )
      .mockResolvedValueOnce(
        browseResponse(ROOT_ONE_ID, [
          buildEntry('018f0000-0000-7000-8000-000000000011', ROOT_ONE_ID),
        ]),
      );
    await mountHook();
    await act(async () => {
      latest?.selectRoot(buildRoot(ROOT_ONE_ID, '/'));
      await Promise.resolve();
    });
    await flush();

    await act(async () => {
      await latest?.loadMoreBrowse();
    });

    expect(apiMock.browseDeviceFiles.mock.calls[1][0].cursor).toBe('next-page');
    expect(latest?.browseEntries).toHaveLength(2);
    expect(latest?.browseEntries.map((entry) => entry.absolutePath)).toEqual([
      '/duplicate.log',
      '/duplicate.log',
    ]);
  });

  it('falls back to refreshed roots when the selected directory was pruned', async () => {
    apiMock.browseDeviceFiles.mockRejectedValueOnce(new HttpRequestError(404, 'not found'));
    await mountHook();

    await act(async () => {
      latest?.selectRoot(buildRoot(ROOT_ONE_ID, '/'));
      await Promise.resolve();
    });
    await flush();

    expect(latest?.selectedRootId).toBeNull();
    expect(apiMock.listDeviceFileRoots).toHaveBeenCalledTimes(2);
    expect(latest?.scopeNotice).toContain('Каталог більше не існує');
  });
});
