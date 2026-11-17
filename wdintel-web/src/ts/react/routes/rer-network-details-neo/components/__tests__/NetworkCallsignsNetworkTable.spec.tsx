/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NetworkCallsignRowView } from '../../network-callsigns.types';

const tableMockState = vi.hoisted(() => ({
  options: null as Record<string, any> | null,
  onColumnOrderChange: vi.fn(),
}));

vi.mock('material-react-table', () => ({
  MaterialReactTable: ({ table }: { table: { options: Record<string, any> } }) => {
    tableMockState.options = table.options;
    return <div data-testid="network-table" />;
  },
}));

vi.mock('../../../../components/mui-customized/table/table-state-provider', () => ({
  TableStateProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useTableStateContext: () => ({
    sorting: [],
    columnOrder: ['mrt-row-numbers', 'mrt-row-actions', 'callsign', 'position'],
    columnSizing: {},
    columnVisibility: {},
    density: 'comfortable',
    enableColumnOrdering: true,
    enableColumnResizing: false,
    onSortingChange: vi.fn(),
    onColumnOrderChange: tableMockState.onColumnOrderChange,
    onColumnSizingChange: vi.fn(),
    onColumnVisibilityChange: vi.fn(),
    onTableInitialized: vi.fn(),
  }),
}));

vi.mock('../../../../components/mui-customized/table/get-default-table-options', () => ({
  mrtCustomCell: (renderer: unknown) => renderer,
  mrtTextCell: ({ displayValue }: { displayValue: unknown }) => displayValue,
  getDefaultMRTOptions: () => ({ localization: {} }),
  useAppMaterialReactTable: (options: Record<string, unknown>) => ({
    options,
    getState: () => ({ isFullScreen: false }),
  }),
  buildDefaultColumnOrder: ({ dataColumnIds }: { dataColumnIds: string[] }) => dataColumnIds,
  renderColumnActionsMenuItems: () => [],
  renderDefaultMrtEmptyRowsFallback: () => null,
}));

vi.mock('../../../../components/mui-customized/table/custom-styles', () => ({
  CUSTOM_STYLES: { muiTablePaperProps: {} },
  FULL_HEIGHT_LOADING_ROW_COUNT: 8,
  FULL_WIDTH_TABLE_PAPER_SX: {},
  getPageScrollTableContainerSx: () => ({}),
}));

vi.mock(
  '../../../../components/mui-customized/table/components/table-top-toolbar/components/internal-actions',
  () => ({
    InternalTableActions: () => null,
  }),
);

vi.mock('../NetworkFreqCallsignPeriodSettings', () => ({
  NetworkFreqCallsignPeriodSettings: () => null,
}));

vi.mock('../../../../components/PowerChip', () => ({
  PowerChip: ({ label }: { label: ReactNode }) => <span>{label}</span>,
}));

import { NetworkCallsignsNetworkTable } from '../NetworkCallsignsNetworkTable';

type TableProps = ComponentProps<typeof NetworkCallsignsNetworkTable>;
type Selection = TableProps['selection'];

let root: Root | null = null;

function createRow(id: number, overrides: Partial<NetworkCallsignRowView> = {}) {
  return {
    id,
    callsign: `СОКІЛ-${id}`,
    fullName: '',
    status: 'catalog',
    statusLabel: 'Каталог',
    position: '',
    unitId: null,
    unitName: '',
    lastDatetime: null,
    messageCount: id,
    comment: '',
    sourceName: '—',
    knownCallsignId: null,
    active: true,
    developing: false,
    mainRadioStation: false,
    unitDeveloping: false,
    sourceId: null,
    radioFreq: null,
    networkId: 42,
    commandControl: false,
    ...overrides,
  } satisfies NetworkCallsignRowView;
}

function createSelection(overrides: Partial<Selection> = {}): Selection {
  return {
    active: false,
    selectedIds: [],
    onSelectedIdsChange: vi.fn(),
    onEnter: vi.fn(),
    onExit: vi.fn(),
    onRequestDelete: vi.fn(),
    deleteInFlight: false,
    ...overrides,
  };
}

