/**
 * @vitest-environment happy-dom
 */
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AreaOfResponsibility, Network, Unit } from '../../../../Bindings';
import { HttpRequestError } from '../../services/api/client';
import { useRerNetworksNeoPage } from './use-rer-networks-neo-page';

const apiMock = vi.hoisted(() => ({
  createNetwork: vi.fn(),
  deleteNetwork: vi.fn(),
  downloadNetworkEtalonkaReport: vi.fn(),
  downloadNetworksEtalonkaReport: vi.fn(),
  downloadNetworkGoiReport: vi.fn(),
  getNetworksGroupsActivity: vi.fn(),
  getNetworkUnitStats: vi.fn(),
  getModulations: vi.fn(),
  listAors: vi.fn(),
  listNetworks: vi.fn(),
  listPosts: vi.fn(),
  getUnitsList: vi.fn(),
  updateNetwork: vi.fn(),
  updateNetworkPosts: vi.fn(),
  updateNetworkUnits: vi.fn(),
}));

const tableStateMock = vi.hoisted(() => ({
  globalFilter: '',
  columnFilters: [],
  sorting: [],
  columnSizing: {},
  onChangeGlobalFilter: vi.fn(),
  onColumnFiltersChange: vi.fn(),
  onSortingChange: vi.fn(),
}));

const downloadBlobMock = vi.hoisted(() => vi.fn());

dayjs.extend(utc);

vi.mock('../../components/mui-customized/table/table-state-provider', () => ({
  useTableStateContext: () => tableStateMock,
}));

vi.mock('../../services/api/aor', () => ({
  listAors: apiMock.listAors,
}));

vi.mock('../../services/api/units', () => ({
  getUnitsList: apiMock.getUnitsList,
}));

vi.mock('../../services/api/posts', () => ({
  listPosts: apiMock.listPosts,
}));

vi.mock('../../services/api/networks', () => ({
  createNetwork: apiMock.createNetwork,
  deleteNetwork: apiMock.deleteNetwork,
  downloadNetworkEtalonkaReport: apiMock.downloadNetworkEtalonkaReport,
  downloadNetworksEtalonkaReport: apiMock.downloadNetworksEtalonkaReport,
  downloadNetworkGoiReport: apiMock.downloadNetworkGoiReport,
  getNetworksGroupsActivity: apiMock.getNetworksGroupsActivity,
  getNetworkUnitStats: apiMock.getNetworkUnitStats,
  listNetworks: apiMock.listNetworks,
  updateNetwork: apiMock.updateNetwork,
  updateNetworkPosts: apiMock.updateNetworkPosts,
  updateNetworkUnits: apiMock.updateNetworkUnits,
}));

vi.mock('../../services/api/modulations', () => ({
  getModulations: apiMock.getModulations,
}));

vi.mock('../../utils/download-blob', () => ({
  downloadBlob: downloadBlobMock,
}));

type HookResult = ReturnType<typeof useRerNetworksNeoPage>;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: HookResult | null = null;
let locationAssignSpy: any = null;
let authUserRoles: string[] = ['Rer', 'Full'];

function buildNetwork(id: number, overrides: Partial<Network> = {}): Network {
  const now = 1_751_000_000_000;
  return {
    id,
    freqs: [],
    unitIds: [],
    aorIds: [],
    name: `Network ${id}`,
    location: `Location ${id}`,
    radioStation: null,
    createdAt: now,
    purpose: null,
    operationMode: null,
    operationType: null,
    operationPeriod: null,
    lastUpdatedAt: now,
    lastUpdatedBy: 'tester',
    activeFrom: null,
    activeTo: null,
    postIds: [],
    descriptions: [],
    deleted: false,
    status: 'NetworkActive',
    ...overrides,
  };
}

function buildAor(id: number, name: string): AreaOfResponsibility {
  return { id, name } as AreaOfResponsibility;
}

