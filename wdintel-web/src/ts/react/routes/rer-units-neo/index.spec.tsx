/**
 * @vitest-environment happy-dom
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ListUnitsReq } from '../../../../Bindings';
import { RerUnitsNeoPage } from './index';

const tableStateMock = vi.hoisted(() => ({
  globalFilter: '',
  columnFilters: [],
  sorting: [{ id: 'name', desc: false }],
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

const pageMock = vi.hoisted(() => ({
  requests: [] as ListUnitsReq[],
  value: null as Record<string, unknown> | null,
}));

vi.mock('@mui/material', async () => {
  const actual = await vi.importActual<typeof import('@mui/material')>('@mui/material');
  return {
    ...actual,
    useMediaQuery: () => false,
  };
});

vi.mock('../../components/mui-customized/table/table-state-provider', () => ({
  TableStateProvider: ({ children }: { children: ReactNode }) => children,
  useTableStateContext: () => tableStateMock,
}));

vi.mock('../../components/TablePageToolbar', () => ({
  TablePageToolbar: (props: Record<string, unknown>) => (
    <div>
      <div data-testid="title-actions">{props.actions as ReactNode}</div>
      <div data-testid="table-controls">
        {props.filter as ReactNode}
        {props.leadingInternalActions as ReactNode}
      </div>
    </div>
  ),
}));

vi.mock('./components/UnitsTable', () => ({ UnitsTable: () => <div data-testid="units-table" /> }));
vi.mock('./components/UnitFormDrawer', () => ({
  UnitFormDrawer: () => null,
}));
vi.mock('./components/UnitActionDialogs', () => ({
  DeleteUnitDialog: () => null,
  MergeUnitDialog: () => null,
}));
vi.mock('./components/KmzTaskStatus', () => ({ KmzTaskStatus: () => null }));
vi.mock('./components/KmzUploadDialog', () => ({ KmzUploadDialog: () => null }));
vi.mock('../rer-unit-details/OrbitUnitLinkDialog', () => ({
  OrbitUnitLinkDialog: () => null,
}));

vi.mock('./use-rer-units-page', () => ({
  useRerUnitsPage: (_roles: string[], req: ListUnitsReq) => {
    pageMock.requests.push(req);
    return pageMock.value;
  },
}));

let container: HTMLDivElement;
let root: Root;

function buildPageValue(overrides: Record<string, unknown> = {}) {
  return {
    units: [],
    totalCount: 41,
    statusCounts: { active: 41, inactive: 2 },
    attachmentUnitIds: new Set(),
    loading: false,
    loadError: null,
    settingsReady: true,
    devicesSectionEnabled: false,
    status: null,
    canEdit: true,
    submitting: false,
    uploadingKmz: false,
    kmzTask: null,
    createOpen: false,
    editUnit: null,
    editOrbitUnits: [],
    orbitLinksLoading: false,
    orbitLinksError: null,
    canLinkEditOrbitUnit: false,
    unlinkingOrbitUnitId: null,
    deleteTarget: null,
    mergeTarget: null,
    dialogError: null,
    loadUnits: vi.fn(),
    openCreateDialog: vi.fn(),
    openEditDialog: vi.fn(),
    openDeleteDialog: vi.fn(),
    openMergeDialog: vi.fn(),
    closeDialogs: vi.fn(),
    submitUnit: vi.fn(),
    confirmDelete: vi.fn(),
    confirmMerge: vi.fn(),
    uploadKmz: vi.fn(),
    unlinkEditOrbitUnit: vi.fn(),
    refreshLinkedEditOrbitUnit: vi.fn(),
    ...overrides,
  };
}

function renderPage() {
  act(() => root.render(<RerUnitsNeoPage authUserRoles={['UnitsEditor']} />));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  tableStateMock.globalFilter = '';
  tableStateMock.columnFilters = [];
  pageMock.requests = [];
  pageMock.value = buildPageValue();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('RerUnitsNeoPage search and pagination controls', () => {
  it('places page navigation with the table controls', () => {
    renderPage();

    const titleActions = container.querySelector('[data-testid="title-actions"]');
    const tableControls = container.querySelector('[data-testid="table-controls"]');

    expect(titleActions?.querySelector('[aria-label="Наступна сторінка"]')).toBeNull();
    expect(tableControls?.querySelector('[aria-label="Наступна сторінка"]')).not.toBeNull();
  });

  it('waits 500 ms after typing before searching', () => {
    vi.useFakeTimers();
    renderPage();

    tableStateMock.globalFilter = 'а';
    renderPage();
    act(() => vi.advanceTimersByTime(250));

    tableStateMock.globalFilter = 'аб';
    renderPage();
    act(() => vi.advanceTimersByTime(499));

    expect(pageMock.requests.some((req) => req.filterText === 'а')).toBe(false);
    expect(pageMock.requests.some((req) => req.filterText === 'аб')).toBe(false);

    act(() => vi.advanceTimersByTime(1));

    expect(pageMock.requests.at(-1)?.filterText).toBe('аб');
  });

  it('keeps the search input focused and enabled while loading', () => {
    renderPage();
    const searchInput = container.querySelector<HTMLInputElement>('input[placeholder="Пошук"]');
    searchInput?.focus();

    pageMock.value = buildPageValue({ loading: true });
    renderPage();

    expect(searchInput?.disabled).toBe(false);
    expect(document.activeElement).toBe(searchInput);
  });
});
