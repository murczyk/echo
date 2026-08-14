/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CallsignRowView } from '../types';
import { CallsignsTable, getCallsignsTableContainerOverflowY } from './CallsignsTable';

vi.mock('@mui/material', () => ({
  Box: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
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
    <div data-testid="table">{table.renderRowActions?.({ row: { original: table.data[0] } })}</div>
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
    }: {
      items: (props: any) => unknown[];
      renderItem: (item: any) => ReactNode;
    }) =>
    (props: any) => <>{items(props).map(renderItem)}</>,
  useAppMaterialReactTable: (options: Record<string, unknown>) => ({
    ...options,
    options,
    getState: () => ({ isFullScreen: false }),
  }),
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
  } as CallsignRowView;
}

function renderTable(rows: CallsignRowView[]) {
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
        sort={{ column: 'callsign', direction: 'asc' }}
        statusFilter="All"
        onSort={vi.fn()}
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
  document.body.innerHTML = '';
});

describe('CallsignsTable', () => {
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
