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
import { useDeviceFileTree } from './use-device-file-tree';

const apiMock = vi.hoisted(() => ({
  browseDeviceFiles: vi.fn(),
}));

vi.mock('../../services/api/devices', () => apiMock);

const DEVICE_ID = '018f0000-0000-7000-8000-000000000000';
const ROOT_ONE_ID = '018f0000-0000-7000-8000-000000000001';
const ROOT_TWO_ID = '018f0000-0000-7000-8000-000000000002';
const DIRECTORY_ID = '018f0000-0000-7000-8000-000000000003';
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

function buildEntry(
  entryId: string,
  parentEntryId: string,
  kind: DeviceFileTreeEntry['kind'] = 'file',
): DeviceFileTreeEntry {
  return {
    entryId,
    parentEntryId,
    kind,
    fileId: kind === 'file' ? `${entryId}-file` : null,
    name: kind === 'directory' ? 'documents' : 'duplicate.log',
    pathComponents: [kind === 'directory' ? 'documents' : 'duplicate.log'],
    pathSyntax: kind === 'file' ? 'posix' : null,
    absolutePath: kind === 'file' ? '/duplicate.log' : null,
    mimeType: kind === 'file' ? 'text/plain' : null,
    extension: kind === 'file' ? 'log' : null,
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

const roots = [buildRoot(ROOT_ONE_ID, '/'), buildRoot(ROOT_TWO_ID, '/srv')];
const onDirectoryMissing = vi.fn();
let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: ReturnType<typeof useDeviceFileTree> | null = null;

function Harness() {
  latest = useDeviceFileTree({
    deviceId: DEVICE_ID,
    enabled: true,
    roots,
    onDirectoryMissing,
  });
  return null;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mountHook() {
  await act(async () => {
    root?.render(<Harness />);
  });
  await flush();
}

beforeEach(() => {
  apiMock.browseDeviceFiles.mockImplementation(({ parentEntryId }) =>
    Promise.resolve(
      browseResponse(
        parentEntryId,
        parentEntryId === ROOT_ONE_ID ? [buildEntry(DIRECTORY_ID, ROOT_ONE_ID, 'directory')] : [],
      ),
    ),
  );
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

describe('useDeviceFileTree', () => {
  it('expands and loads every filesystem root immediately', async () => {
    await mountHook();

    expect(apiMock.browseDeviceFiles.mock.calls.map(([req]) => req.parentEntryId)).toEqual([
      ROOT_ONE_ID,
      ROOT_TWO_ID,
    ]);
    expect(latest?.expandedEntryIds).toEqual(new Set([ROOT_ONE_ID, ROOT_TWO_ID]));
    expect(latest?.branches[ROOT_ONE_ID].entries[0].entryId).toBe(DIRECTORY_ID);
    expect(latest?.branches[ROOT_TWO_ID].entries).toEqual([]);
  });

  it('loads a nested directory only when it is expanded', async () => {
    await mountHook();
    expect(apiMock.browseDeviceFiles).toHaveBeenCalledTimes(2);

    act(() => latest?.toggleDirectory(DIRECTORY_ID));
    await flush();

    expect(latest?.expandedEntryIds.has(DIRECTORY_ID)).toBe(true);
    expect(apiMock.browseDeviceFiles.mock.calls[2][0].parentEntryId).toBe(DIRECTORY_ID);
  });

  it('appends branch pages without merging entries that share a path', async () => {
    apiMock.browseDeviceFiles.mockImplementation(({ parentEntryId, cursor }) => {
      if (parentEntryId !== ROOT_ONE_ID) return Promise.resolve(browseResponse(parentEntryId, []));
      return Promise.resolve(
        cursor === null
          ? browseResponse(
              ROOT_ONE_ID,
              [buildEntry('018f0000-0000-7000-8000-000000000010', ROOT_ONE_ID)],
              'next-page',
            )
          : browseResponse(ROOT_ONE_ID, [
              buildEntry('018f0000-0000-7000-8000-000000000011', ROOT_ONE_ID),
            ]),
      );
    });
    await mountHook();

    await act(async () => {
      await latest?.loadMoreBranch(ROOT_ONE_ID);
    });

    expect(apiMock.browseDeviceFiles.mock.calls[2][0].cursor).toBe('next-page');
    expect(latest?.branches[ROOT_ONE_ID].entries.map((entry) => entry.absolutePath)).toEqual([
      '/duplicate.log',
      '/duplicate.log',
    ]);
  });

  it('keeps a missing branch visible as an error and reports it to the owner', async () => {
    apiMock.browseDeviceFiles.mockImplementation(({ parentEntryId }) =>
      parentEntryId === ROOT_ONE_ID
        ? Promise.reject(new HttpRequestError(404, 'not found'))
        : Promise.resolve(browseResponse(parentEntryId, [])),
    );
    await mountHook();

    expect(latest?.branches[ROOT_ONE_ID].error?.status).toBe(404);
    expect(onDirectoryMissing).toHaveBeenCalledWith(ROOT_ONE_ID);
  });
});
