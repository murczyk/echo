/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AreaOfResponsibility, Network, Unit } from '../../../../Bindings';
import { NETWORK_STATUS_ACTIVE } from '../rer-network-details-neo/network-status';
import {
  FrequencyCell,
  getLocationParts,
  LastActivityCell,
  LocationCell,
} from './components/NetworkCells';
import {
  FREQUENCY_HOVER_POPPER_MODIFIERS,
  FREQUENCY_HOVER_POPPER_PLACEMENT,
  HOVER_POPOVER_CLOSE_DELAY_MS,
  useHoverPopoverState,
} from './components/NetworkHoverPopovers';
import { RerNetworksNeoPage } from './index';
import { NO_AOR_FILTER_VALUE } from './helpers';

const tableStateMock = vi.hoisted(() => ({
  globalFilter: '',
  columnFilters: [],
  sorting: [],
  columnOrder: [
    'mrt-row-numbers',
    'mrt-row-actions',
    'network',
    'aors',
    'freqs',
    'location',
    'activity',
    'lastActivity',
  ],
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

const pageMock = vi.hoisted(() => ({
  useRerNetworksNeoPage: vi.fn(),
}));

const mrtMock = vi.hoisted(() => ({
  useMaterialReactTable: vi.fn(),
  MaterialReactTable: vi.fn(() => null),
  MRT_ToggleFullScreenButton: vi.fn(() =>
    createElement('button', { 'data-testid': 'fullscreen-toggle' }, 'fullscreen'),
  ),
}));

const browserMock = vi.hoisted(() => ({
  navigateWithinSpa: vi.fn(),
}));

let capturedOptions: Record<string, unknown> | null = null;
let capturedToolbarProps: Record<string, unknown> | null = null;
let capturedInternalActionsProps: Record<string, unknown> | null = null;
let capturedTableStateProviderProps: Record<string, unknown> | null = null;
let container: HTMLDivElement | null = null;
let root: Root | null = null;
let defaultPageReturn: Record<string, unknown> | null = null;

function renderNetworkCell(cell: ((props: any) => unknown) | undefined, original: unknown) {
  if (!root || !container) throw new Error('test root is not initialized');
  const element = cell?.({ row: { original } } as never);
  if (!element) throw new Error('network Cell did not return an element');
  act(() => {
    root?.render(element as ReactNode);
  });
  return container;
}

vi.mock('../../components/mui-customized/table/table-state-provider', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../components/mui-customized/table/table-state-provider')
    >();
  return {
    ...actual,
    TableStateProvider: (props: { children: ReactNode }) => {
      capturedTableStateProviderProps = props as Record<string, unknown>;
      return props.children;
    },
    useTableStateContext: () => tableStateMock,
  };
});

vi.mock('@mui/material', async () => {
  const actual = await vi.importActual<typeof import('@mui/material')>('@mui/material');
  return {
    ...actual,
    useMediaQuery: () => true,
  };
});

vi.mock('../../utils/browser', () => ({
  navigateWithinSpa: browserMock.navigateWithinSpa,
  handleNavigateWithinSpaClick: (
    event: {
      defaultPrevented: boolean;
      button: number;
      metaKey: boolean;
      ctrlKey: boolean;
      shiftKey: boolean;
      altKey: boolean;
      preventDefault: () => void;
    },
    href: string,
  ) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    browserMock.navigateWithinSpa(href);
  },
  withBackTo: (path: string) => path,
  windowWidth: () => 0,
}));

vi.mock('../../components/TablePageToolbar', () => ({
  TablePageToolbar: (props: Record<string, unknown>) => {
    capturedToolbarProps = props;
    return createElement('div', null, props.actions as never);
  },
}));

vi.mock(
  '../../components/mui-customized/table/components/table-top-toolbar/components/internal-actions',
  () => ({
    InternalTableActions: (props: Record<string, unknown>) => {
      capturedInternalActionsProps = props;
      return createElement('div', null, props.children as never);
    },
  }),
);

vi.mock('./use-rer-networks-neo-page', () => ({
  useRerNetworksNeoPage: pageMock.useRerNetworksNeoPage,
}));

vi.mock('material-react-table', () => ({
  MaterialReactTable: mrtMock.MaterialReactTable,
  MRT_ToggleFullScreenButton: mrtMock.MRT_ToggleFullScreenButton,
  useMaterialReactTable: (options: Record<string, unknown>) => {
    capturedOptions = options;
    return { options };
  },
}));

function buildNetwork(id: number): Network {
  return {
    id,
    freqs: [],
    unitIds: [],
    aorIds: [],
    name: `Network ${id}`,
    location: `Location ${id}`,
    radioStation: null,
    createdAt: 0,
    purpose: null,
    operationMode: null,
    operationType: null,
    operationPeriod: null,
    doNotArchive: false,
    lastUpdatedAt: 0,
    lastUpdatedBy: 'tester',
    activeFrom: null,
    activeTo: null,
    postIds: [],
    descriptions: [],
    deleted: false,
    status: NETWORK_STATUS_ACTIVE,
  };
}

function buildUnit(id: number, name: string): Unit {
  return { id, name, army: '', division: '', regiment: '', battalion: '' } as Unit;
}

function buildAor(id: number, name: string): AreaOfResponsibility {
  return { id, name } as AreaOfResponsibility;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  capturedOptions = null;
  capturedToolbarProps = null;
  capturedInternalActionsProps = null;
  capturedTableStateProviderProps = null;
  browserMock.navigateWithinSpa.mockReset();
  tableStateMock.globalFilter = '';
  tableStateMock.columnFilters = [];
  tableStateMock.sorting = [];
  tableStateMock.onTableInitialized.mockReset();
  const setReportsMenuAnchorEl = vi.fn((value: unknown) => {
    if (!defaultPageReturn) return;
    const current = defaultPageReturn.reportsMenuAnchorEl as HTMLElement | null;
    defaultPageReturn.reportsMenuAnchorEl =
      typeof value === 'function'
        ? (value as (current: HTMLElement | null) => HTMLElement | null)(current)
        : (value as HTMLElement | null);
  });
  defaultPageReturn = {
    loading: false,
    refreshing: false,
    loadingMore: false,
    noMoreToLoad: true,
    sidebarOpen: false,
    setSidebarOpen: vi.fn(),
    rows: [buildNetwork(1)],
    allRows: [buildNetwork(1)],
    filters: { searchText: '', unitText: '', status: 'all', showOnlyInvestigating: false },
    setFilters: vi.fn(),
    posts: [],
    unitOptions: [buildUnit(1, 'Unit 1')],
    postOptions: [],
    encryptions: [{ id: 11, label: 'FM' }],
    unitStatsView: [],
    selectedSidebarUnitFilter: null,
    onPickUnitFilter: vi.fn(),
    onToggleInvestigating: vi.fn(),
    onClearUnitFilter: vi.fn(),
    onClearInvestigatingFilter: vi.fn(),
    openReportDialog: vi.fn(),
    openTopReportDialog: vi.fn(),
    closeReportDialog: vi.fn(),
    downloadEtalonkaReport: vi.fn(),
    reportTargetRequest: null,
    reportTargetNetworkIds: null,
    etalonkaReport: {
      dialogOpen: false,
      taskRunId: 0,
      taskId: null,
      startedAtMs: null,
      running: false,
      curr: 0,
      overall: 4,
      logs: [],
      error: null,
      reportType: 'AccordingToTheForm',
      activeFreqsOnly: true,
      includeFreqActiveFrom: false,
      includeFreqCreatedAt: true,
      includeCallsignFullNames: false,
      includeSigintSigns: true,
      includeConfirmation: true,
      includeUnitCallsigns: true,
      includePelengsMap: true,
      fromDateTimeStr: '',
      toDateTimeStr: '',
      downloadFileName: null,
      finishedAt: null,
      progressExpanded: false,
    },
    setEtalonkaReport: vi.fn(),
    status: null,
    setStatus: vi.fn(),
    statusCounts: null,
    aorOptions: [buildAor(1, 'AOR 1')],
    permissions: { canEdit: true, canExport: true, canDelete: true },
    reportsMenuAnchorEl: null,
    setReportsMenuAnchorEl,
    rowMenuAnchorEl: null,
    rowMenuNetworkId: null,
    setRowMenuAnchorEl: vi.fn(),
    setRowMenuNetworkId: vi.fn(),
    downloadInFlight: null,
    supportNonRerInterceptions: false,
    runDownload: vi.fn(),
    loadMoreNetworks: vi.fn(),
    createDialog: null,
    createSubmitting: false,
    createError: null,
    openCreateDialog: vi.fn(),
    closeCreateDialog: vi.fn(),
    setCreateDialog: vi.fn(),
    saveNetworkCreate: vi.fn(),
    editDialog: null,
    editSubmitting: false,
    editError: null,
    openEditDialog: vi.fn(),
    closeEditDialog: vi.fn(),
    setEditDialog: vi.fn(),
    saveNetworkEdit: vi.fn(),
    deleteDialogNetwork: null,
    deleteSubmitting: false,
    openDeleteDialog: vi.fn(),
    closeDeleteDialog: vi.fn(),
    confirmDeleteNetwork: vi.fn(),
    setNetworks: vi.fn(),
  };
  pageMock.useRerNetworksNeoPage.mockReturnValue(defaultPageReturn);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

it('keeps MRT filter modes disabled on the networks table', () => {
  if (!container) throw new Error('container not initialized');

  root = createRoot(container);
  act(() => {
    root?.render(createElement(RerNetworksNeoPage));
  });

  expect(capturedOptions).not.toBeNull();
  expect(capturedToolbarProps).not.toBeNull();
  expect(capturedToolbarProps?.internalActionsHidden).toBe(true);
  expect(container?.textContent).toContain('Створити мережу');
  expect(container?.textContent).toContain('Звіти');
  expect(container?.textContent).toContain('Активні');
  expect(container?.textContent).toContain('Неактивні');
  expect(container?.textContent).toContain('Архівні');
  expect(capturedOptions?.enableColumnFilterModes).toBe(false);
  expect(capturedOptions?.columnFilterDisplayMode).toBe('popover');
  expect(capturedOptions?.enableColumnOrdering).toBe(true);
  expect(capturedOptions?.enableColumnResizing).toBe(true);
  expect(
    (capturedOptions?.muiTableHeadCellProps as { sx?: Record<string, unknown> } | undefined)?.sx,
  ).toEqual(
    expect.objectContaining({
      backgroundColor: 'var(--bs-body-bg)',
      '& .Mui-TableHeadCell-ResizeHandle-Wrapper': expect.objectContaining({
        mr: '-8px',
      }),
    }),
  );
  expect(
    (capturedOptions?.initialState as { columnOrder?: string[] } | undefined)?.columnOrder,
  ).toEqual([
    'mrt-row-numbers',
    'mrt-row-actions',
    'network',
    'aors',
    'freqs',
    'location',
    'activity',
    'lastActivity',
  ]);
  expect(
    (
      capturedOptions?.columns as Array<{
        id?: string;
        filterSelectOptions?: Array<{ label?: string; value?: string; text?: string }>;
      }>
    ).find((column) => column.id === 'aors')?.filterSelectOptions,
  ).toEqual([
    { label: '—', value: '__no_aor__' },
    { label: 'AOR 1', value: '1' },
  ]);
  const columnsById = new Map(
    (
      capturedOptions?.columns as Array<{
        id?: string;
        enableColumnFilter?: boolean;
        enableSorting?: boolean;
      }>
    ).map((column) => [column.id, column]),
  );
  expect(columnsById.get('network')).toEqual(
    expect.objectContaining({ enableColumnFilter: true, enableSorting: true }),
  );
  expect(columnsById.get('aors')).toEqual(
    expect.objectContaining({ enableColumnFilter: true, enableSorting: true }),
  );
  expect(
    (columnsById.get('aors') as { meta?: { activeFilterValueFormatter?: unknown } } | undefined)
      ?.meta?.activeFilterValueFormatter,
  ).toEqual(expect.any(Function));
  expect(columnsById.get('freqs')).toEqual(
    expect.objectContaining({ enableColumnFilter: true, enableSorting: true }),
  );
  expect(columnsById.get('location')).toEqual(
    expect.objectContaining({ enableColumnFilter: true, enableSorting: true }),
  );
  expect(columnsById.get('activity')).toEqual(
    expect.objectContaining({ enableColumnFilter: false, enableSorting: false }),
  );
  expect(columnsById.get('lastActivity')).toEqual(
    expect.objectContaining({ enableColumnFilter: false, enableSorting: true }),
  );
  expect((capturedOptions?.state as Record<string, unknown> | undefined)?.columnOrder).toEqual(
    tableStateMock.columnOrder,
  );
  expect((capturedOptions?.state as Record<string, unknown> | undefined)?.columnSizing).toEqual(
    tableStateMock.columnSizing,
  );
  expect((capturedOptions?.state as Record<string, unknown> | undefined)?.columnVisibility).toEqual(
    tableStateMock.columnVisibility,
  );
  expect(container?.querySelector('[data-testid="fullscreen-toggle"]')).toBeNull();
  const displayOptions = capturedOptions?.displayColumnDefOptions as
    Record<string, { enableResizing?: boolean; size?: number }> | undefined;
  expect(displayOptions?.['mrt-row-numbers']?.enableResizing).toBe(false);
  expect(displayOptions?.['mrt-row-actions']?.enableResizing).toBe(false);
  expect(displayOptions?.['mrt-row-actions']?.size).toBeGreaterThan(0);
  expect(
    (capturedOptions?.muiTableHeadCellProps as { sx?: Record<string, unknown> } | undefined)?.sx,
  ).toEqual(
    expect.objectContaining({
      '& .Mui-TableHeadCell-ResizeHandle-Wrapper': expect.objectContaining({
        mr: '-8px',
      }),
      backgroundColor: 'var(--bs-body-bg)',
    }),
  );
  const networkCell = (
    capturedOptions?.columns as Array<{ id?: string; Cell?: (props: any) => unknown }>
  ).find((column) => column.id === 'network');
  const renderedNetworkCell = renderNetworkCell(networkCell?.Cell, {
    id: 42,
    network: { name: 'Network 1' },
    networkLabel: 'р/м Network 1 1 АК',
    unitLabels: ['1 АК'],
    developing: true,
    statusLabel: 'Активна',
    statusColor: '#54c06c',
    statusKey: 'active',
    aorLabels: [],
    activeFrequencies: [],
    inactiveFrequencies: [],
    activityBars: [],
    lastActivityLabel: '—',
    lastActivityDetail: 'невідомий',
    lastActivityTooltip: '—',
    createdAtLabel: '—',
  });
  const networkAnchor = renderedNetworkCell.querySelector<HTMLAnchorElement>(
    'a[href="/rer-networks-neo/42"]',
  );
  expect(networkAnchor).not.toBeNull();
  expect(networkAnchor?.title).toBe('р/м Network 1 1 АК');
  expect(networkAnchor?.getAttribute('aria-label')).toBe('р/м Network 1 1 АК');
  expect(networkAnchor?.title).not.toContain('в дорозвідці');
  expect(networkAnchor?.getAttribute('target')).toBeNull();
  expect(networkAnchor?.getAttribute('rel')).toBeNull();
  expect(renderedNetworkCell.textContent).toContain('В дорозвідці');
  const preventDefault = vi.fn();
  const click = new MouseEvent('click', { bubbles: true, button: 0 });
  Object.defineProperty(click, 'preventDefault', { value: preventDefault });
  act(() => {
    networkAnchor?.dispatchEvent(click);
  });
  expect(preventDefault).toHaveBeenCalledTimes(1);
  expect(browserMock.navigateWithinSpa).toHaveBeenCalledWith('/rer-networks-neo/42');
  expect(networkAnchor?.textContent).toBe('р/м Network 1 1 АК');
  expect(capturedTableStateProviderProps?.defaultSorting).toEqual([{ id: 'network', desc: false }]);
});

it('wraps long network labels without truncating the status chip row', () => {
  if (!container) throw new Error('container not initialized');

  root = createRoot(container);
  act(() => {
    root?.render(createElement(RerNetworksNeoPage));
  });

  const networkCell = (
    capturedOptions?.columns as Array<{ id?: string; Cell?: (props: any) => unknown }>
  ).find((column) => column.id === 'network');
  const renderedNetworkCell = renderNetworkCell(networkCell?.Cell, {
    id: 42,
    network: { name: 'Network 1' },
    networkLabel: 'р/м Network 1 з дуже довгою назвою для переносу',
    unitLabels: ['1 АК'],
    developing: true,
    statusLabel: 'Активна',
    statusColor: '#54c06c',
    statusKey: 'active',
    aorLabels: [],
    activeFrequencies: [],
    inactiveFrequencies: [],
    activityBars: [],
    lastActivityLabel: '—',
    lastActivityDetail: 'невідомий',
    lastActivityTooltip: '—',
    createdAtLabel: '—',
  });

  const networkAnchor = renderedNetworkCell.querySelector<HTMLAnchorElement>(
    'a[href="/rer-networks-neo/42"]',
  );
  expect(networkAnchor?.textContent).toBe('р/м Network 1 з дуже довгою назвою для переносу');
  expect(networkAnchor?.title).toBe('р/м Network 1 з дуже довгою назвою для переносу');
  const networkCellsSource = readFileSync(
    'src/ts/react/routes/rer-networks-neo/components/NetworkCells.tsx',
    'utf8',
  );
  expect(networkCellsSource).toContain('alignItems="flex-start"');
  expect(networkCellsSource).toContain("alignSelf: 'center'");
  expect(networkCellsSource).toContain("whiteSpace: 'normal'");
  expect(networkCellsSource).toContain("overflowWrap: 'anywhere'");
  const source = readFileSync('src/ts/react/routes/rer-networks-neo/index.spec.tsx', 'utf8');
  expect(source).not.toContain(['displayValue', '.type('].join(''));
  expect(source).not.toMatch(new RegExp(['row', 'Label.*\\.type'].join('')));
});

it('refreshes AOR filter options after lookup data loads', () => {
  if (!container) throw new Error('container not initialized');
  if (defaultPageReturn === null) throw new Error('default page mock not initialized');

  defaultPageReturn.aorOptions = [];
  root = createRoot(container);
  act(() => {
    root?.render(createElement(RerNetworksNeoPage));
  });

  expect(
    (
      capturedOptions?.columns as Array<{
        id?: string;
        filterSelectOptions?: Array<{ label?: string; value?: string }>;
      }>
    ).find((column) => column.id === 'aors')?.filterSelectOptions,
  ).toEqual([{ label: '—', value: '__no_aor__' }]);

  defaultPageReturn.aorOptions = [
    buildAor(2, 'Бета'),
    buildAor(3, 'Вся смуга'),
    buildAor(1, 'Альфа'),
  ];
  act(() => {
    root?.render(createElement(RerNetworksNeoPage));
  });

  expect(
    (
      capturedOptions?.columns as Array<{
        id?: string;
        filterSelectOptions?: Array<{ label?: string; value?: string }>;
      }>
    ).find((column) => column.id === 'aors')?.filterSelectOptions,
  ).toEqual([
    { label: '—', value: '__no_aor__' },
    { label: 'Вся смуга', value: '3' },
    { label: 'Альфа', value: '1' },
    { label: 'Бета', value: '2' },
  ]);
});

it('does not duplicate the AOR column filter in the active filter list', () => {
  if (!container) throw new Error('container not initialized');
  if (defaultPageReturn === null) throw new Error('default page mock not initialized');

  tableStateMock.columnFilters = [{ id: 'aors', value: ['6'] }];
  tableStateMock.globalFilter = 'alpha';
  defaultPageReturn.aorOptions = [buildAor(6, '14 АК')];
  defaultPageReturn.filters = {
    ...defaultPageReturn.filters,
    status: 'active',
    unitText: '3 АК',
    showOnlyInvestigating: true,
  };

  root = createRoot(container);
  act(() => {
    root?.render(createElement(RerNetworksNeoPage));
  });

  const aorsColumn = (
    capturedOptions?.columns as Array<{
      id?: string;
      meta?: { activeFilterValueFormatter?: (value: unknown) => string };
    }>
  ).find((column) => column.id === 'aors');
  expect(aorsColumn?.meta?.activeFilterValueFormatter?.(['6'])).toBe('14 АК');
  expect(aorsColumn?.meta?.activeFilterValueFormatter?.(['6', NO_AOR_FILTER_VALUE])).toBe(
    '14 АК, —',
  );
  expect(aorsColumn?.meta?.activeFilterValueFormatter?.(['999'])).toBe('#999');
  expect(capturedInternalActionsProps?.additionalActiveFilters).toEqual([
    expect.objectContaining({ id: 'page-unit', label: 'Підрозділ' }),
    expect.objectContaining({ id: 'page-investigating', label: 'Статус', value: 'В дорозвідці' }),
    expect.objectContaining({ id: 'page-status', label: 'Статус' }),
  ]);
  expect(
    (
      capturedInternalActionsProps?.additionalActiveFilters as Array<{ id: string }> | undefined
    )?.some((filter) => filter.id === '__global_filter__'),
  ).toBe(false);
  expect(
    (
      capturedInternalActionsProps?.additionalActiveFilters as Array<{ id: string }> | undefined
    )?.some((filter) => filter.id === 'aors'),
  ).toBe(false);

  act(() => {
    (
      capturedInternalActionsProps?.onClearAdditionalActiveFilter as
        ((filterId: string) => void) | undefined
    )?.('page-investigating');
  });
  expect(defaultPageReturn.onClearInvestigatingFilter).toHaveBeenCalled();

  act(() => {
    (capturedInternalActionsProps?.onClearAdditionalActiveFilters as (() => void) | undefined)?.();
  });
  expect(defaultPageReturn.onClearUnitFilter).toHaveBeenCalled();
  expect(defaultPageReturn.onClearInvestigatingFilter).toHaveBeenCalledTimes(2);
  expect(defaultPageReturn.setFilters).toHaveBeenCalledWith(expect.any(Function));
});

it('uses skeleton rows only for the initial load state', () => {
  if (!container) throw new Error('container not initialized');
  if (defaultPageReturn === null) throw new Error('default page mock not initialized');

  pageMock.useRerNetworksNeoPage.mockReturnValueOnce({
    ...defaultPageReturn,
    loading: false,
    refreshing: true,
    loadingMore: false,
  });

  root = createRoot(container);
  act(() => {
    root?.render(createElement(RerNetworksNeoPage));
  });

  expect((capturedOptions?.state as Record<string, unknown> | undefined)?.showSkeletons).toBe(
    false,
  );
  expect((capturedOptions?.state as Record<string, unknown> | undefined)?.showProgressBars).toBe(
    false,
  );
});

it('keeps the empty-result table from adding a second vertical scrollbar', () => {
  if (!container) throw new Error('container not initialized');
  if (defaultPageReturn === null) throw new Error('default page mock not initialized');

  pageMock.useRerNetworksNeoPage.mockReturnValueOnce({
    ...defaultPageReturn,
    rows: [],
    allRows: [],
    noMoreToLoad: true,
  });

  root = createRoot(container);
  act(() => {
    root?.render(createElement(RerNetworksNeoPage));
  });

  const paperProps =
    typeof capturedOptions?.muiTablePaperProps === 'function'
      ? (
          capturedOptions.muiTablePaperProps as (args: {
            table: { getState: () => { isFullScreen: boolean } };
          }) => { sx?: Record<string, unknown> }
        )({
          table: {
            getState: () => ({ isFullScreen: false }),
          },
        })
      : (capturedOptions?.muiTablePaperProps as { sx?: Record<string, unknown> } | undefined);

  expect(paperProps?.sx).toEqual(
    expect.objectContaining({
      height: '100%',
      minHeight: '100%',
      overflow: 'hidden',
    }),
  );
  expect(
    (capturedOptions?.muiTableContainerProps as { sx?: Record<string, unknown> } | undefined)?.sx,
  ).toEqual(
    expect.objectContaining({
      minHeight: '100%',
      overflowY: 'hidden',
      overflow: 'hidden',
    }),
  );
  expect(
    (capturedOptions?.muiTableBodyProps as { sx?: Record<string, unknown> } | undefined)?.sx,
  ).toEqual(
    expect.objectContaining({
      minHeight: '100%',
    }),
  );
});

it('hides load more and expands the first-load frame to full height', () => {
  if (!container) throw new Error('container not initialized');
  if (defaultPageReturn === null) throw new Error('default page mock not initialized');

  pageMock.useRerNetworksNeoPage.mockReturnValueOnce({
    ...defaultPageReturn,
    loading: true,
    refreshing: false,
    loadingMore: false,
    rows: [],
    noMoreToLoad: false,
  });

  root = createRoot(container);
  act(() => {
    root?.render(createElement(RerNetworksNeoPage));
  });

  expect(container.textContent).not.toContain('Завантажити ще');
  expect((capturedOptions?.state as Record<string, unknown> | undefined)?.showSkeletons).toBe(true);
  expect((capturedOptions?.state as Record<string, unknown> | undefined)?.showLoadingOverlay).toBe(
    false,
  );
  expect(
    (capturedOptions?.initialState as Record<string, unknown> | undefined)?.pagination,
  ).toEqual({
    pageIndex: 0,
    pageSize: 24,
  });
  expect(
    (
      capturedOptions?.muiTablePaperProps as (args: {
        table: { getState: () => { isFullScreen: boolean } };
      }) => { sx?: Record<string, unknown> } | undefined
    )?.({
      table: { getState: () => ({ isFullScreen: false }) },
    })?.sx,
  ).toEqual(
    expect.objectContaining({
      height: '100%',
      minHeight: '100%',
    }),
  );
  expect(
    (capturedOptions?.muiTableContainerProps as { sx?: Record<string, unknown> } | undefined)?.sx,
  ).toEqual(
    expect.objectContaining({
      minHeight: '100%',
      overflowX: 'auto',
      overflowY: 'auto',
    }),
  );
  expect((capturedOptions?.state as Record<string, unknown> | undefined)?.showProgressBars).toBe(
    false,
  );
});

it('splits location text into visible lines', () => {
  expect(getLocationParts('Пункт зв’язку, Місто, Район')).toEqual([
    'Пункт зв’язку',
    'Місто',
    'Район',
  ]);
});

it('keeps frequency disclosure owned by the domain hover surface', () => {
  const onEnter = vi.fn();
  const onLeave = vi.fn();
  const row = {
    activeFrequencies: [{ id: 1, freq: '123.45' }],
    inactiveFrequencies: [],
  } as any;
  const frequencyContainer = document.createElement('div');
  document.body.appendChild(frequencyContainer);
  const frequencyRoot = createRoot(frequencyContainer);
  act(() => {
    frequencyRoot.render(
      createElement(FrequencyCell, {
        row,
        onPointerEnterAnchor: onEnter,
        onPointerLeaveAnchor: onLeave,
      }),
    );
  });
  const anchor = frequencyContainer.querySelector<HTMLElement>(
    '[data-network-hover-anchor="true"]',
  );
  act(() => anchor?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })));
  expect(onEnter).toHaveBeenCalledWith(anchor, row);
  act(() => anchor?.dispatchEvent(new PointerEvent('pointerout', { bubbles: true })));
  expect(onLeave).toHaveBeenCalledTimes(1);
  expect(frequencyContainer.querySelector('[role="tooltip"]')).toBeNull();
  act(() => frequencyRoot.unmount());
  frequencyContainer.remove();

  const empty = document.createElement('div');
  document.body.appendChild(empty);
  const emptyRoot = createRoot(empty);
  act(() => {
    emptyRoot.render(
      createElement(FrequencyCell, {
        row: { ...row, activeFrequencies: [] },
        onPointerEnterAnchor: onEnter,
        onPointerLeaveAnchor: onLeave,
      }),
    );
  });
  act(() =>
    empty.firstElementChild?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })),
  );
  expect(onEnter).toHaveBeenCalledTimes(1);
  act(() => emptyRoot.unmount());
  empty.remove();
});

