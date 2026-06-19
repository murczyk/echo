/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CallsignRowView } from '../types';
import { CallsignsTable } from './CallsignsTable';

vi.mock('@mui/material', () => ({
  Box: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Button: ({ children, onClick, disabled }: { children?: ReactNode; onClick?: () => void; disabled?: boolean }) => (
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
  MaterialReactTable: ({ table }: { table: any }) => <div data-testid="table">{table.renderRowActions?.({ row: { original: table.data[0] } })}</div>,
  useMaterialReactTable: (options: any) => ({
    ...options,
    getState: () => ({ isFullScreen: false }),
  }),
}));

vi.mock('../../../components/MrtRowActionButton', () => ({
  MrtRowActions: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  MrtRowActionButton: (props: { label: string; onClick: () => void; disabled?: boolean; opensModal?: boolean }) => (
    <button type="button" aria-label={props.label} data-opens-modal={props.opensModal ? 'true' : 'false'} disabled={props.disabled} onClick={props.onClick}>
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

function buildRow(): CallsignRowView {
  return {
    id: 1,
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

afterEach(() => {
  document.body.innerHTML = '';
});

describe('CallsignsTable', () => {
  it('marks edit and delete row actions as modal actions', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <CallsignsTable
          canEdit
          rows={[buildRow()]}
          loading={false}
          refreshing={false}
          loadingMore={false}
          showLoadMore={false}
          hasActiveFilters={false}
          textFilters={{ filterCallsign: '', filterPosition: '', filterFullName: '', filterComment: '', filterUnit: '' }}
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

    expect(container.querySelector('[data-opens-modal="true"][aria-label="Редагувати"]')).toBeTruthy();
    expect(container.querySelector('[data-opens-modal="true"][aria-label="Видалити"]')).toBeTruthy();

    root.unmount();
    container.remove();
  });
});
