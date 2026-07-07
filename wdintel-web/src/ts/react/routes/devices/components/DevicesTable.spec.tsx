/**
 * @vitest-environment happy-dom
 */
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeviceRowView } from '../helpers';
import { DevicesTable } from './DevicesTable';

const mrtMock = vi.hoisted(() => ({
  useMaterialReactTable: vi.fn(),
  MaterialReactTable: vi.fn(() => null),
}));

vi.mock('material-react-table', () => ({
  MaterialReactTable: mrtMock.MaterialReactTable,
  useMaterialReactTable: (options: Record<string, unknown>) => {
    mrtMock.useMaterialReactTable(options);
    return { options };
  },
}));

let capturedOptions: Record<string, unknown> | null = null;
let container: HTMLDivElement | null = null;
let root: Root | null = null;

const tableStateContext = {
  globalFilter: '',
  sorting: [],
  columnOrder: [],
  columnSizing: {},
  columnVisibility: {},
  enableColumnOrdering: true,
  enableColumnResizing: true,
  onChangeGlobalFilter: vi.fn(),
  onSortingChange: vi.fn(),
  onColumnOrderChange: vi.fn(),
  onColumnSizingChange: vi.fn(),
  onColumnVisibilityChange: vi.fn(),
  onTableInitialized: vi.fn(),
};

function buildDeviceRow(): DeviceRowView {
  return {
    id: '018f0000-0000-7000-8000-000000000000',
    name: 'Device Alpha',
    createdBy: 'tester',
    aorId: null,
    aorName: null,
    unitId: null,
    unitName: null,
    externalUrl: null,
    deleted: false,
    createdAtMs: 1,
    updatedAtMs: 2,
    deletedAtMs: null,
    aorLabel: '—',
    unitLabel: '—',
    createdAtLabel: '01.01.1970, 00:00:00',
    updatedAtLabel: '01.01.1970, 00:00:00',
    deletedAtLabel: '—',
  };
}

function renderTable() {
  const row = buildDeviceRow();
  act(() => {
    root?.render(
      <DevicesTable
        rows={[row]}
        loading={false}
        refreshing={false}
        loadingMore={false}
        hasMore={false}
        total={1}
        canEdit={false}
        mutatingDeviceId={null}
        showLifecycle={false}
        hasFilters={false}
        tableStateContext={tableStateContext as never}
        onDelete={vi.fn()}
        onRestore={vi.fn()}
        onLoadMore={() => Promise.resolve()}
        onClearFilters={vi.fn()}
        onTableInitialized={vi.fn()}
        columnOrder={[]}
      />,
    );
  });
  return row;
}

beforeEach(() => {
  capturedOptions = null;
  mrtMock.useMaterialReactTable.mockImplementation((options: Record<string, unknown>) => {
    capturedOptions = options;
  });
  window.history.replaceState({}, '', '/devices');
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

describe('DevicesTable', () => {
  it('navigates to detail through SPA history from the name link', () => {
    const row = renderTable();
    const columns = capturedOptions?.columns as Array<{
      id: string;
      Cell?: (props: { row: { original: DeviceRowView } }) => ReactNode;
    }>;
    const nameColumn = columns.find((column) => column.id === 'name');
    expect(nameColumn?.Cell).toBeTypeOf('function');

    const linkHost = document.createElement('div');
    document.body.appendChild(linkHost);
    const linkRoot = createRoot(linkHost);
    const popstateListener = vi.fn();
    window.addEventListener('popstate', popstateListener);

    try {
      act(() => {
        linkRoot.render(createElement(nameColumn!.Cell!, { row: { original: row } }));
      });

      const link = linkHost.querySelector('a');
      expect(link?.getAttribute('href')).toBe(`/devices/${row.id}`);

      act(() => {
        link?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
        );
      });

      expect(window.location.pathname).toBe(`/devices/${row.id}`);
      expect(popstateListener).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('popstate', popstateListener);
      act(() => linkRoot.unmount());
      linkHost.remove();
    }
  });
});
