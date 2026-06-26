/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsNeoTable } from './SettingsNeoTable';

const tableOptionsMock = vi.hoisted(() => ({
  useMaterialReactTable: vi.fn((options: Record<string, unknown>) => options),
}));

vi.mock('material-react-table', async () => {
  const actual = await vi.importActual<typeof import('material-react-table')>('material-react-table');
  return {
    ...actual,
    useMaterialReactTable: tableOptionsMock.useMaterialReactTable,
    MaterialReactTable: () => <div data-testid="table" />,
  };
});

vi.mock('../../components/mui-customized/table/table-state-provider', () => ({
  useTableStateContext: () => ({
    enableColumnOrdering: true,
    enableColumnResizing: true,
    globalFilter: '',
    columnFilters: [],
    density: 'compact',
    sorting: [],
    columnOrder: [],
    columnSizing: {},
    onTableInitialized: vi.fn(),
    onChangeGlobalFilter: vi.fn(),
    onColumnVisibilityChange: vi.fn(),
    onColumnFiltersChange: vi.fn(),
    onColumnOrderChange: vi.fn(),
    onColumnSizingChange: vi.fn(),
    onSortingChange: vi.fn(),
  }),
}));

afterEach(() => {
  document.body.innerHTML = '';
  tableOptionsMock.useMaterialReactTable.mockClear();
});

describe('SettingsNeoTable', () => {
  it('keeps the top toolbar disabled by default', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        createElement(SettingsNeoTable, {
          columns: [],
          data: [],
        }),
      );
    });

    expect(tableOptionsMock.useMaterialReactTable).toHaveBeenCalled();
    expect(tableOptionsMock.useMaterialReactTable.mock.calls.at(-1)?.[0]?.enableTopToolbar).toBe(false);

    root.unmount();
    container.remove();
  });

  it('can enable the top toolbar explicitly', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        createElement(SettingsNeoTable, {
          columns: [],
          data: [],
          showToolbarInternalActions: true,
          enableTopToolbar: true,
        }),
      );
    });

    expect(tableOptionsMock.useMaterialReactTable.mock.calls.at(-1)?.[0]?.enableTopToolbar).toBe(true);
    expect(tableOptionsMock.useMaterialReactTable.mock.calls.at(-1)?.[0]?.renderTopToolbar).toEqual(expect.any(Function));

    root.unmount();
    container.remove();
  });
});