it('keeps frequency previews bounded while disclosing each active and inactive remainder', () => {
  const onEnter = vi.fn();
  const row = {
    activeFrequencies: [
      { id: 1, freq: '111.11' },
      { id: 2, freq: '222.22' },
      { id: 3, freq: '333.33' },
    ],
    inactiveFrequencies: [
      { id: 4, freq: '444.44' },
      { id: 5, freq: '555.55' },
      { id: 6, freq: '666.66' },
    ],
  } as any;
  const frequencyContainer = document.createElement('div');
  document.body.appendChild(frequencyContainer);
  const frequencyRoot = createRoot(frequencyContainer);
  act(() => {
    frequencyRoot.render(
      createElement(FrequencyCell, {
        row,
        onPointerEnterAnchor: onEnter,
        onPointerLeaveAnchor: vi.fn(),
      }),
    );
  });

  expect(frequencyContainer.textContent).toContain('111.11');
  expect(frequencyContainer.textContent).toContain('222.22');
  expect(frequencyContainer.textContent).toContain('444.44');
  expect(frequencyContainer.textContent).toContain('555.55');
  expect(frequencyContainer.textContent).not.toContain('333.33');
  expect(frequencyContainer.textContent).not.toContain('666.66');
  expect(frequencyContainer.textContent).toBe('111.11222.22+1444.44555.55+1');
  const anchor = frequencyContainer.querySelector<HTMLElement>(
    '[data-network-hover-anchor="true"]',
  );
  act(() => anchor?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })));
  expect(onEnter).toHaveBeenCalledWith(anchor, row);
  act(() => frequencyRoot.unmount());
  frequencyContainer.remove();
});

