/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeviceFileRoot } from '../../../../../../Bindings';
import type { DeviceFilesState } from '../../use-device-files';
import { DeviceFileTree } from '.././DeviceFileTree';

const DEVICE_ID = '018f0000-0000-7000-8000-000000000000';
const ROOT_ID = '018f0000-0000-7000-8000-000000000001';
const NOW = '2026-07-24T08:00:00Z';

const rootEntry: DeviceFileRoot = {
  entryId: ROOT_ID,
  deviceId: DEVICE_ID,
  parentEntryId: null,
  kind: 'directory',
  name: 'C:\\',
  createdAt: NOW,
  updatedAt: NOW,
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
  // @test-scope safeguard: keeps a usable file tree and retry path when count loading fails.
  it('keeps the tree usable while counts load and exposes a nonblocking retry', () => {
    act(() => {
      root?.render(<DeviceFileTree files={buildFiles({ loading: true })} />);
    });

    expect(container?.textContent).toContain('Файлова система');
    expect(container?.querySelector('[aria-label="Завантаження кількості файлів"]')).not.toBeNull();
    expect(
      container?.querySelector('[aria-label^="Вибрати каталог"]')?.getAttribute('aria-label'),
    ).toContain('Вибрати каталог C:\\ як область пошуку');

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
      container?.querySelector('[aria-label^="Вибрати каталог"]')?.getAttribute('aria-label'),
    ).toContain('Вибрати каталог C:\\ як область пошуку');

    const retryButton = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Повторити',
    );
    act(() => retryButton?.click());
    expect(retryCounts).toHaveBeenCalledTimes(1);
  });
});
