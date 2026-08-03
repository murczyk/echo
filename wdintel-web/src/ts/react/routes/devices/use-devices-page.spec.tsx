/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpRequestError } from '../../services/api/client';
import { useDevicesPage } from './use-devices-page';

const apiMock = vi.hoisted(() => ({
  createDevice: vi.fn(),
  getDeviceDetail: vi.fn(),
  listDevices: vi.fn(),
  updateDevice: vi.fn(),
}));
const sidebarReload = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../../services/api/devices', () => apiMock);
vi.mock('../../components/mui-customized/table/table-state-provider', () => ({
  useTableStateContext: () => ({
    globalFilter: '',
    sorting: [],
    columnFilters: [],
    onChangeGlobalFilter: vi.fn(),
    onColumnFiltersChange: vi.fn(),
  }),
}));
vi.mock('./use-devices-sidebar-resource', () => ({
  useDevicesSidebarResource: () => ({
    units: [],
    unitStats: [],
    loading: false,
    loaded: true,
    error: null,
    reload: sidebarReload,
  }),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: ReturnType<typeof useDevicesPage> | null = null;

function Harness() {
  latest = useDevicesPage({ authUserRoles: ['DeviceSource'] });
  return null;
}

beforeEach(() => {
  apiMock.listDevices.mockResolvedValue({
    list: [],
    total: 0,
    hasMore: false,
    statusCounts: { active: 0, archived: 0 },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  latest = null;
  vi.clearAllMocks();
});

describe('useDevicesPage create reconciliation', () => {
  it('reloads the list without automatically retrying an uncertain create', async () => {
    apiMock.createDevice.mockRejectedValue(new HttpRequestError(0, 'network down'));
    await act(async () => {
      root?.render(<Harness />);
    });
    expect(apiMock.listDevices).toHaveBeenCalledTimes(1);
    apiMock.listDevices.mockClear();
    act(() => latest?.openCreateDialog());
    const form = { ...latest!.createForm!, name: 'Source device' };

    await act(async () => {
      await latest?.submitCreateDialog(form);
    });

    expect(apiMock.createDevice).toHaveBeenCalledTimes(1);
    expect(apiMock.listDevices).toHaveBeenCalledTimes(1);
    expect(latest?.createDialogOpen).toBe(true);
    expect(latest?.createError).toContain('Результат створення пристрою невідомий');
  });
});
