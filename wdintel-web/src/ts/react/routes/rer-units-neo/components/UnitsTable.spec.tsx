/**
 * @vitest-environment happy-dom
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Unit } from '../../../../../Bindings';
import { UnitsTable } from './UnitsTable';

const tableStateMock = vi.hoisted(() => ({
  globalFilter: '',
  columnFilters: [],
  sorting: [],
  columnOrder: [],
  columnSizing: {},
  columnVisibility: {},
  enableColumnOrdering: true,
  enableColumnResizing: true,
  onChangeGlobalFilter: vi.fn(),
  onColumnFiltersChange: vi.fn(),
  onSortingChange: vi.fn(),
  onColumnOrderChange: vi.fn(),
  onColumnSizingChange: vi.fn(),
  onColumnVisibilityChange: vi.fn(),
  onTableInitialized: vi.fn(),
}));

const mrtMock = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  table: {
    getState: () => ({ isFullScreen: false, showSkeletons: false }),
    nextPage: vi.fn(),
  },
}));

vi.mock('@mui/material', async () => {
  const actual = await vi.importActual<typeof import('@mui/material')>('@mui/material');
  return {
    ...actual,
    useMediaQuery: () => false,
  };
});

vi.mock('../../../components/mui-customized/table/table-state-provider', () => ({
  useTableStateContext: () => tableStateMock,
}));

vi.mock('material-react-table', () => ({
  MaterialReactTable: () => null,
  useMaterialReactTable: (options: Record<string, unknown>) => {
    mrtMock.options = options;
    return mrtMock.table;
  },
}));

let root: Root | null = null;

function renderTable(totalCount: number) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <UnitsTable
        units={[]}
        totalCount={totalCount}
        attachmentUnitIds={new Set()}
        loading={false}
        canEdit={false}
        actionInFlight={false}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onMerge={vi.fn()}
        searchMode="strict"
        onSearchModeChange={vi.fn()}
        pagination={{ pageIndex: 0, pageSize: 20 }}
        onPaginationChange={vi.fn()}
      />,
    );
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  mrtMock.options = null;
  vi.clearAllMocks();
});

describe('UnitsTable pagination', () => {
  it('does not enable the native bottom toolbar on the last page', () => {
    renderTable(20);

    expect(mrtMock.options?.enableBottomToolbar).toBe(false);
  });

  it('places the load-more toolbar in the table scroll flow', () => {
    renderTable(21);

    expect(mrtMock.options?.enableBottomToolbar).toBe(true);

    const paperProps = (
      mrtMock.options?.muiTablePaperProps as (props: { table: typeof mrtMock.table }) => {
        sx: Record<string, unknown>;
      }
    )({ table: mrtMock.table });
    const containerProps = mrtMock.options?.muiTableContainerProps as {
      sx: Record<string, unknown>;
    };

    expect(paperProps.sx).toMatchObject({ display: 'block', overflow: 'auto' });
    expect(containerProps.sx).toMatchObject({
      flex: 'none',
      height: 'auto',
      maxHeight: 'none',
      overflow: 'visible',
    });

    const toolbar = (
      mrtMock.options?.renderBottomToolbar as (props: { table: typeof mrtMock.table }) => ReactNode
    )({ table: mrtMock.table });
    const toolbarContainer = document.createElement('div');
    document.body.appendChild(toolbarContainer);
    const toolbarRoot = createRoot(toolbarContainer);
    act(() => toolbarRoot.render(toolbar));
    act(() => toolbarContainer.querySelector('button')?.click());

    expect(toolbarContainer.textContent).toContain('Завантажити ще');
    expect(mrtMock.table.nextPage).toHaveBeenCalledOnce();

    act(() => toolbarRoot.unmount());
  });
});