function buildUnit(id: number, name: string): Unit {
  return {
    id,
    name,
    army: '',
    division: '',
    regiment: '',
    battalion: '',
  } as Unit;
}

function Harness() {
  latest = useRerNetworksNeoPage({ authUserRoles });
  return null;
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderHook() {
  if (container === null) throw new Error('container not initialized');

  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(Harness));
  });
}

describe('useRerNetworksNeoPage', () => {
  beforeEach(() => {
    vi.useRealTimers();
    window.history.replaceState({}, '', '/rer-networks/42');
    container = document.createElement('div');
    document.body.appendChild(container);
    latest = null;

    apiMock.deleteNetwork.mockReset();
    apiMock.createNetwork.mockReset();
    apiMock.downloadNetworkEtalonkaReport.mockReset();
    apiMock.downloadNetworksEtalonkaReport.mockReset();
    apiMock.downloadNetworkGoiReport.mockReset();
    apiMock.getNetworksGroupsActivity.mockReset();
    apiMock.getNetworkUnitStats.mockReset();
    apiMock.getModulations.mockReset();
    apiMock.listAors.mockReset();
    apiMock.listNetworks.mockReset();
    apiMock.listPosts.mockReset();
    apiMock.getUnitsList.mockReset();
    apiMock.updateNetwork.mockReset();
    apiMock.updateNetworkPosts.mockReset();
    apiMock.updateNetworkUnits.mockReset();

    apiMock.listAors.mockResolvedValue([buildAor(1, 'AOR 1')]);
    apiMock.getUnitsList.mockResolvedValue([buildUnit(1, 'Unit 1')]);
    apiMock.getNetworkUnitStats.mockResolvedValue([]);
    apiMock.listPosts.mockResolvedValue([]);
    apiMock.getNetworksGroupsActivity.mockResolvedValue({});
    apiMock.getModulations.mockResolvedValue([{ id: 11, name: 'FM' } as never]);
    apiMock.downloadNetworkEtalonkaReport.mockResolvedValue(new Blob(['report']));
    apiMock.downloadNetworksEtalonkaReport.mockResolvedValue(new Blob(['report']));
    apiMock.downloadNetworkGoiReport.mockResolvedValue(new Blob(['goi']));
    apiMock.createNetwork.mockResolvedValue(buildNetwork(3));
    apiMock.updateNetwork.mockResolvedValue(buildNetwork(1));
    apiMock.updateNetworkPosts.mockResolvedValue(buildNetwork(1));
    apiMock.updateNetworkUnits.mockResolvedValue(buildNetwork(1));
    apiMock.deleteNetwork.mockResolvedValue(buildNetwork(1, { deleted: true }));
    apiMock.listNetworks.mockResolvedValue({
      list: [buildNetwork(1), buildNetwork(2)],
      statusCounts: { active: 7, inactive: 1, archived: 1 },
    });

    tableStateMock.globalFilter = '';
    tableStateMock.columnFilters = [];
    tableStateMock.sorting = [];
    tableStateMock.columnSizing = {};
    tableStateMock.onChangeGlobalFilter.mockReset();
    tableStateMock.onColumnFiltersChange.mockReset();
    tableStateMock.onSortingChange.mockReset();

    downloadBlobMock.mockReset();
    authUserRoles = ['Rer', 'Full'];

    locationAssignSpy = vi.spyOn(window.location, 'assign').mockImplementation(() => undefined);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container?.remove();
    container = null;
    latest = null;
    locationAssignSpy?.mockRestore();
    locationAssignSpy = null;
    vi.useRealTimers();
  });

  it('starts with the sidebar collapsed', async () => {
    await renderHook();
    await flushEffects();

    expect(latest?.sidebarOpen).toBe(false);
  });

  it('opens the create drawer with the classic defaults', async () => {
    await renderHook();
    await flushEffects();

    await act(async () => {
      latest?.openCreateDialog();
    });
    await flushEffects();

    expect(latest?.createDialog).toEqual({
      id: null,
      name: 'управління',
      location: '',
      radioStation: '',
      purpose: 'для управління підлеглим особовим складом',
      operationMode: 'дуплекс',
      operationType: 'ведення службового радіообміну',
      operationPeriod: 'цілодобово',
      status: 'NetworkActive',
      aorIds: [],
      unitIds: [],
      postIds: [],
      freq: '',
      kind: 'DMR',
      modulationId: null,
      activeFrom: '',
      activeTo: '',
      encryptionKeyIds: [],
    });
  });

  it('filters blank posts from create drawer options', async () => {
    apiMock.listPosts.mockResolvedValueOnce([
      { id: 1, name: '   ' } as never,
      { id: 2, name: '_stihl_XN Пост' } as never,
    ]);

    await renderHook();
    await flushEffects();

    expect(latest?.postOptions).toEqual([{ id: 2, label: '_stihl_XN Пост' }]);
  });

  it('creates a network and refreshes the list with the create request mapping', async () => {
    await renderHook();
    await flushEffects();

    await act(async () => {
      latest?.openCreateDialog();
    });
    await flushEffects();

    await act(async () => {
      latest?.setCreateDialog({
        id: null,
        name: 'Радіомережа 1',
        location: 'Київ',
        radioStation: '',
        purpose: 'для управління підлеглим особовим складом',
        operationMode: 'дуплекс',
        operationType: 'ведення службового радіообміну',
        operationPeriod: 'цілодобово',
        status: 'NetworkActive',
        aorIds: [1],
        unitIds: [1],
        postIds: [1],
        freq: '123.4500',
        kind: 'DMR',
        modulationId: 11,
        activeFrom: '2026-06-01',
        activeTo: '2026-06-30',
        encryptionKeyIds: [],
      });
    });
    await flushEffects();
    expect(latest?.createDialog?.name).toBe('Радіомережа 1');

    await act(async () => {
      await latest?.saveNetworkCreate();
    });
    await flushEffects();

    expect(latest?.createError).toBeNull();
    expect(apiMock.createNetwork).toHaveBeenCalledWith({
      freqs: [
        {
          freq: '123.4500',
          kind: 'DMR',
          modulationId: 11,
          encryptionKeyIds: [],
          description: null,
          activeFrom: expect.any(Number),
          activeTo: expect.any(Number),
        },
      ],
      unitIds: [1],
      areaOfResponsibilityIds: [1],
      name: 'Радіомережа 1',
      location: 'Київ',
      radioStation: null,
      purpose: 'для управління підлеглим особовим складом',
      operationMode: 'дуплекс',
      operationType: 'ведення службового радіообміну',
      operationPeriod: 'цілодобово',
      postIds: [1],
      descriptions: [],
    });
    expect(latest?.createDialog).toBeNull();
    expect(latest?.status).toEqual({ kind: 'success', text: 'Мережу створено.' });
    expect(apiMock.listNetworks).toHaveBeenCalledTimes(2);
  });

  it('keeps backend row order when the server returns a custom sort', async () => {
    apiMock.listNetworks.mockResolvedValueOnce({
      list: [buildNetwork(2), buildNetwork(1)],
      statusCounts: { active: 7, inactive: 1, archived: 1 },
    });

    await renderHook();
    await flushEffects();

    expect(latest?.rows.map((row) => row.id)).toEqual([2, 1]);
  });

  it('refreshes an edited row with updated relations from the server', async () => {
    await renderHook();
    await flushEffects();

    await act(async () => {
      latest?.setEditDialog({
        id: 1,
        name: 'Network 1',
        location: 'Location 1',
        radioStation: '',
        purpose: '',
        operationMode: '',
        operationType: '',
        operationPeriod: '',
        status: 'NetworkActive',
        aorIds: [1],
        unitIds: [1],
        postIds: [2],
        freq: '',
        kind: 'DMR',
        modulationId: null,
        activeFrom: '',
        activeTo: '',
        encryptionKeyIds: [],
      });
    });
    await flushEffects();

    apiMock.listNetworks.mockResolvedValueOnce({
      list: [buildNetwork(1, { unitIds: [1], postIds: [2] }), buildNetwork(2)],
      statusCounts: { active: 7, inactive: 1, archived: 1 },
    });
    apiMock.listNetworks.mockResolvedValueOnce({
      list: [],
      statusCounts: { active: 7, inactive: 1, archived: 1 },
    });

    await act(async () => {
      await latest?.saveNetworkEdit();
    });
    await flushEffects();

    expect(apiMock.updateNetwork).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        name: 'Network 1',
        location: 'Location 1',
        areaOfResponsibilityIds: [1],
        status: 'NetworkActive',
      }),
    );
    expect(apiMock.updateNetworkPosts).toHaveBeenCalledWith({
      networkId: 1,
      postIds: [2],
    });
    expect(apiMock.updateNetworkUnits).toHaveBeenCalledWith({
      networkId: 1,
      unitIds: [1],
    });
    expect(latest?.rows.find((row) => row.id === 1)?.network.unitIds).toEqual([1]);
    expect(latest?.rows.find((row) => row.id === 1)?.network.postIds).toEqual([2]);
    expect(apiMock.listNetworks).toHaveBeenCalledTimes(3);
  });

  it('drops an edited row when it no longer matches the active filter', async () => {
    await renderHook();
    await flushEffects();

    await act(async () => {
      latest?.setFilters((current) => ({ ...current, status: 'active' }));
    });
    await flushEffects();

    await act(async () => {
      latest?.setEditDialog({
        id: 1,
        name: 'Network 1',
        location: 'Location 1',
        radioStation: '',
        purpose: '',
        operationMode: '',
        operationType: '',
        operationPeriod: '',
        status: 'NetworkInactive',
        aorIds: [1],
        unitIds: [],
        postIds: [],
        freq: '',
        kind: 'DMR',
        modulationId: null,
        activeFrom: '',
        activeTo: '',
        encryptionKeyIds: [],
      });
    });
    await flushEffects();

    apiMock.listNetworks.mockResolvedValueOnce({
      list: [buildNetwork(2)],
      statusCounts: { active: 1, inactive: 1, archived: 1 },
    });
    apiMock.listNetworks.mockResolvedValueOnce({
      list: [],
      statusCounts: { active: 1, inactive: 1, archived: 1 },
    });

    await act(async () => {
      await latest?.saveNetworkEdit();
    });
    await flushEffects();

    expect(latest?.rows.map((row) => row.id)).toEqual([2]);
    expect(apiMock.listNetworks).toHaveBeenCalledTimes(4);
  });

  it('blocks create submission when the first frequency is invalid', async () => {
    await renderHook();
    await flushEffects();

    await act(async () => {
      latest?.openCreateDialog();
    });
    await flushEffects();

    await act(async () => {
      latest?.setCreateDialog({
        id: null,
        name: 'Радіомережа 1',
        location: 'Київ',
        radioStation: '',
        purpose: 'для управління підлеглим особовим складом',
        operationMode: 'дуплекс',
        operationType: 'ведення службового радіообміну',
        operationPeriod: 'цілодобово',
        status: 'NetworkActive',
        aorIds: [1],
        unitIds: [],
        postIds: [],
        freq: '123.45',
        kind: 'DMR',
        modulationId: 11,
        activeFrom: '2026-06-01',
        activeTo: '',
        encryptionKeyIds: [],
      });
    });
    await flushEffects();

    await act(async () => {
      await latest?.saveNetworkCreate();
    });
    await flushEffects();

    expect(apiMock.createNetwork).not.toHaveBeenCalled();
    expect(latest?.createError).toBe('Невірний формат частоти (наприклад: 146.5000)');
  });

  it('keeps status counts when only the status chip changes', async () => {
    await renderHook();
    await flushEffects();

    expect(latest?.statusCounts).toEqual({ active: 7, inactive: 1, archived: 1 });

    await act(async () => {
      latest?.setFilters((current) => ({ ...current, status: 'active' }));
    });
    await flushEffects();

    expect(latest?.statusCounts).toEqual({ active: 7, inactive: 1, archived: 1 });
  });

  it('does not reload networks when only column sizing changes', async () => {
    await renderHook();
    await flushEffects();

    expect(apiMock.listNetworks).toHaveBeenCalledTimes(1);

    tableStateMock.columnSizing = { network: 320 };
    await act(async () => {
      root?.render(createElement(Harness));
    });
    await flushEffects();

    expect(apiMock.listNetworks).toHaveBeenCalledTimes(1);
  });

  it('redirects to login on unauthorized network load', async () => {
    apiMock.listNetworks.mockRejectedValueOnce(new HttpRequestError(401, 'unauthorized'));

    await renderHook();
    await flushEffects();

    expect(locationAssignSpy).toHaveBeenCalledWith('/login');
  });

  it('opens the top report with the current settings and loaded network ids', async () => {
    await renderHook();
    await flushEffects();

    await act(async () => {
      latest?.setEtalonkaReport((current) => ({
        ...current,
        reportType: 'ExtendedReport',
        activeFreqsOnly: false,
        includeSigintSigns: false,
        includeConfirmation: false,
        includeUnitCallsigns: true,
        includePelengsMap: false,
        fromDateTimeStr: '2026-05-02T10:00',
        toDateTimeStr: '2026-05-03T11:30',
      }));
      latest?.openTopReportDialog();
    });
    await flushEffects();

    await act(async () => {
      await latest?.downloadEtalonkaReport();
    });

    expect(apiMock.downloadNetworksEtalonkaReport).toHaveBeenCalledWith({
      req: {
        filterFreq: null,
        filterUnit: null,
        filterText: null,
        filterName: null,
        filterLocation: null,
        showOnlyFurtherInverstigation: null,
        showInactive: true,
        showOnlyDeleted: false,
        statusFilter: null,
        aorIds: null,
        ids: null,
        limit: null,
        offset: null,
        sortBy: ['NameAsc'],
      },
      etalonkaType: {
        ExtendedReport: {
          sinceDateInclusiveMs: expect.any(Number),
          tillDateInclusiveMs: expect.any(Number),
          activeFreqsOnly: false,
          includeUnitCallsigns: true,
          includeSigintSigns: false,
          includeConfirmation: false,
          includePelengsMap: false,
        },
      },
    });
    expect(downloadBlobMock).toHaveBeenCalledWith(expect.any(Blob), 'etalonka_networks.docx');
  });

  it('uses the backend status counts', async () => {
    await renderHook();
    await flushEffects();

    expect(apiMock.listNetworks).toHaveBeenCalledWith({
      filterFreq: null,
      filterUnit: null,
      filterText: null,
      filterName: null,
      filterLocation: null,
      showOnlyFurtherInverstigation: null,
      showInactive: true,
      showOnlyDeleted: false,
      statusFilter: null,
      aorIds: null,
      ids: null,
      limit: 100,
      offset: 0,
      sortBy: ['NameAsc'],
    }, expect.any(Object));
    expect(latest?.statusCounts).toEqual({ active: 7, inactive: 1, archived: 1 });
  });

  it('maps status chips to the expected backend status filters', async () => {
    await renderHook();
    await flushEffects();

    await act(async () => {
      latest?.setFilters((current) => ({ ...current, status: 'active' }));
    });
    await flushEffects();

    expect(apiMock.listNetworks).toHaveBeenLastCalledWith(
      expect.objectContaining({
        statusFilter: null,
        showInactive: false,
        showOnlyDeleted: false,
      }),
      expect.any(Object),
    );

    await act(async () => {
      latest?.setFilters((current) => ({ ...current, status: 'inactive' }));
    });
    await flushEffects();

    expect(apiMock.listNetworks).toHaveBeenLastCalledWith(
      expect.objectContaining({
        statusFilter: 'ListNetworksInactive',
      }),
      expect.any(Object),
    );

    await act(async () => {
      latest?.setFilters((current) => ({ ...current, status: 'deleted' }));
    });
    await flushEffects();

    expect(apiMock.listNetworks).toHaveBeenLastCalledWith(
      expect.objectContaining({
        statusFilter: 'ListNetworksArchived',
      }),
      expect.any(Object),
    );
  });

  it('allows retrying a failed reload for the same query later', async () => {
    await renderHook();
    await flushEffects();

    apiMock.listNetworks.mockRejectedValueOnce(new Error('transient'));

    await act(async () => {
      latest?.setFilters((current) => ({ ...current, status: 'active' }));
    });
    await flushEffects();

    expect(apiMock.listNetworks).toHaveBeenCalledTimes(2);

    apiMock.listNetworks.mockResolvedValueOnce({
      list: [buildNetwork(1), buildNetwork(2)],
      statusCounts: { active: 6, inactive: 1, archived: 1 },
    });

    await act(async () => {
      latest?.setFilters((current) => ({ ...current, status: 'inactive' }));
    });
    await flushEffects();

    expect(apiMock.listNetworks).toHaveBeenCalledTimes(3);

    await act(async () => {
      latest?.setFilters((current) => ({ ...current, status: 'active' }));
    });
    await flushEffects();

    expect(apiMock.listNetworks).toHaveBeenCalledTimes(4);
  });

  it('reloads immediately for status changes and debounces global search', async () => {
    vi.useFakeTimers();

    await renderHook();
    await flushEffects();

    expect(apiMock.listNetworks).toHaveBeenCalledTimes(1);

    await act(async () => {
      latest?.setFilters((current) => ({ ...current, status: 'active' }));
    });
    await flushEffects();

    expect(apiMock.listNetworks).toHaveBeenCalledTimes(2);

    tableStateMock.globalFilter = 'alpha';
    await act(async () => {
      root?.render(createElement(Harness));
    });
    await flushEffects();

    expect(apiMock.listNetworks).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(249);
    });
    expect(apiMock.listNetworks).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await flushEffects();

    expect(apiMock.listNetworks).toHaveBeenCalledTimes(3);
  });

  it('requests activity data with a concrete upper bound and maps returned bars', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-12T15:34:56Z'));

    const todayKey = dayjs.utc().startOf('day').valueOf();
    apiMock.getNetworksGroupsActivity.mockResolvedValueOnce({
      1: {
        [todayKey]: { alpha: 3 },
      },
    });

    await renderHook();
    await flushEffects();

    expect(apiMock.getNetworksGroupsActivity).toHaveBeenCalledWith(
      {
        networkIds: [1, 2],
        tillDateNoninclusiveMs: dayjs.utc().startOf('day').add(1, 'day').valueOf(),
      },
      expect.any(Object),
    );
    expect(latest?.rows[0]?.activityBars.some((bar) => bar.value === 3)).toBe(true);
  });

  it('enables edit and delete permissions for UnitsEditor roles', async () => {
    authUserRoles = ['Rer', 'UnitsEditor'];

    await renderHook();
    await flushEffects();

    expect(latest?.permissions).toEqual({
      canEdit: true,
      canExport: true,
      canDelete: true,
    });
  });

  it('removes a soft-deleted network from the active list', async () => {
    await renderHook();
    await flushEffects();

    expect(latest?.rows).toHaveLength(2);

    await act(async () => {
      latest?.openDeleteDialog(buildNetwork(1));
    });

    apiMock.listNetworks.mockResolvedValueOnce({
      list: [],
      statusCounts: { active: 1, inactive: 0, archived: 0 },
    });

    await act(async () => {
      await latest?.confirmDeleteNetwork();
    });

    expect(apiMock.deleteNetwork).toHaveBeenCalledWith(1);
    expect(latest?.rows.map((row) => row.id)).toEqual([2]);
  });
});
