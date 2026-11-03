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

let container: HTMLDivElement;
let root: Root | null = null;
let latest: ReturnType<typeof useTableStateContext> | null = null;

function Probe() {
  latest = useTableStateContext();
  return null;
}

function render(sanitizeSorting?: (value: MRT_SortingState) => MRT_SortingState) {
  root?.unmount();
  root = createRoot(container);
  act(() => {
    root?.render(
      <TableStateProvider
        tableId={TABLE_ID}
        defaultColumnVisibility={{}}
        defaultColumnOrder={[]}
        defaultSorting={DEFAULT_SORTING}
        persistSorting
        sanitizeSorting={sanitizeSorting}
      >
        <Probe />
      </TableStateProvider>,
    );
  });
}

describe('TableStateProvider persisted sorting', () => {
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

    render((value) => (value[0]?.id === 'removedColumn' ? DEFAULT_SORTING : value));

    expect(latest?.sorting).toEqual(DEFAULT_SORTING);
  });
});
