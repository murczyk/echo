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
} from '../../../../../Bindings';
import { HttpRequestError } from '../../../services/api/client';
import { useDeviceFileTree } from '../use-device-file-tree';

const apiMock = vi.hoisted(() => ({
  browseDeviceFiles: vi.fn(),
}));

vi.mock('../../../services/api/devices', () => apiMock);

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
    createdAt: NOW,
    updatedAt: NOW,
    tags: [],
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
    absolutePath: kind === 'file' ? 'C:\\duplicate.log' : null,
    hasContent: false,
    mimeType: kind === 'file' ? 'text/plain' : null,
    extension: kind === 'file' ? 'log' : null,
    fileMetadataCreatedAt: null,
    fileMetadataModifiedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    tags: [],
    archive: null,
    revision: kind === 'file' ? 1 : null,
    syncId: null,
    sourceFileState: null,
  };
}

function browseResponse(
  parentEntryId: string,
  entries: DeviceFileTreeEntry[],
  nextCursor: string | null = null,
): BrowseDeviceFilesRsp {
  return {
    breadcrumbs: [{ entryId: parentEntryId, name: 'C:\\' }],
    entries,
    nextCursor,
  };
}

const roots = [buildRoot(ROOT_ONE_ID, 'C:\\'), buildRoot(ROOT_TWO_ID, 'D:\\')];
const onDirectoryMissing = vi.fn();
const onDirectoriesLoaded = vi.fn();
const onAccessDenied = vi.fn();
let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: ReturnType<typeof useDeviceFileTree> | null = null;