it('keeps location previews bounded and enables domain hover only when values are hidden', () => {
  const onEnter = vi.fn();
  const onLeave = vi.fn();
  const row = {
    network: { location: 'Пункт зв’язку, Місто\nРайон, Область' },
  } as any;
  const locationContainer = document.createElement('div');
  document.body.appendChild(locationContainer);
  const locationRoot = createRoot(locationContainer);
  act(() => {
    locationRoot.render(
      createElement(LocationCell, {
        row,
        onPointerEnterAnchor: onEnter,
        onPointerLeaveAnchor: onLeave,
      }),
    );
  });
  const anchor = locationContainer.querySelector<HTMLElement>('[data-network-hover-anchor="true"]');
  expect(locationContainer.textContent).toContain('Пункт зв’язку');
  expect(locationContainer.textContent).toContain('Місто');
  expect(locationContainer.textContent).toContain('+2');
  expect(locationContainer.textContent).not.toContain('Район');
  expect(locationContainer.textContent).not.toContain('Область');
  act(() => anchor?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })));
  expect(onEnter).toHaveBeenCalledWith(anchor, row);
  act(() => anchor?.dispatchEvent(new PointerEvent('pointerout', { bubbles: true })));
  expect(onLeave).toHaveBeenCalledTimes(1);
  act(() => locationRoot.unmount());
  locationContainer.remove();

  const shortLocation = document.createElement('div');
  document.body.appendChild(shortLocation);
  const shortLocationRoot = createRoot(shortLocation);
  act(() => {
    shortLocationRoot.render(
      createElement(LocationCell, {
        row: { network: { location: 'Пункт зв’язку, Місто' } } as any,
        onPointerEnterAnchor: onEnter,
        onPointerLeaveAnchor: onLeave,
      }),
    );
  });
  expect(shortLocation.querySelector('[data-network-hover-anchor="true"]')).toBeNull();
  act(() =>
    shortLocation.firstElementChild?.dispatchEvent(
      new PointerEvent('pointerover', { bubbles: true }),
    ),
  );
  expect(onEnter).toHaveBeenCalledTimes(1);
  act(() => shortLocationRoot.unmount());
  shortLocation.remove();
});

