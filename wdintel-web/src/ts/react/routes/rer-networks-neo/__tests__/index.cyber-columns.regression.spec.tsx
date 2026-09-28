/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AreaOfResponsibility, Network, Unit } from '../../../../../Bindings';
import { NETWORK_STATUS_ACTIVE } from '../../rer-network-details-neo/network-status';
import {
  FrequencyCell,
  getLocationParts,
  LastActivityCell,
  LocationCell,
  NetworkActivityCell,
} from '../components/NetworkCells';
import {
  FREQUENCY_HOVER_POPPER_MODIFIERS,
  FREQUENCY_HOVER_POPPER_PLACEMENT,
  HOVER_POPOVER_CLOSE_DELAY_MS,
  useHoverPopoverState,
} from '../components/NetworkHoverPopovers';
import { RerNetworksNeoPage } from '../index';
import { NO_AOR_FILTER_VALUE } from '../helpers';

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

vi.mock('../../../components/mui-customized/table/table-state-provider', async (importOriginal) => {
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

vi.mock('../../../utils/browser', () => ({
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

vi.mock('../../../components/TablePageToolbar', () => ({
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

vi.mock('../use-rer-networks-neo-page', () => ({
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
    lastActivityAt: null,
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

// Regression: https://github.com/echoua/echo/issues/3568
it('#3568 removes the frequency column from the Cyber column selector', async () => {
  root = createRoot(container!);
  tableStateMock.columnVisibility = { freqs: true };
  await act(async () => {
    root?.render(createElement(RerNetworksNeoPage, { authUserRoles: ['Cyber', 'UnitsEditor'] }));
  });
  const columns = capturedOptions?.columns as Array<{ id?: string }>;
  expect(columns.some((column) => column.id === 'network')).toBe(true);
  expect(columns.some((column) => column.id === 'freqs')).toBe(false);
});