function Harness({
  hasContent = null,
  syncId = null,
}: {
  hasContent?: boolean | null;
  syncId?: string | null;
}) {
  latest = useDeviceFileTree({
    deviceId: DEVICE_ID,
    syncId,
    enabled: true,
    hasContent,
    roots,
    tagFilter: { tagIds: [], tagMatch: 'any', untagged: false },
    onDirectoryMissing,
    onDirectoriesLoaded,
    onAccessDenied,
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
  it('#3778 preserves unrelated roots when a directory disappears', async () => {
    await mountHook();
    apiMock.browseDeviceFiles.mockRejectedValueOnce(new HttpRequestError(404, 'missing directory'));
    await act(async () => {
      await latest?.retryBranch(DIRECTORY_ID);
    });
    expect(latest!.branches[ROOT_ONE_ID].entries[0].entryId).toBe(DIRECTORY_ID);
    expect(latest!.branches[ROOT_TWO_ID]).toBeDefined();
    expect(latest!.branches[DIRECTORY_ID].error?.status).toBe(404);
    expect(onDirectoryMissing).toHaveBeenCalledWith(DIRECTORY_ID);
    expect(onAccessDenied).not.toHaveBeenCalled();
  });

  it('#3778 clears cached branches and selection after a forbidden refresh', async () => {
    await mountHook();
    act(() => latest?.toggleDirectory(DIRECTORY_ID));
    await flush();
    apiMock.browseDeviceFiles.mockRejectedValue(new HttpRequestError(403, 'revoked'));
    await act(async () => {
      await latest?.retryBranch(ROOT_ONE_ID);
    });
    expect(Object.values(latest!.branches).flatMap((branch) => branch.entries)).toEqual([]);
    expect(latest!.branches[ROOT_ONE_ID].error?.status).toBe(403);
    expect(onAccessDenied).toHaveBeenCalled();
  });

  it('#3778 does not inject a linked historical file after its branch denies access', async () => {
    await mountHook();
    apiMock.browseDeviceFiles.mockRejectedValue(new HttpRequestError(403, 'revoked'));
    let revealed: unknown;
    await act(async () => {
      revealed = await latest?.revealFile(
        {
          rootEntryId: ROOT_ONE_ID,
          currentRevision: 2,
          ancestors: [],
          file: { ...buildEntry('private', ROOT_ONE_ID), revision: 1 },
        },
        new AbortController().signal,
      );
    });
    expect(revealed).toBe(false);
    expect(Object.values(latest!.branches).flatMap((branch) => branch.entries)).toEqual([]);
  });

  it('#3778 reveals and paginates historical archive members with the located revision', async () => {
    await mountHook();
    const archiveId = 'archive';
    const member = { ...buildEntry('member', archiveId), revision: 7 };
    const directory = {
      ...buildEntry('archive-dir', archiveId, 'directory'),
      archiveOrigin: { archiveId: 'job', sourceFileId: archiveId, sourceRevision: 7 },
      revision: 7,
    };
    apiMock.browseDeviceFiles.mockImplementation(({ parentEntryId, archiveRevision, cursor }) => {
      if (parentEntryId !== archiveId)
        return Promise.resolve(
          browseResponse(
            parentEntryId,
            parentEntryId === ROOT_ONE_ID
              ? [{ ...buildEntry(archiveId, ROOT_ONE_ID), isArchive: true, revision: 8 }]
              : [],
          ),
        );
      if (archiveRevision !== 7) return Promise.reject(new HttpRequestError(409, 'not ready'));
      return Promise.resolve(
        browseResponse(archiveId, [directory, member], cursor ? null : 'more'),
      );
    });
    let revealed: unknown;
    await act(async () => {
      revealed = await latest?.revealFile(
        {
          rootEntryId: ROOT_ONE_ID,
          currentRevision: 8,
          ancestors: [{ ...buildEntry(archiveId, ROOT_ONE_ID), isArchive: true, revision: 7 }],
          file: member,
        },
        new AbortController().signal,
      );
    });
    expect(revealed).toBe(true);
    expect(
      latest!.branches[ROOT_ONE_ID].entries.find((entry) => entry.entryId === archiveId)?.revision,
    ).toBe(7);
    expect(onDirectoriesLoaded).not.toHaveBeenCalledWith(archiveId, ['archive-dir']);
    await act(async () => {
      await latest?.loadMoreBranch(archiveId);
    });
    expect(apiMock.browseDeviceFiles.mock.calls.at(-1)?.[0]).toMatchObject({
      parentEntryId: archiveId,
      archiveRevision: 7,
      cursor: 'more',
    });
  });

  it('#3778 discards the first A page after session A to B to A', async () => {
    let resolveFirst!: (response: BrowseDeviceFilesRsp) => void;
    let calls = 0;
    apiMock.browseDeviceFiles.mockImplementation(({ parentEntryId, syncId, cursor }) => {
      if (parentEntryId !== ROOT_ONE_ID) return Promise.resolve(browseResponse(parentEntryId, []));
      if (++calls === 1)
        return new Promise<BrowseDeviceFilesRsp>((resolve) => {
          resolveFirst = resolve;
        });
      return Promise.resolve(
        browseResponse(
          parentEntryId,
          [
            {
              ...buildEntry(`${syncId}-${cursor ?? 'first'}`, parentEntryId),
              revision: syncId === 'A' ? 1 : 2,
            },
          ],
          cursor === null ? `${syncId}-next` : null,
        ),
      );
    });
    for (const syncId of ['A', 'B', 'A']) {
      await act(async () => root?.render(<Harness syncId={syncId} />));
    }
    await act(async () =>
      resolveFirst(
        browseResponse(ROOT_ONE_ID, [buildEntry('obsolete-A', ROOT_ONE_ID)], 'obsolete'),
      ),
    );
    await act(async () => {
      await latest?.loadMoreBranch(ROOT_ONE_ID);
    });
    expect(latest!.branches[ROOT_ONE_ID].entries.map((entry) => entry.entryId)).toEqual([
      'A-first',
      'A-A-next',
    ]);
    expect(apiMock.browseDeviceFiles.mock.calls.at(-1)?.[0]).toMatchObject({
      syncId: 'A',
      cursor: 'A-next',
    });
  });

  it('expands and loads every filesystem root immediately', async () => {
    await mountHook();

    expect(apiMock.browseDeviceFiles.mock.calls.map(([req]) => req.parentEntryId)).toEqual([
      ROOT_ONE_ID,
      ROOT_TWO_ID,
    ]);
    expect(latest?.expandedEntryIds).toEqual(new Set([ROOT_ONE_ID, ROOT_TWO_ID]));
    expect(latest?.branches[ROOT_ONE_ID].entries[0].entryId).toBe(DIRECTORY_ID);
    expect(latest?.branches[ROOT_TWO_ID].entries).toEqual([]);
    expect(onDirectoriesLoaded).toHaveBeenCalledWith(ROOT_ONE_ID, [DIRECTORY_ID]);
  });

  it('discards an outstanding branch page when the content filter changes', async () => {
    let resolvePrevious!: (response: BrowseDeviceFilesRsp) => void;
    let previousSignal!: AbortSignal;
    apiMock.browseDeviceFiles.mockImplementation(
      ({ parentEntryId, hasContent, cursor }, options) => {
        if (parentEntryId !== ROOT_ONE_ID)
          return Promise.resolve(browseResponse(parentEntryId, []));
        if (hasContent === true) {
          previousSignal = options.signal;
          return new Promise<BrowseDeviceFilesRsp>((resolve) => {
            resolvePrevious = resolve;
          });
        }
        return Promise.resolve(
          browseResponse(
            ROOT_ONE_ID,
            [buildEntry(cursor === null ? 'missing-first' : 'missing-next', ROOT_ONE_ID)],
            cursor === null ? 'missing-cursor' : null,
          ),
        );
      },
    );
    await act(async () => {
      root?.render(<Harness hasContent={true} />);
    });
    await act(async () => {
      root?.render(<Harness hasContent={false} />);
    });
    expect(previousSignal.aborted).toBe(true);
    await act(async () => {
      resolvePrevious(
        browseResponse(ROOT_ONE_ID, [buildEntry('stale', ROOT_ONE_ID)], 'stale-cursor'),
      );
    });
    expect(latest?.branches[ROOT_ONE_ID].entries.map((entry) => entry.entryId)).toEqual([
      'missing-first',
    ]);
    await act(async () => {
      await latest?.loadMoreBranch(ROOT_ONE_ID);
    });
    expect(apiMock.browseDeviceFiles.mock.calls.at(-1)?.[0]).toMatchObject({
      hasContent: false,
      cursor: 'missing-cursor',
    });
    expect(latest?.branches[ROOT_ONE_ID].entries.map((entry) => entry.entryId)).toEqual([
      'missing-first',
      'missing-next',
    ]);
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
      'C:\\duplicate.log',
      'C:\\duplicate.log',
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

  // Regression: https://github.com/echoua/echo/pull/3268
  it('shows a localized file-registry configuration error for a normal directory load', async () => {
    apiMock.browseDeviceFiles.mockImplementation(({ parentEntryId }) =>
      parentEntryId === ROOT_ONE_ID
        ? Promise.reject(
            new HttpRequestError(
              503,
              'Device file operations are unavailable because the [file_registry] configuration section is missing.',
            ),
          )
        : Promise.resolve(browseResponse(parentEntryId, [])),
    );
    await mountHook();

    expect(latest?.branches[ROOT_ONE_ID].error?.message).toContain(
      'Сховище файлів пристроїв не налаштоване',
    );
    expect(latest?.branches[ROOT_ONE_ID].error?.message).not.toContain(
      'Device file operations are unavailable',
    );
  });
});