it('keeps structured last activity visible and available through hover and focus', async () => {
  vi.useFakeTimers();
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const activityContainer = document.createElement('div');
  document.body.appendChild(activityContainer);
  const activityRoot = createRoot(activityContainer);
  let activityUnmounted = false;
  const tooltip = 'Створено: 01.01.2026\nОновлено: 02.01.2026\nАвтор: Оператор';
  try {
    act(() => {
      activityRoot.render(
        createElement(LastActivityCell, {
          label: '02.01.2026 14:30',
          detail: 'Оператор',
          tooltip,
        }),
      );
    });
    const activity = activityContainer.querySelector<HTMLElement>('[tabindex="0"]');
    expect(activity).not.toBeNull();
    expect(activityContainer.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    expect(activity?.textContent).toContain('02.01.2026 14:30');
    expect(activity?.textContent).toContain('Оператор');
    const lines = activity?.querySelectorAll<HTMLElement>(':scope > div');
    expect(lines).toHaveLength(2);
    for (const line of lines ?? []) {
      expect(getComputedStyle(line).overflow).toBe('hidden');
      expect(getComputedStyle(line).textOverflow).toBe('ellipsis');
      expect(getComputedStyle(line).whiteSpace).toBe('nowrap');
    }

    act(() => activity?.focus());
    await act(async () => vi.runAllTimers());
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(tooltip);
    act(() => activity?.blur());
    await act(async () => vi.runAllTimers());
    expect(
      document.body.querySelector('[role="tooltip"]')?.classList.contains('MuiTooltip-popperOpen'),
    ).toBe(false);

    act(() => activity?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    await act(async () => vi.runAllTimers());
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(tooltip);
    act(() => activity?.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true })));
    await act(async () => vi.runAllTimers());
    expect(
      document.body.querySelector('[role="tooltip"]')?.classList.contains('MuiTooltip-popperOpen'),
    ).toBe(false);

    act(() => activityRoot.unmount());
    activityContainer.remove();
    activityUnmounted = true;

    root = createRoot(container!);
    act(() => {
      root?.render(createElement(RerNetworksNeoPage));
    });
    const lastActivityCell = (
      capturedOptions?.columns as Array<{ id?: string; Cell?: (props: any) => unknown }>
    ).find((column) => column.id === 'lastActivity');
    const renderedCell = renderNetworkCell(lastActivityCell?.Cell, {
      lastActivityLabel: '02.01.2026 14:30',
      lastActivityDetail: 'Оператор',
      lastActivityTooltip: tooltip,
    });
    const renderedActivity = renderedCell.querySelector<HTMLElement>('[tabindex="0"]');
    expect(renderedActivity?.textContent).toContain('02.01.2026 14:30');
    expect(renderedActivity?.textContent).toContain('Оператор');
    act(() => renderedActivity?.focus());
    await act(async () => vi.runAllTimers());
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(tooltip);
  } finally {
    if (!activityUnmounted) {
      act(() => activityRoot.unmount());
      activityContainer.remove();
    }
    const errors = consoleError.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
    consoleError.mockRestore();
    vi.useRealTimers();
    expect(errors).not.toMatch(/warning|error|invalid prop|aria/i);
  }
});

