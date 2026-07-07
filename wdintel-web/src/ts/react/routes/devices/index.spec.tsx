/**
 * @vitest-environment happy-dom
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DevicesPage } from './index';

const tableStateMock = vi.hoisted(() => ({
  globalFilter: 'alpha',
  sorting: [],
  columnOrder: [],
  columnSizing: {},
  columnVisibility: {},
  enableColumnOrdering: true,
  enableColumnResizing: true,
  tableInstance: { id: 'table' },
  onChangeGlobalFilter: vi.fn(),
  onSortingChange: vi.fn(),
  onColumnOrderChange: vi.fn(),
  onColumnSizingChange: vi.fn(),
  onColumnVisibilityChange: vi.fn(),
  onTableInitialized: vi.fn(),
}));

const pageMock = vi.hoisted(() => ({
  useDevicesPage: vi.fn(),
}));

let capturedTableStateProviderProps: Record<string, unknown> | null = null;
let capturedPageToolbarProps: Record<string, unknown> | null = null;
let capturedDevicesToolbarProps: Record<string, unknown> | null = null;
let capturedUnitSidebarProps: Record<string, unknown> | null = null;
let capturedDevicesTableProps: Record<string, unknown> | null = null;
let container: HTMLDivElement | null = null;
let root: Root | null = null;

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

vi.mock('../../components/TablePageToolbar', () => ({
  TablePageToolbar: (props: Record<string, unknown>) => {
    capturedPageToolbarProps = props;
    return <div data-testid="page-toolbar">{props.actions as ReactNode}</div>;
  },
}));

vi.mock('../rer-callsigns-neo/components/UnitStatsSidebar', () => ({
  UnitStatsSidebar: (props: Record<string, unknown>) => {
    capturedUnitSidebarProps = props;
    return <aside data-testid="unit-sidebar" />;
  },
}));

vi.mock('./components/DevicesToolbar', () => ({
  DevicesToolbar: (props: Record<string, unknown>) => {
    capturedDevicesToolbarProps = props;
    return <div data-testid="devices-toolbar" />;
  },
}));

vi.mock('./components/DevicesTable', () => ({
  DevicesTable: (props: Record<string, unknown>) => {
    capturedDevicesTableProps = props;
    return <div data-testid="devices-table" />;
  },
}));

vi.mock('./components/DeviceUpsertDrawer', () => ({
  DeviceUpsertDrawer: () => null,
}));

vi.mock('../../components/ConfirmDangerDialog', () => ({
  ConfirmDangerDialog: () => null,
}));

vi.mock('./use-devices-page', () => ({
  useDevicesPage: pageMock.useDevicesPage,
}));

function buildPageReturn(overrides: Record<string, unknown> = {}) {
  return {
    permissions: { canRead: true, canEdit: true },
    loading: false,
    refreshing: false,
    loadingMore: false,
    rows: [],
    total: 2,
    hasMore: false,
    noMoreToLoad: true,
    sidebarOpen: true,
    setSidebarOpen: vi.fn(),
    filters: { archivedFilter: 'archived', unitIds: [7] },
    setFilters: vi.fn(),
    status: null,
    statusCounts: { active: 3, archived: 1 },
    bootstrapLoaded: true,
    creating: false,
    createDialogOpen: false,
    createForm: null,
    createError: null,
    createServerFieldErrors: {},
    editDialogOpen: false,
    editForm: null,
    editError: null,
    editServerFieldErrors: {},
    editSubmitting: false,
    editHasChanges: false,
    editLoadingDeviceId: null,
    archiveDialogDevice: null,
    mutatingDeviceId: null,
    busyDeviceId: null,
    aorOptions: [],
    unitOptions: [],
    unitStatsView: [
      {
        unitId: 7,
        unitName: 'Unit 7',
        army: '',
        division: '',
        regiment: '',
        battalion: '',
        count: 2,
      },
    ],
    selectedSidebarUnitFilter: { kind: 'leaf', label: 'Unit 7', unitName: 'Unit 7', unitId: 7 },
    hasFilters: true,
    initialLoadFailed: false,
    setArchivedFilter: vi.fn(),
    onPickUnitFilter: vi.fn(),
    onClearUnitFilter: vi.fn(),
    clearFilters: vi.fn(),
    reload: vi.fn(),
    loadMore: vi.fn(),
    openCreateDialog: vi.fn(),
    closeCreateDialog: vi.fn(),
    setCreateForm: vi.fn(),
    submitCreateDialog: vi.fn(),
    openEditRow: vi.fn(),
    closeEditDialog: vi.fn(),
    setEditForm: vi.fn(),
    submitEditDialog: vi.fn(),
    archiveRow: vi.fn(),
    closeArchiveDialog: vi.fn(),
    confirmArchiveRow: vi.fn(),
    restoreRow: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  capturedTableStateProviderProps = null;
  capturedPageToolbarProps = null;
  capturedDevicesToolbarProps = null;
  capturedUnitSidebarProps = null;
  capturedDevicesTableProps = null;
  pageMock.useDevicesPage.mockReturnValue(buildPageReturn());
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

describe('DevicesPage layout', () => {
  it('uses Networks-like toolbar/sidebar layout with only status and sidebar unit filters', () => {
    act(() => {
      root?.render(<DevicesPage authUserRoles={['DevicesEditor']} />);
    });

    expect(capturedTableStateProviderProps).toMatchObject({ tableId: 'devices' });
    expect(capturedPageToolbarProps).toMatchObject({
      title: 'Пристрої',
      internalActionsHidden: true,
    });
    expect(capturedPageToolbarProps).not.toHaveProperty('withGlobalTextFilter');
    expect(capturedPageToolbarProps).not.toHaveProperty('filter');
    expect(container?.textContent).not.toContain('Оновити');
    expect(container?.textContent).toContain('Створити пристрій');

    expect(capturedUnitSidebarProps).toMatchObject({
      showInvestigatingFilter: false,
      countLabel: 'Пристроїв',
    });
    expect(capturedDevicesToolbarProps).toMatchObject({
      globalFilter: 'alpha',
      statusCounts: { active: 3, archived: 1 },
    });

    const additionalActiveFilters = capturedDevicesToolbarProps?.additionalActiveFilters as Array<{
      id: string;
    }>;
    expect(additionalActiveFilters.map((filter) => filter.id)).toEqual(['archived', 'unit']);
    expect(additionalActiveFilters.map((filter) => filter.id)).not.toEqual(
      expect.arrayContaining(['aor', 'createdBy']),
    );
    expect(capturedDevicesTableProps).toMatchObject({
      onEdit: expect.any(Function),
      onArchive: expect.any(Function),
      onRestore: expect.any(Function),
    });
  });
});
