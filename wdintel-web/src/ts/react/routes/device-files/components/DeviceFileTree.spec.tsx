/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeviceFileRoot, DeviceFileTreeEntry } from '../../../../../Bindings';
import type { DeviceFilesState } from '../use-device-files';
import { DeviceFileTree } from './DeviceFileTree';

const DEVICE_ID = '018f0000-0000-7000-8000-000000000000';
const ROOT_ID = '018f0000-0000-7000-8000-000000000001';
const NOW = '2026-07-24T08:00:00Z';

const rootEntry: DeviceFileRoot = {
  entryId: ROOT_ID,
  deviceId: DEVICE_ID,
  parentEntryId: null,
  kind: 'directory',
  name: '/',
  pathSyntax: 'posix',
  createdAt: NOW,
  updatedAt: NOW,
};

function buildFileEntry(entryId: string, name: string, hasContent: boolean): DeviceFileTreeEntry {
  return {
    entryId,
    parentEntryId: ROOT_ID,
    kind: 'file',
    fileId: entryId,
    name,
    pathComponents: [name],
    pathSyntax: 'posix',
    absolutePath: `/${name}`,
    hasContent,
    mimeType: null,
    extension: null,
    fileMetadataCreatedAt: null,
    fileMetadataModifiedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

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
    sync: { openSyncForEntry: vi.fn() },
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
});

describe('DeviceFileTree counters', () => {
  it('keeps the tree usable while counts load and exposes a nonblocking retry', () => {
    act(() => {
      root?.render(<DeviceFileTree files={buildFiles({ loading: true })} />);
    });

    expect(container?.textContent).toContain('Файлова система');
    expect(container?.querySelector('[aria-label="Завантаження кількості файлів"]')).not.toBeNull();
    expect(
      container?.querySelector('[aria-label^="Вибрати каталог / як область пошуку"]'),
    ).not.toBeNull();

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

    expect(container?.textContent?.replace(/\s/g, '')).toContain('12345');
    expect(container?.textContent).toContain('Каунтери недоступні');
    expect(
      container?.querySelector('[aria-label^="Вибрати каталог / як область пошуку"]'),
    ).not.toBeNull();

    const retryButton = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Повторити',
    );
    act(() => retryButton?.click());
    expect(retryCounts).toHaveBeenCalledTimes(1);
  });

  it('shows content presence markers instead of file sync actions', () => {
    act(() => {
      root?.render(
        <DeviceFileTree
          files={buildFiles({}, [
            buildFileEntry('018f0000-0000-7000-8000-000000000002', 'available.log', true),
            buildFileEntry('018f0000-0000-7000-8000-000000000003', 'missing.log', false),
          ])}
        />,
      );
    });

    expect(container?.querySelector('[aria-label="Контент файлу наявний"]')).not.toBeNull();
    expect(container?.querySelector('[aria-label="Контент файлу відсутній"]')).not.toBeNull();
    expect(container?.querySelector('[aria-label^="Синхронізувати файл"]')).toBeNull();
  });
});