it('uses top-first placement for the frequency hover popper', () => {
  expect(FREQUENCY_HOVER_POPPER_PLACEMENT).toBe('top-start');
  expect(FREQUENCY_HOVER_POPPER_MODIFIERS).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'flip' }),
      expect.objectContaining({ name: 'preventOverflow' }),
    ]),
  );
});

describe('useHoverPopoverState', () => {
  it('replaces the hovered popover when moving from location to frequency', () => {
    let latest: ReturnType<typeof useHoverPopoverState> | null = null;

    function Harness() {
      latest = useHoverPopoverState();
      return null;
    }

    const harnessContainer = document.createElement('div');
    document.body.appendChild(harnessContainer);
    const harnessRoot = createRoot(harnessContainer);
    const anchor = document.createElement('div');
    const row = buildNetwork(1) as never;

    act(() => {
      harnessRoot.render(createElement(Harness));
    });

    act(() => {
      latest?.onHoverLocationPointerEnter(anchor, row);
    });
    expect(latest?.hoverPopover?.kind).toBe('location');

    act(() => {
      latest?.onHoverAnchorPointerEnter(anchor, row);
    });
    expect(latest?.hoverPopover?.kind).toBe('freq');

    act(() => {
      latest?.closeHoverPopover();
    });
    expect(latest?.hoverPopover).toBeNull();

    act(() => {
      harnessRoot.unmount();
    });
    harnessContainer.remove();
  });

  it('keeps the hover popover open when moving from anchor to popper', () => {
    vi.useFakeTimers();
    let latest: ReturnType<typeof useHoverPopoverState> | null = null;

    function Harness() {
      latest = useHoverPopoverState();
      return null;
    }

    const harnessContainer = document.createElement('div');
    document.body.appendChild(harnessContainer);
    const harnessRoot = createRoot(harnessContainer);
    const anchor = document.createElement('div');
    const row = buildNetwork(1) as never;

    act(() => {
      harnessRoot.render(createElement(Harness));
    });

    act(() => {
      latest?.onHoverAnchorPointerEnter(anchor, row);
    });
    expect(latest?.hoverPopover?.kind).toBe('freq');

    act(() => {
      latest?.onHoverAnchorPointerLeave();
    });
    act(() => {
      vi.advanceTimersByTime(HOVER_POPOVER_CLOSE_DELAY_MS - 1);
    });
    expect(latest?.hoverPopover?.kind).toBe('freq');

    act(() => {
      latest?.onHoverPopperPointerEnter();
    });
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(latest?.hoverPopover?.kind).toBe('freq');

    act(() => {
      latest?.onHoverPopperPointerLeave();
    });
    act(() => {
      vi.advanceTimersByTime(HOVER_POPOVER_CLOSE_DELAY_MS);
    });
    expect(latest?.hoverPopover).toBeNull();

    act(() => {
      harnessRoot.unmount();
    });
    harnessContainer.remove();
    vi.useRealTimers();
  });

  it('keeps the hover popover open when scrolling inside the popper and closes on outside scroll', () => {
    let latest: ReturnType<typeof useHoverPopoverState> | null = null;

    function Harness() {
      latest = useHoverPopoverState();
      return null;
    }

    const harnessContainer = document.createElement('div');
    document.body.appendChild(harnessContainer);
    const harnessRoot = createRoot(harnessContainer);
    const anchor = document.createElement('div');
    const row = buildNetwork(1) as never;
    const popper = document.createElement('div');
    popper.setAttribute('data-network-hover-popper', 'true');
    const popperScrollTarget = document.createElement('div');
    popper.appendChild(popperScrollTarget);
    document.body.appendChild(popper);
    const outsideScrollTarget = document.createElement('div');
    document.body.appendChild(outsideScrollTarget);

    act(() => {
      harnessRoot.render(createElement(Harness));
    });

    act(() => {
      latest?.onHoverAnchorPointerEnter(anchor, row);
    });
    expect(latest?.hoverPopover?.kind).toBe('freq');

    act(() => {
      popperScrollTarget.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(latest?.hoverPopover?.kind).toBe('freq');

    act(() => {
      outsideScrollTarget.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(latest?.hoverPopover).toBeNull();

    act(() => {
      harnessRoot.unmount();
    });
    harnessContainer.remove();
    popper.remove();
    outsideScrollTarget.remove();
  });

  it('delays closing on outside pointer move and cancels when entering the popper', () => {
    vi.useFakeTimers();
    let latest: ReturnType<typeof useHoverPopoverState> | null = null;

    function Harness() {
      latest = useHoverPopoverState();
      return null;
    }

    const harnessContainer = document.createElement('div');
    document.body.appendChild(harnessContainer);
    const harnessRoot = createRoot(harnessContainer);
    const anchor = document.createElement('div');
    const row = buildNetwork(1) as never;

    act(() => {
      harnessRoot.render(createElement(Harness));
    });

    act(() => {
      latest?.onHoverAnchorPointerEnter(anchor, row);
    });
    expect(latest?.hoverPopover?.kind).toBe('freq');

    act(() => {
      latest?.onHoverOutsidePointerMove();
    });
    act(() => {
      vi.advanceTimersByTime(HOVER_POPOVER_CLOSE_DELAY_MS - 1);
    });
    expect(latest?.hoverPopover?.kind).toBe('freq');

    act(() => {
      latest?.onHoverPopperPointerEnter();
    });
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(latest?.hoverPopover?.kind).toBe('freq');

    act(() => {
      latest?.onHoverPopperPointerLeave();
    });
    act(() => {
      vi.advanceTimersByTime(HOVER_POPOVER_CLOSE_DELAY_MS);
    });
    expect(latest?.hoverPopover).toBeNull();

    act(() => {
      harnessRoot.unmount();
    });
    harnessContainer.remove();
    vi.useRealTimers();
  });

  it('closes after the outside pointer move delay when the popper is not entered', () => {
    vi.useFakeTimers();
    let latest: ReturnType<typeof useHoverPopoverState> | null = null;

    function Harness() {
      latest = useHoverPopoverState();
      return null;
    }

    const harnessContainer = document.createElement('div');
    document.body.appendChild(harnessContainer);
    const harnessRoot = createRoot(harnessContainer);
    const anchor = document.createElement('div');
    const row = buildNetwork(1) as never;

    act(() => {
      harnessRoot.render(createElement(Harness));
    });

    act(() => {
      latest?.onHoverAnchorPointerEnter(anchor, row);
    });
    expect(latest?.hoverPopover?.kind).toBe('freq');

    act(() => {
      latest?.onHoverOutsidePointerMove();
    });
    act(() => {
      vi.advanceTimersByTime(HOVER_POPOVER_CLOSE_DELAY_MS);
    });
    expect(latest?.hoverPopover).toBeNull();

    act(() => {
      harnessRoot.unmount();
    });
    harnessContainer.remove();
    vi.useRealTimers();
  });
});

it('toggles and closes the reports menu', () => {
  if (!container) throw new Error('container not initialized');

  root = createRoot(container);
  act(() => {
    root?.render(createElement(RerNetworksNeoPage));
  });

  const reportsButton = Array.from(container.querySelectorAll('button')).find((button) =>
    button.textContent?.includes('Звіти'),
  );
  if (!reportsButton) throw new Error('reports button not found');

  act(() => {
    reportsButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    root?.render(createElement(RerNetworksNeoPage));
  });
  expect(document.body.textContent).toContain('Еталонний опис');
  expect(document.body.textContent).toContain('ГОІ');

  act(() => {
    reportsButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    root?.render(createElement(RerNetworksNeoPage));
  });
  expect(document.body.textContent).not.toContain('Еталонний опис');

  act(() => {
    reportsButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    root?.render(createElement(RerNetworksNeoPage));
  });
  expect(document.body.textContent).toContain('Еталонний опис');

  act(() => {
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    root?.render(createElement(RerNetworksNeoPage));
  });
  expect(document.body.textContent).not.toContain('Еталонний опис');
});
