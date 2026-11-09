/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeviceFileRoot, DeviceFileTreeEntry } from '../../../../../../Bindings';
import type { DeviceFilesState } from '../../use-device-files';
import { DeviceFileTree } from '.././DeviceFileTree';
import { transformCamelToSnake } from '../../../../../snake-to-camel';

const DEVICE_ID = '018f0000-0000-7000-8000-000000000000';
const ROOT_ID = '018f0000-0000-7000-8000-000000000001';
const NOW = '2026-07-24T08:00:00Z';

const rootEntry: DeviceFileRoot = {
  entryId: ROOT_ID,
  deviceId: DEVICE_ID,
  parentEntryId: null,
  kind: 'directory',
  name: 'C:\\',
  fileMetadataCreatedAt: null,
  fileMetadataModifiedAt: null,
  contentUploadedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  tags: [],
};

const retryCounts = vi.fn();

function buildFiles(
  counts: Partial<DeviceFilesState['counts']> = {},
  entries: DeviceFileTreeEntry[] = [],
): DeviceFilesState {
  return {
    roots: [rootEntry],
    rootsLoading: false,
    rootsRefreshing: false,
    rootsError: null,
    scopeNotice: null,
    searchScope: null,
    selectSearchScope: vi.fn(),
    selectFile: vi.fn(),
    reloadRoots: vi.fn(),
    refreshVisible: vi.fn(),
    counts: {
      countsByEntryId: {},
      loading: false,
      error: null,
      enqueue: vi.fn(),
      retry: retryCounts,
      reset: vi.fn(),
      ...counts,
    },
    tree: {
      branches: {
        [ROOT_ID]: {
          entries,
          nextCursor: null,
          loading: false,
          refreshing: false,
          loadingMore: false,
          error: null,
          loadMoreError: null,
        },
      },
      expandedEntryIds: new Set([ROOT_ID]),
      refreshing: false,
      toggleDirectory: vi.fn(),
      retryBranch: vi.fn(),
      loadMoreBranch: vi.fn(),
      refreshExpanded: vi.fn(),
    },
  } as unknown as DeviceFilesState;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('DeviceFileTree', () => {
  it('#3778 remounts archive revision A to B to A and keeps a same-name physical file separate', async () => {
    const calls: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        const revision = body.archive_revision ?? Number(url.match(/revisions\/(\d+)/)?.[1]);
        if (url.endsWith('/browse')) calls.push(revision);
        const archiveId = `archive-${revision}`;
        const response = url.endsWith('/browse')
          ? {
              archiveId,
              rootEntryId: `root-${revision}`,
              breadcrumbs: [],
              nextCursor: null,
              entries: [
                {
                  entryId: 'member',
                  fileId: 'member',
                  revision,
                  parentEntryId: 'zip',
                  name: 'Report.txt',
                  kind: 'file',
                  virtualPath: 'C:\\bundle.zip/Report.txt',
                  hasContent: true,
                  mimeType: 'text/plain',
                  extension: 'txt',
                  sizeBytes: 1,
                  tags: [],
                  archive: null,
                  archiveOrigin: { archiveId, sourceFileId: 'zip', sourceRevision: revision },
                },
              ],
            }
          : {
              source: { deviceId: DEVICE_ID, fileId: 'zip', revision },
              archive: {
                archiveId,
                rootEntryId: `root-${revision}`,
                state: 'ready',
                reason: null,
                message: null,
                limitName: null,
              },
              nextAttemptAt: null,
              pollAfterMs: 2000,
              updatedAt: NOW,
            };
        return new Response(JSON.stringify(transformCamelToSnake(response)), {
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    const entry: DeviceFileTreeEntry = {
      entryId: 'zip',
      parentEntryId: ROOT_ID,
      kind: 'file',
      fileId: 'zip',
      name: 'bundle.zip',
      pathComponents: ['bundle.zip'],
      absolutePath: 'C:\\bundle.zip',
      hasContent: true,
      mimeType: 'application/zip',
      extension: 'zip',
      revision: 1,
      syncId: 'A',
      sourceFileState: null,
      createdAt: NOW,
      updatedAt: NOW,
      contentUploadedAt: null,
      fileMetadataCreatedAt: null,
      fileMetadataModifiedAt: null,
      tags: [],
      archive: null,
    };
    for (const revision of [1, 2, 1]) {
      const files = {
        ...buildFiles({}, [
          { ...entry, revision },
          {
            ...entry,
            entryId: 'physical',
            fileId: 'physical',
            name: 'Report.txt',
            mimeType: 'text/plain',
            extension: 'txt',
          },
        ]),
        deviceId: DEVICE_ID,
        tagFilter: { tagIds: [], tagMatch: 'any' as const, untagged: false },
        contentFilter: null,
      };
      await act(async () => root?.render(<DeviceFileTree files={files} />));
      expect(container?.querySelectorAll('[aria-label="Report.txt"]')).toHaveLength(0);
      await act(async () =>
        container
          ?.querySelector<HTMLButtonElement>('[aria-label="Розгорнути каталог bundle.zip"]')!
          .click(),
      );
      const member = container?.querySelector<HTMLButtonElement>('[aria-label="Report.txt"]');
      expect(member).not.toBeNull();
      expect(container?.querySelector('[data-testid="device-file-physical"]')).not.toBeNull();
      await act(async () => member!.click());
      expect(files.selectFile).toHaveBeenCalledWith(
        expect.objectContaining({
          fileId: 'member',
          revision,
          archiveOrigin: {
            archiveId: `archive-${revision}`,
            sourceFileId: 'zip',
            sourceRevision: revision,
          },
          archiveParents: [expect.objectContaining({ fileId: 'zip', revision })],
        }),
      );
    }
    expect(calls).toEqual([1, 2, 1]);
  });

  it('keeps the tree usable without status rows while counts load or fail', () => {
    act(() => {
      root?.render(<DeviceFileTree files={buildFiles({ loading: true })} />);
    });

    expect(container?.querySelector('[aria-label="Синхронізовані файлові корені"]')).not.toBeNull();
    expect(container?.querySelector('[aria-label="Завантаження кількості файлів"]')).toBeNull();
    expect(
      container?.querySelector('[aria-label^="Відкрити папку"]')?.getAttribute('aria-label'),
    ).toContain('Відкрити папку C:\\');

    act(() => {
      root?.render(
        <DeviceFileTree
          files={buildFiles({
            countsByEntryId: { [ROOT_ID]: 12_345 },
            error: { message: 'Каунтери недоступні', status: 500 },
          })}
        />,
      );
    });

    expect(container?.textContent?.replace(/\s/g, '')).not.toContain('12345');
    expect(container?.textContent).not.toContain('Каунтери недоступні');
    expect(
      container?.querySelector('[aria-label^="Відкрити папку"]')?.getAttribute('aria-label'),
    ).toContain('Відкрити папку C:\\');
  });
});