function renderTable(overrides: Partial<TableProps> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const props: TableProps = {
    title: 'Позивні мережі',
    rows: [createRow(1), createRow(2, { status: 'developing', developing: true })],
    loading: false,
    loadingError: null,
    canManage: true,
    statusFilter: 'All',
    onStatusFilterChange: vi.fn(),
    period: 'Unlimited',
    periodSettingsDisabled: false,
    onPeriodChange: vi.fn(),
    stats: {
      loading: false,
      available: true,
      period: 'Unlimited',
      error: null,
      exitingRowIds: new Set(),
      unknownRowIds: new Set(),
      onRetry: vi.fn(),
      onLoadAllTime: vi.fn(),
    },
    onOpenEditDrawer: vi.fn(),
    onOpenDeleteDialog: vi.fn(),
    onSetMarkerMode: vi.fn(),
    onReload: vi.fn(),
    inFlightUpdateIds: [],
    inFlightDeleteIds: [],
    selection: createSelection(),
    ...overrides,
  };

  act(() => {
    root?.render(createElement(NetworkCallsignsNetworkTable, props));
  });

  return container;
}

function findButton(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent === label,
  );
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  tableMockState.options = null;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('NetworkCallsignsNetworkTable selection mode', () => {
  it('offers no selection mode without network callsign edit rights', () => {
    const container = renderTable({ canManage: false });

    expect(findButton(container, 'Вибрати')).toBeUndefined();
    expect(tableMockState.options?.enableRowSelection).toBe(false);
  });

  it('enters selection mode from the «Вибрати» button and shows no checkboxes before that', () => {
    const selection = createSelection();
    const container = renderTable({ selection });

    expect(tableMockState.options?.enableRowSelection).toBe(false);
    expect(tableMockState.options?.state.columnOrder).not.toContain('mrt-row-select');

    act(() => findButton(container, 'Вибрати')?.click());
    expect(selection.onEnter).toHaveBeenCalledTimes(1);
  });

  it('shows checkboxes first and maps the selection back to callsign ids', () => {
    const selection = createSelection({ active: true, selectedIds: [1] });
    const container = renderTable({ selection });

    expect(container.textContent).toContain('Обрано: 1');
    expect(tableMockState.options?.state.columnOrder[0]).toBe('mrt-row-select');
    expect(tableMockState.options?.state.rowSelection).toEqual({ '1': true });
    expect(tableMockState.options?.enableRowSelection()).toBe(true);
    expect(tableMockState.options?.enableSelectAll).toBe(true);

    act(() => tableMockState.options?.onRowSelectionChange({ '1': true, '2': true }));
    // Ids follow the displayed order: more messages first.
    expect(selection.onSelectedIdsChange).toHaveBeenLastCalledWith([2, 1]);

    act(() => findButton(container, 'Видалити обрані')?.click());
    expect(selection.onRequestDelete).toHaveBeenCalledTimes(1);
    act(() => findButton(container, 'Скасувати')?.click());
    expect(selection.onExit).toHaveBeenCalledTimes(1);
  });

  it('disables bulk delete with nothing selected and while a delete is running', () => {
    const container = renderTable({ selection: createSelection({ active: true }) });
    expect(findButton(container, 'Видалити обрані')?.disabled).toBe(true);

    act(() => root?.unmount());
    const busyContainer = renderTable({
      selection: createSelection({ active: true, selectedIds: [1], deleteInFlight: true }),
    });
    expect(findButton(busyContainer, 'Видалити обрані')?.disabled).toBe(true);
    expect(tableMockState.options?.enableRowSelection()).toBe(false);
  });

  it('drops selected ids that are no longer visible', () => {
    const selection = createSelection({ active: true, selectedIds: [1, 2, 99] });
    renderTable({ selection, statusFilter: 'Developing' });

    expect(selection.onSelectedIdsChange).toHaveBeenCalledWith([2]);
  });

  it('never stores the transient selection column in the column order', () => {
    renderTable({ selection: createSelection({ active: true }) });

    act(() =>
      tableMockState.options?.onColumnOrderChange([
        'mrt-row-select',
        'mrt-row-numbers',
        'mrt-row-actions',
        'position',
        'callsign',
      ]),
    );

    expect(tableMockState.onColumnOrderChange).toHaveBeenCalledWith([
      'mrt-row-numbers',
      'mrt-row-actions',
      'position',
      'callsign',
    ]);
  });
});
