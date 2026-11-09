/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpRequestError } from '../../../services/api/client';
import { useDevicesPage } from '.././use-devices-page';

const apiMock = vi.hoisted(() => ({
  createDevice: vi.fn(),
  getDeviceDetail: vi.fn(),
  listDevices: vi.fn(),
  updateDevice: vi.fn(),
}));
const sidebarReload = vi.hoisted(() => vi.fn(async () => undefined));
const tableState = vi.hoisted(() => ({
  globalFilter: '',
  sorting: [],
  columnFilters: [],
  onChangeGlobalFilter: vi.fn(),
  onColumnFiltersChange: vi.fn(),
}));
const sidebarResource = vi.hoisted(() => ({
  units: [],
  unitStats: [],
  filterOptions: { aors: [], creators: [], tags: [], customFieldKeys: [] },
  loading: false,
  loaded: true,
  error: null,
  reload: sidebarReload,
}));

vi.mock('../../../services/api/devices', () => apiMock);
vi.mock('../../../components/mui-customized/table/table-state-provider', () => ({
  useTableStateContext: () => tableState,
}));
vi.mock('.././use-devices-sidebar-resource', () => ({
  useDevicesSidebarResource: () => sidebarResource,
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: ReturnType<typeof useDevicesPage> | null = null;

function Harness() {
  latest = useDevicesPage({ authUserRoles: ['Cyber'] });
  return null;
}

beforeEach(() => {
  tableState.globalFilter = '';
  apiMock.listDevices.mockReset().mockResolvedValue({
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

// #3926: overlapping scroll events must not append the same page twice or retain an old query.
describe('device pagination request boundaries', () => {
  function devices(offset: number, count: number) {
    return Array.from({ length: count }, (_, index) => ({
      id: String(offset + index),
      name: `Device ${offset + index}`,
      rating: 0,
      tags: [],
      description: null,
      customFields: {},
      aors: [],
      unit: null,
      createdBy: 'author',
      archived: false,
      createdAt: '',
      updatedAt: '',
      archivedAt: null,
      stats: null,
      audioDays: null,
      activitySplitFilesAudio: false,
    }));
  }
  function response(offset: number, count: number, total = 350) {
    return {
      list: devices(offset, count),
      total,
      hasMore: offset + count < total,
      statusCounts: { active: total, archived: 0 },
    };
  }
  it('serializes continuations and preserves the current page on refresh', async () => {
    let resolveAppend!: (value: ReturnType<typeof response>) => void;
    apiMock.listDevices
      .mockReset()
      .mockResolvedValueOnce(response(0, 100))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveAppend = resolve;
          }),
      )
      .mockResolvedValue(response(300, 50));
    await act(async () => root?.render(<Harness />));
    let pending!: Promise<void>;
    act(() => {
      pending = latest!.loadMore();
    });
    await act(async () => latest!.loadMore());
    expect(apiMock.listDevices).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolveAppend(response(100, 100));
      await pending;
    });
    expect(latest?.rows).toHaveLength(200);
    expect(new Set(latest?.rows.map((row) => row.id)).size).toBe(200);
    await act(async () => latest!.openPage(3));
    expect(latest?.startOffset).toBe(300);
    expect(latest?.rows).toHaveLength(50);
    const before = apiMock.listDevices.mock.calls.length;
    await act(async () => latest!.loadMore());
    expect(apiMock.listDevices).toHaveBeenCalledTimes(before);
    await act(async () => latest!.reload());
    expect(apiMock.listDevices.mock.calls.at(-1)?.[0].offset).toBe(300);
  });
  it('returns to the last available page when the current page becomes empty', async () => {
    apiMock.listDevices
      .mockReset()
      .mockResolvedValueOnce(response(0, 100, 101))
      .mockResolvedValueOnce(response(100, 1, 101))
      .mockResolvedValueOnce(response(100, 0, 100))
      .mockResolvedValueOnce(response(0, 100, 100));
    await act(async () => root?.render(<Harness />));
    await act(async () => latest!.openPage(1));
    expect(latest?.startOffset).toBe(100);
    await act(async () => latest!.reload());
    expect(latest?.startOffset).toBe(0);
    expect(latest?.rows).toHaveLength(100);
    expect(latest?.status).toBeNull();
    expect(apiMock.listDevices.mock.calls.map(([req]) => req.offset)).toEqual([0, 100, 100, 0]);
  });

  it('rejects an old continuation after the search changes', async () => {
    let resolveAppend!: (value: ReturnType<typeof response>) => void;
    apiMock.listDevices
      .mockReset()
      .mockResolvedValueOnce(response(0, 100))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveAppend = resolve;
          }),
      )
      .mockResolvedValue(response(0, 0, 0));
    await act(async () => root?.render(<Harness />));
    let pending!: Promise<void>;
    act(() => {
      pending = latest!.loadMore();
    });
    tableState.globalFilter = 'filtered';
    await act(async () => root?.render(<Harness />));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    await act(async () => {
      resolveAppend(response(100, 100));
      await pending;
    });
    expect(latest?.rows).toEqual([]);
    expect(latest?.startOffset).toBe(0);
    expect(apiMock.listDevices.mock.calls.at(-1)?.[0]).toMatchObject({
      filterText: 'filtered',
      offset: 0,
    });
  });
});
