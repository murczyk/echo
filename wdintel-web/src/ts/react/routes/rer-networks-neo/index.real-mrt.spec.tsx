/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AreaOfResponsibility, Network, Unit } from '../../../../Bindings';
import { RerNetworksNeoPage } from './index';
import { buildNetworkRowView, type NetworkRowView } from './helpers';

const tableStateMock = vi.hoisted(() => ({
  globalFilter: '',
  columnFilters: [],
  sorting: [],
  columnOrder: ['mrt-row-numbers', 'mrt-row-actions', 'network', 'aors', 'freqs', 'location', 'activity', 'lastActivity'],
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

vi.mock('../../components/mui-customized/table/table-state-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/mui-customized/table/table-state-provider')>();
  return {
    ...actual,
    useTableStateContext: () => tableStateMock,
  };
});

vi.mock('../../hooks/use-local-storage', () => ({
  useLocalStorage: () => ({
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  }),
}));

vi.mock('@mui/material', async () => {
  const actual = await vi.importActual<typeof import('@mui/material')>('@mui/material');
  return {
    ...actual,
    useMediaQuery: () => true,
  };
});

vi.mock('./use-rer-networks-neo-page', () => ({
  useRerNetworksNeoPage: pageMock.useRerNetworksNeoPage,
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
    lastUpdatedAt: 0,
    lastUpdatedBy: 'tester',
    activeFrom: null,
    activeTo: null,
    postIds: [],
    descriptions: [],
    deleted: false,
    status: 'NetworkActive',
  };
}

function buildUnit(id: number, name: string): Unit {
  return { id, name, army: '', division: '', regiment: '', battalion: '' } as Unit;
}

function buildAor(id: number, name: string): AreaOfResponsibility {
  return { id, name } as AreaOfResponsibility;
}

function buildNetworkRow(id: number): NetworkRowView {
  return buildNetworkRowView(buildNetwork(id), new Map(), new Map(), new Map());
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  tableStateMock.globalFilter = '';
  tableStateMock.columnFilters = [];
  tableStateMock.sorting = [];
  tableStateMock.onTableInitialized.mockReset();

  pageMock.useRerNetworksNeoPage.mockReturnValue({
    loading: false,
    refreshing: false,
    loadingMore: false,
    noMoreToLoad: true,
    sidebarOpen: false,
    setSidebarOpen: vi.fn(),
    rows: [buildNetworkRow(1)],
    allRows: [buildNetworkRow(1)],
    filters: { searchText: '', unitText: '', status: 'all', showOnlyInvestigating: false },
    setFilters: vi.fn(),
    posts: [],
    unitOptions: [buildUnit(1, 'Unit 1')],
    postOptions: [],
    modulations: [{ id: 11, label: 'FM' }],
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
    etalonkaReport: {
      dialogOpen: false,
      downloading: false,
      error: null,
      reportType: 'StandardReport',
      activeFreqsOnly: true,
      includeSigintSigns: true,
      includeConfirmation: true,
      includeUnitCallsigns: true,
      includePelengsMap: true,
      fromDateTimeStr: '',
      toDateTimeStr: '',
    },
    setEtalonkaReport: vi.fn(),
    status: null,
    setStatus: vi.fn(),
    statusCounts: null,
    aorOptions: [buildAor(1, 'AOR 1')],
    permissions: { canEdit: true, canExport: true, canDelete: true },
    reportsMenuAnchorEl: null,
    setReportsMenuAnchorEl: vi.fn(),
    rowMenuAnchorEl: null,
    rowMenuNetworkId: null,
    setRowMenuAnchorEl: vi.fn(),
    setRowMenuNetworkId: vi.fn(),
    downloadInFlight: null,
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
  });
});

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
});

it('renders the real MRT table without crashing on the filter label path', async () => {
  if (!container) throw new Error('container not initialized');

  window.history.replaceState({}, '', window.location.pathname);
  root = createRoot(container);

  await act(async () => {
    root?.render(createElement(RerNetworksNeoPage));
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(container.textContent).toContain('Мережі');
  expect(tableStateMock.onTableInitialized).toHaveBeenCalled();
});

it('renders resize handles for resizable data columns', async () => {
  if (!container) throw new Error('container not initialized');

  root = createRoot(container);

  await act(async () => {
    root?.render(createElement(RerNetworksNeoPage));
    await Promise.resolve();
    await Promise.resolve();
  });

  const resizeHandles = container.querySelectorAll('.Mui-TableHeadCell-ResizeHandle-Wrapper');
  expect(resizeHandles.length).toBeGreaterThanOrEqual(6);
});
