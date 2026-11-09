/**
 * @vitest-environment happy-dom
 */
import type { MRT_SortingState } from 'material-react-table';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TableStateProvider, useTableStateContext } from '../table-state-provider.tsx';

const TABLE_ID = 'sorting-spec';
const DEFAULT_SORTING: MRT_SortingState = [{ id: 'activity', desc: true }];
const DEFAULT_COLUMN_ORDER = ['mrt-row-numbers', 'mrt-row-actions', 'name', 'rating', 'tags'];

let container: HTMLDivElement;
let root: Root | null = null;
let latest: ReturnType<typeof useTableStateContext> | null = null;

function Probe() {
  latest = useTableStateContext();
  return null;
}

function render({
  sanitizeSorting,
  isDynamicColumnId,
  defaultSorting = DEFAULT_SORTING,
}: {
  sanitizeSorting?: (value: MRT_SortingState) => MRT_SortingState;
  isDynamicColumnId?: (columnId: string) => boolean;
  defaultSorting?: MRT_SortingState;
} = {}) {
  root?.unmount();
  root = createRoot(container);
  act(() => {
    root?.render(
      <TableStateProvider
        tableId={TABLE_ID}
        defaultColumnVisibility={{}}
        defaultColumnOrder={DEFAULT_COLUMN_ORDER}
        isDynamicColumnId={isDynamicColumnId}
        defaultSorting={defaultSorting}
        persistSorting
        sanitizeSorting={sanitizeSorting}
      >
        <Probe />
      </TableStateProvider>,
    );
  });
}

describe('TableStateProvider persisted state', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const storage = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => storage.delete(key),
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
    window.history.replaceState({}, '', '/devices');
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    latest = null;
    container.remove();
    vi.restoreAllMocks();
  });

  it('restores the last chosen sorting when the URL has none', () => {
    render();
    act(() => {
      latest?.onSortingChange([{ id: 'createdAt', desc: true }]);
    });

    window.history.replaceState({}, '', '/devices');
    render();

    expect(latest?.sorting).toEqual([{ id: 'createdAt', desc: true }]);
  });

  it('prefers the URL sorting over the stored one', () => {
    window.localStorage.setItem(
      `sorting-${TABLE_ID}`,
      JSON.stringify([{ id: 'createdAt', desc: true }]),
    );
    window.history.replaceState(
      {},
      '',
      `/devices?sorting=${encodeURIComponent(JSON.stringify([{ id: 'name', desc: false }]))}`,
    );

    render();

    expect(latest?.sorting).toEqual([{ id: 'name', desc: false }]);
  });

  it('forgets the stored sorting when the default is chosen again', () => {
    render();
    act(() => {
      latest?.onSortingChange([{ id: 'createdAt', desc: true }]);
    });
    act(() => {
      latest?.onSortingChange(DEFAULT_SORTING);
    });

    expect(window.localStorage.getItem(`sorting-${TABLE_ID}`)).toBeNull();
  });

  it('#3610 keeps sorting cleared when storage removal fails during reconciliation', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    render({ defaultSorting: [] });
    act(() => latest?.onSortingChange([{ id: 'name', desc: false }]));
    const removal = vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {
      throw new DOMException('Storage denied', 'SecurityError');
    });

    act(() => latest?.onSortingChange([]));

    expect(latest?.sorting).toEqual([]);
    expect(new URLSearchParams(window.location.search).has('sorting')).toBe(false);
    act(() => window.dispatchEvent(new PopStateEvent('popstate')));
    expect(latest?.sorting).toEqual([]);

    removal.mockRestore();
    act(() => latest?.onSortingChange([{ id: 'rating', desc: true }]));
    window.history.replaceState({}, '', '/devices');
    act(() => window.dispatchEvent(new PopStateEvent('popstate')));
    expect(latest?.sorting).toEqual([{ id: 'rating', desc: true }]);
  });

  it('#3610 retains unsaved visibility when column defaults are reconciled', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    window.localStorage.setItem(`visibleColumns-${TABLE_ID}`, JSON.stringify(['name']));
    render();
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage full', 'QuotaExceededError');
    });

    act(() => latest?.onChangeColumnsVisibility({ name: true, rating: true }));
    act(() => latest?.updateColumnVisibility({ name: false, rating: false, tags: true }));

    expect(latest?.columnVisibility).toEqual({ name: true, rating: true, tags: true });

    render();
    expect(latest?.columnVisibility).toEqual({ name: true });
  });

  it.each(['getter', 'methods'])(
    '#3610 keeps table state usable with denied storage %s',
    (access) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const deny = () => {
        throw new DOMException('Storage denied', 'SecurityError');
      };
      if (access === 'getter') {
        Object.defineProperty(window, 'localStorage', { configurable: true, get: deny });
      } else {
        vi.spyOn(window.localStorage, 'getItem').mockImplementation(deny);
        vi.spyOn(window.localStorage, 'setItem').mockImplementation(deny);
        vi.spyOn(window.localStorage, 'removeItem').mockImplementation(deny);
      }

      render();
      expect(latest?.columnOrder).toEqual(DEFAULT_COLUMN_ORDER);
      expect(latest?.columnVisibility).toEqual({});
      expect(latest?.sorting).toEqual(DEFAULT_SORTING);
      act(() => latest?.onChangeColumnVisibility('name', true));
      act(() => latest?.updateColumnVisibility());
      expect(latest?.columnVisibility).toEqual({ name: true });
      act(() => latest?.onResetColumnsVisibility());
      act(() => latest?.updateColumnVisibility());
      expect(latest?.columnVisibility).toEqual({});

      act(() => latest?.onSortingChange([{ id: 'name', desc: false }]));
      window.history.replaceState({}, '', '/devices?tab=details');
      act(() => window.dispatchEvent(new PopStateEvent('popstate')));
      expect(latest?.sorting).toEqual([{ id: 'name', desc: false }]);
      expect(new URLSearchParams(window.location.search).get('tab')).toBe('details');
    },
  );

  it('sanitizes a stale stored sorting', () => {
    window.localStorage.setItem(
      `sorting-${TABLE_ID}`,
      JSON.stringify([{ id: 'removedColumn', desc: true }]),
    );

    render({
      sanitizeSorting: (value) => (value[0]?.id === 'removedColumn' ? DEFAULT_SORTING : value),
    });

    expect(latest?.sorting).toEqual(DEFAULT_SORTING);
  });

  // #3999: a dragged custom field column (e.g. `device_id`) lost its position on reload because
  // the stored order was reset and overwritten for containing a column absent from the default.
  it('keeps the stored position of dynamic columns across reloads', () => {
    const stored = [
      'mrt-row-numbers',
      'mrt-row-actions',
      'tags',
      'name',
      'customField:device_id',
      'rating',
    ];
    window.localStorage.setItem(`columnOrder-${TABLE_ID}`, JSON.stringify(stored));

    render({ isDynamicColumnId: (columnId) => columnId.startsWith('customField:') });

    expect(latest?.columnOrder).toEqual(stored);
    expect(window.localStorage.getItem(`columnOrder-${TABLE_ID}`)).toBe(JSON.stringify(stored));
  });
});
