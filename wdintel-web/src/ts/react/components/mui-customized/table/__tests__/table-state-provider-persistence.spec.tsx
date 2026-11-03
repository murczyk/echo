/**
 * @vitest-environment happy-dom
 */
import type { MRT_SortingState } from 'material-react-table';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
}: {
  sanitizeSorting?: (value: MRT_SortingState) => MRT_SortingState;
  isDynamicColumnId?: (columnId: string) => boolean;
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
        defaultSorting={DEFAULT_SORTING}
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
    window.localStorage.clear();
    window.history.replaceState({}, '', '/devices');
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    latest = null;
    container.remove();
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
