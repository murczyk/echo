/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CallsignRowView, CallsignsSortState, OnSort } from '../types';
import { CallsignsTable, getCallsignsTableContainerOverflowY } from './CallsignsTable';

const tableMockState = vi.hoisted(() => ({
  options: null as Record<string, any> | null,
}));

vi.mock('@mui/material', () => ({
  Box: ({ children, ...props }: { children?: ReactNode }) => <div {...props}>{children}</div>,
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  CircularProgress: () => <span>loading</span>,
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Typography: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock('material-react-table', () => ({
  MaterialReactTable: ({ table }: { table: any }) => (
    <div data-testid="table">
      {table.data.map((row: CallsignRowView) => {
        const sourceColumn = table.columns.find(
          (column: { id: string }) => column.id === 'sourceName',
        );
        return (
          <div key={row.id} data-testid={`source-${row.id}`}>
            {sourceColumn.Cell?.({ row: { original: row } })}
            {table.renderRowActions?.({ row: { original: row } })}
          </div>
        );
      })}
    </div>
  ),
  useMaterialReactTable: (options: any) => ({
    ...options,
    getState: () => ({ isFullScreen: false }),
  }),
}));

vi.mock('../../../components/MrtRowActionButton', () => ({
  MrtRowActions: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  MrtRowActionButton: (props: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    opensModal?: boolean;
  }) => (
    <button
      type="button"
      aria-label={props.label}
      data-opens-modal={props.opensModal ? 'true' : 'false'}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  ),
  mrtRowActionsColumnSize: () => 96,
}));

vi.mock('../../../components/SectionLoadingOverlay', () => ({
  SectionLoadingOverlay: () => null,
}));

vi.mock('../../../components/mui-customized/table/get-default-table-options', () => ({
  buildDefaultColumnOrder: ({ dataColumnIds }: { dataColumnIds: string[] }) => dataColumnIds,
  getDefaultMRTOptions: () => ({ displayColumnDefOptions: {} }),
  mrtTextCell: ({ displayValue }: { displayValue: (props: unknown) => ReactNode }) => displayValue,
  mrtItemsCell:
    ({
      items,
      renderItem,
      renderDisclosureItem,
      getItemText,
    }: {
      items: (props: any) => unknown[];
      renderItem: (item: any) => ReactNode;
      renderDisclosureItem?: (item: any, index: number) => ReactNode;
      getItemText?: (item: any, index: number) => string;
    }) =>
    (props: any) => {
      const values = items(props);
      return (
        <>
          {values.map(renderItem)}
          <div data-testid="source-disclosure">
            {values.map(renderDisclosureItem ?? renderItem)}
          </div>
          <span data-testid="source-copy-text">
            {values.map((item, index) => getItemText?.(item, index) ?? '').join('\n')}
          </span>
        </>
      );
    },
  useAppMaterialReactTable: (options: Record<string, any>) => {
    tableMockState.options = options;
    return {
      ...options,
      options,
      getState: () => ({ isFullScreen: false }),
    };
  },
  buildExplicitSingleSelectColumnFilter: () => () => null,
  getFilterModeHelperText: () => '',
  withExplicitSelectAllOption: (options: unknown[]) => options,
  renderColumnActionsMenuItems: () => [],
}));

vi.mock('../../../components/mui-customized/table/table-state-provider', () => ({
  useTableStateContext: () => ({
    globalFilter: '',
    columnFilters: [],
    sorting: [],
    columnOrder: [],
    columnSizing: {},
    columnVisibility: {},
    enableColumnOrdering: false,
    enableColumnResizing: true,
    onChangeGlobalFilter: vi.fn(),
    onColumnFiltersChange: vi.fn(),
    onSortingChange: vi.fn(),
    onColumnOrderChange: vi.fn(),
    onColumnSizingChange: vi.fn(),
    onColumnVisibilityChange: vi.fn(),
    onTableInitialized: vi.fn(),
  }),
}));

function buildRow(id = 1): CallsignRowView {
  return {
    id,
    callsign: 'ЛЕС',
    position: 'Командир',
    fullName: 'Іваненко Іван',
    comment: '',
    unitName: '11 АК',
    sourceName: 'РО',
    radioFreq: '100.100',
    developing: false,
    createdAt: 0,
    active: true,
    unitId: 1,
    sourceId: 1,
    callsignAdditionalSourceIds: [],
    callsignAdditionalSourceNames: [],
  } as CallsignRowView;
}

function renderTable(
  rows: CallsignRowView[],
  sort: CallsignsSortState = null,
  onSort: OnSort = vi.fn(),
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <CallsignsTable
        canEdit
        rows={rows}
        loading={false}
        refreshing={false}
        loadingMore={false}
        showLoadMore={false}
        hasActiveFilters={false}
        textFilters={{
          filterCallsign: '',
          filterPosition: '',
          filterFullName: '',
          filterComment: '',
          filterUnit: '',
        }}
        inFlightDeleteId={null}
        bulkDeleteInFlight={false}
        selectedCallsignIds={[]}
        sort={sort}
        statusFilter="All"
        onSort={onSort}
        onStatusFilterChange={vi.fn()}
        onTextColumnFiltersChange={vi.fn()}
        onClearFilters={vi.fn()}
        onSetSelectedCallsignIds={vi.fn()}
        onLoadMore={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
  });

  return { container, root };
}

afterEach(() => {
  tableMockState.options = null;
  document.body.innerHTML = '';
});

describe('CallsignsTable', () => {
  it('supports clearing the selected sort for every sortable column', () => {
    const onSort = vi.fn();
    const { root } = renderTable([buildRow()], { column: 'unit', direction: 'asc' }, onSort);

    expect(tableMockState.options?.enableSortingRemoval).toBe(true);
    act(() => {
      tableMockState.options?.onSortingChange([]);
    });
    expect(onSort).toHaveBeenCalledWith(null);

    root.unmount();
  });

  it('marks edit and delete row actions as modal actions', () => {
    const { container, root } = renderTable([buildRow()]);

    expect(
      container.querySelector('[data-opens-modal="true"][aria-label="Редагувати"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('[data-opens-modal="true"][aria-label="Видалити"]'),
    ).toBeTruthy();

    root.unmount();
    container.remove();
  });

  it('renders primary and confirming sources with their distinct roles', () => {
    const rowWithConfirmations = {
      ...buildRow(1),
      callsignAdditionalSourceIds: [2, 3],
      callsignAdditionalSourceNames: ['Підтвердження 1', 'Підтвердження 2'],
    };
    const rowWithoutConfirmations = buildRow(2);
    const { container, root } = renderTable([rowWithConfirmations, rowWithoutConfirmations]);

    const confirmedSources = container.querySelector('[data-testid="source-1"]');
    const primaryOnlySource = container.querySelector('[data-testid="source-2"]');

    expect(confirmedSources?.textContent).toContain('Основне:');
    expect(confirmedSources?.textContent).toContain('РО');
    expect(confirmedSources?.textContent).toContain('Підтверджено:');
    expect(confirmedSources?.textContent).toContain('Підтвердження 1');
    expect(confirmedSources?.textContent).toContain('Підтвердження 2');
    expect(primaryOnlySource?.textContent).toContain('Основне:');
    expect(primaryOnlySource?.textContent).not.toContain('Підтверджено:');

    const disclosure = confirmedSources?.querySelector('[data-testid="source-disclosure"]');
    expect(disclosure?.textContent).toContain('Основне джерело: РО');
    expect(disclosure?.textContent).toContain('Підтверджено: Підтвердження 1');
    expect(disclosure?.textContent).toContain('Підтверджено: Підтвердження 2');
    expect(confirmedSources?.querySelector('[data-testid="source-copy-text"]')?.textContent).toBe(
      'Основне джерело: РО\nПідтверджено: Підтвердження 1\nПідтверджено: Підтвердження 2',
    );

    root.unmount();
    container.remove();
  });

  it('hides vertical container overflow when loaded content fits', () => {
    expect(
      getCallsignsTableContainerOverflowY({ hasVerticalOverflow: false, showTableOverlay: false }),
    ).toBe('hidden');
  });

  it('keeps vertical container scrolling when loaded content overflows', () => {
    expect(
      getCallsignsTableContainerOverflowY({ hasVerticalOverflow: true, showTableOverlay: false }),
    ).toBe('auto');
  });

  it('hides vertical container overflow while the table overlay is shown', () => {
    expect(
      getCallsignsTableContainerOverflowY({ hasVerticalOverflow: true, showTableOverlay: true }),
    ).toBe('hidden');
  });
});
