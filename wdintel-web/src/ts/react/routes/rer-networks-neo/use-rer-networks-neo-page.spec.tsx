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
import { NETWORK_STATUS_ACTIVE, NETWORK_STATUS_INACTIVE } from '../rer-network-details-neo/network-status';
import { useRerNetworksNeoPage } from './use-rer-networks-neo-page';

const apiMock = vi.hoisted(() => ({
  createNetwork: vi.fn(),
  deleteNetwork: vi.fn(),
  downloadNetworkEtalonkaReportTaskResult: vi.fn(),
  getNetworksGroupsActivity: vi.fn(),
  getNetworkUnitStats: vi.fn(),
  getEncryptions: vi.fn(),
  currentSystemSettings: vi.fn(),
  listAors: vi.fn(),
  listNetworks: vi.fn(),
  listPosts: vi.fn(),
  launchNetworkEtalonkaBatchReportTask: vi.fn(),
  launchNetworksEtalonkaReportTask: vi.fn(),
  getUnitsList: vi.fn(),
  updateNetwork: vi.fn(),
  updateNetworkPosts: vi.fn(),
  updateNetworkUnits: vi.fn(),
}));

const bgtaskMock = vi.hoisted(() => ({
  fetchBgtaskStatusAndLogs: vi.fn(),
}));

const reportHistoryMock = vi.hoisted(() => ({
  fetchReportHistoryTaskStatus: vi.fn(),
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
  downloadNetworkEtalonkaReportTaskResult: apiMock.downloadNetworkEtalonkaReportTaskResult,
  getNetworksGroupsActivity: apiMock.getNetworksGroupsActivity,
  getNetworkUnitStats: apiMock.getNetworkUnitStats,
  listNetworks: apiMock.listNetworks,
  launchNetworkEtalonkaBatchReportTask: apiMock.launchNetworkEtalonkaBatchReportTask,
  launchNetworksEtalonkaReportTask: apiMock.launchNetworksEtalonkaReportTask,
  updateNetwork: apiMock.updateNetwork,
  updateNetworkPosts: apiMock.updateNetworkPosts,
  updateNetworkUnits: apiMock.updateNetworkUnits,
}));

vi.mock('../../services/api/bgtask', () => ({
  fetchBgtaskStatusAndLogs: bgtaskMock.fetchBgtaskStatusAndLogs,
  getBgtaskProgress: (loglines: string[]) => ({
    curr: loglines.length > 0 ? 1 : 1,
    overall: 4,
  }),
  getBgtaskProgressFromPercent: (loglines: string[], progress?: number) => {
    if (typeof progress === 'number' && Number.isFinite(progress)) {
      return { curr: Math.max(0, Math.min(100, Math.round(progress))), overall: 100 };
    }
    return {
      curr: loglines.length > 0 ? 1 : 1,
      overall: 4,
    };
  },
}));

vi.mock('../../services/api/report-history', () => ({
  fetchReportHistoryTaskStatus: reportHistoryMock.fetchReportHistoryTaskStatus,
}));

vi.mock('../../services/api/encryptions', () => ({
  getEncryptions: apiMock.getEncryptions,
}));

vi.mock('../../services/api/system-settings', () => ({
  currentSystemSettings: apiMock.currentSystemSettings,
}));

vi.mock('../../utils/download-blob', () => ({
  downloadBlob: downloadBlobMock,
}));

type HookResult = ReturnType<typeof useRerNetworksNeoPage>;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: HookResult | null = null;
let locationReplaceSpy: any = null;
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
    doNotArchive: false,
    lastUpdatedAt: now,
    lastUpdatedBy: 'tester',
    activeFrom: null,
    activeTo: null,
    postIds: [],
    descriptions: [],
    deleted: false,
    status: NETWORK_STATUS_ACTIVE,
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
    apiMock.downloadNetworkEtalonkaReportTaskResult.mockReset();
    apiMock.launchNetworkEtalonkaBatchReportTask.mockReset();
    apiMock.launchNetworksEtalonkaReportTask.mockReset();
    bgtaskMock.fetchBgtaskStatusAndLogs.mockReset();
    reportHistoryMock.fetchReportHistoryTaskStatus.mockReset();
    apiMock.getNetworksGroupsActivity.mockReset();
    apiMock.getNetworkUnitStats.mockReset();
    apiMock.getEncryptions.mockReset();
    apiMock.currentSystemSettings.mockReset();
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
    apiMock.getEncryptions.mockResolvedValue([{ id: 11, name: 'FM' } as never]);
    apiMock.currentSystemSettings.mockResolvedValue({
      id: 1,
      rerAnalysisUnitsExactMatchOnlyDefault: false,
      rerDutyTestEnabled: false,
      rerDutyInsertHistoricalInterceptions: false,
      rerDutyTestSinceMs: 0,
      rerDutyTestLimit: 0,
      rerDutyPollIntervalSec: 0,
      rerShortUrlEnabled: false,
      supportNonRerInterceptions: false,
    });
    apiMock.downloadNetworkEtalonkaReportTaskResult.mockResolvedValue(new Blob(['report']));
    apiMock.launchNetworkEtalonkaBatchReportTask.mockResolvedValue(123);
    apiMock.launchNetworksEtalonkaReportTask.mockResolvedValue(456);
    bgtaskMock.fetchBgtaskStatusAndLogs.mockResolvedValue({
      running: false,
      loglines: [],
      finishedWithError: null,
      finishedWithErrorCode: null,
    });
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

    locationReplaceSpy = vi.spyOn(window.location, 'replace').mockImplementation(() => undefined);
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
    locationReplaceSpy?.mockRestore();
    locationReplaceSpy = null;
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
      doNotArchive: false,
      status: NETWORK_STATUS_ACTIVE,
      aorIds: [],
      unitIds: [],
      postIds: [],
      freq: '',
      modulation: 'DMR',
      encryptionId: null,
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

  it('creates a network and redirects to the new network details page', async () => {
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
        status: NETWORK_STATUS_ACTIVE,
        aorIds: [1],
        unitIds: [1],
        postIds: [1],
        freq: '123.4500',
        modulation: 'DMR',
        encryptionId: 11,
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
          modulation: 'DMR',
          encryptionId: 11,
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
    expect(locationAssignSpy).toHaveBeenCalledWith('/rer-networks-neo/3');
    expect(apiMock.listNetworks).toHaveBeenCalledTimes(1);
  });

  it('creates a network without frequency when non-RER interceptions are enabled', async () => {
    apiMock.currentSystemSettings.mockResolvedValueOnce({
      id: 1,
      rerAnalysisUnitsExactMatchOnlyDefault: false,
      rerDutyTestEnabled: false,
      rerDutyInsertHistoricalInterceptions: false,
      rerDutyTestSinceMs: 0,
      rerDutyTestLimit: 0,
      rerDutyPollIntervalSec: 0,
      rerShortUrlEnabled: false,
      supportNonRerInterceptions: true,
    });

    await renderHook();
    await flushEffects();

    await act(async () => {
      latest?.setCreateDialog({
        id: null,
        name: 'Радіомережа без частоти',
        location: 'Київ',
        radioStation: '',
        purpose: 'для управління підлеглим особовим складом',
        operationMode: 'дуплекс',
        operationType: 'ведення службового радіообміну',
        operationPeriod: 'цілодобово',
        status: NETWORK_STATUS_ACTIVE,
        aorIds: [1],
        unitIds: [1],
        postIds: [],
        freq: '',
        modulation: 'DMR',
        encryptionId: null,
        activeFrom: '',
        activeTo: '',
        encryptionKeyIds: [],
      });
    });
    await flushEffects();

    await act(async () => {
      await latest?.saveNetworkCreate();
    });
    await flushEffects();

    expect(apiMock.createNetwork).toHaveBeenCalledWith(
      expect.objectContaining({
        freqs: null,
        name: 'Радіомережа без частоти',
      }),
    );
    expect(locationAssignSpy).toHaveBeenCalledWith('/rer-networks-neo/3');
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
        status: NETWORK_STATUS_ACTIVE,
        aorIds: [1],
        unitIds: [1],
        postIds: [2],
        freq: '',
        modulation: 'DMR',
        encryptionId: null,
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
        status: NETWORK_STATUS_ACTIVE,
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

  it('does not request a restore for archived rows without an active window', async () => {
    apiMock.listNetworks.mockResolvedValueOnce({
      list: [buildNetwork(1, { deleted: true, activeTo: null }), buildNetwork(2)],
      statusCounts: { active: 7, inactive: 1, archived: 1 },
    });

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
        status: NETWORK_STATUS_ACTIVE,
        aorIds: [1],
        unitIds: [],
        postIds: [],
        freq: '',
        modulation: 'DMR',
        encryptionId: null,
        activeFrom: '',
        activeTo: '',
        encryptionKeyIds: [],
      });
    });
    await flushEffects();

    apiMock.listNetworks.mockResolvedValueOnce({
      list: [buildNetwork(1, { deleted: true, activeTo: null }), buildNetwork(2)],
      statusCounts: { active: 7, inactive: 1, archived: 1 },
    });

    await act(async () => {
      await latest?.saveNetworkEdit();
    });
    await flushEffects();

    expect(apiMock.updateNetwork).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        restoreNetwork: true,
      }),
    );
  });

  it('requests a restore when an archived row still has an active window', async () => {
    apiMock.listNetworks.mockResolvedValueOnce({
      list: [buildNetwork(1, { deleted: true, activeTo: 1_751_000_000_000 }), buildNetwork(2)],
      statusCounts: { active: 7, inactive: 1, archived: 1 },
    });

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
        status: NETWORK_STATUS_ACTIVE,
        aorIds: [1],
        unitIds: [],
        postIds: [],
        freq: '',
        modulation: 'DMR',
        encryptionId: null,
        activeFrom: '',
        activeTo: '',
        encryptionKeyIds: [],
      });
    });
    await flushEffects();

    apiMock.listNetworks.mockResolvedValueOnce({
      list: [buildNetwork(1, { deleted: true, activeTo: 1_751_000_000_000 }), buildNetwork(2)],
      statusCounts: { active: 7, inactive: 1, archived: 1 },
    });

    await act(async () => {
      await latest?.saveNetworkEdit();
    });
    await flushEffects();

    expect(apiMock.updateNetwork).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        restoreNetwork: true,
      }),
    );
  });

  it('requests a restore when an archived row is inactive', async () => {
    apiMock.listNetworks.mockResolvedValueOnce({
      list: [buildNetwork(1, { deleted: true, activeTo: 1_751_000_000_000 }), buildNetwork(2)],
      statusCounts: { active: 7, inactive: 1, archived: 1 },
    });

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
        status: NETWORK_STATUS_INACTIVE,
        aorIds: [1],
        unitIds: [],
        postIds: [],
        freq: '',
        modulation: 'DMR',
        encryptionId: null,
        activeFrom: '',
        activeTo: '',
        encryptionKeyIds: [],
      });
    });
    await flushEffects();

    await act(async () => {
      await latest?.saveNetworkEdit();
    });
    await flushEffects();

    expect(apiMock.updateNetwork).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        restoreNetwork: true,
      }),
    );
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
        status: NETWORK_STATUS_INACTIVE,
        aorIds: [1],
        unitIds: [],
        postIds: [],
        freq: '',
        modulation: 'DMR',
        encryptionId: null,
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
        status: NETWORK_STATUS_ACTIVE,
        aorIds: [1],
        unitIds: [],
        postIds: [],
        freq: '123.45',
        modulation: 'DMR',
        encryptionId: 11,
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

  it('replays a filter change after bootstrap completes', async () => {
    const firstLoad = deferred<{ list: Network[]; statusCounts: { active: number; inactive: number; archived: number } }>();
    apiMock.listNetworks.mockImplementationOnce(() => firstLoad.promise);
    apiMock.getNetworksGroupsActivity.mockResolvedValue({});

    await renderHook();
    await flushEffects();

    await act(async () => {
      latest?.setFilters((current) => ({ ...current, status: 'active' }));
    });
    await flushEffects();

    firstLoad.resolve({
      list: [buildNetwork(1), buildNetwork(2)],
      statusCounts: { active: 7, inactive: 1, archived: 1 },
    });
    await flushEffects();

    expect(apiMock.listNetworks).toHaveBeenCalledTimes(2);
    expect(apiMock.listNetworks).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        showInactive: false,
        showOnlyDeleted: false,
      }),
      expect.any(Object),
    );
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

    expect(locationReplaceSpy).toHaveBeenCalled();
    expect(String(locationReplaceSpy.mock.calls[0]?.[0] ?? '')).toContain('/login');
  });

  it('opens the top report with the current settings and loaded network ids', async () => {
    await renderHook();
    await flushEffects();

    vi.useFakeTimers();
    reportHistoryMock.fetchReportHistoryTaskStatus
      .mockResolvedValueOnce({
        running: true,
        loglines: ['backend step'],
        finishedWithError: null,
        finishedWithErrorCode: null,
      })
      .mockResolvedValueOnce({
        running: false,
        loglines: [],
        finishedWithError: null,
        finishedWithErrorCode: null,
      });

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
      const downloadPromise = latest?.downloadEtalonkaReport();
      await vi.advanceTimersByTimeAsync(1000);
      await downloadPromise;
    });
    vi.useRealTimers();

    expect(apiMock.launchNetworksEtalonkaReportTask).toHaveBeenCalledWith({
      req: {
        filterFreq: null,
        filterUnit: null,
        filterUnitArmy: null,
        filterUnitDivision: null,
        filterUnitRegiment: null,
        filterUnitBattalion: null,
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
    expect(reportHistoryMock.fetchReportHistoryTaskStatus).toHaveBeenNthCalledWith(1, 456, 0);
    expect(reportHistoryMock.fetchReportHistoryTaskStatus).toHaveBeenNthCalledWith(2, 456, 1);
    expect(apiMock.downloadNetworkEtalonkaReportTaskResult).toHaveBeenCalledWith(456);
    expect(downloadBlobMock).toHaveBeenCalledWith(expect.any(Blob), 'etalonka_2026-05-02T10-00_2026-05-03T11-30.docx');
  });

  it('uses the backend status counts', async () => {
    await renderHook();
    await flushEffects();

    expect(apiMock.listNetworks).toHaveBeenCalledWith({
      filterFreq: null,
      filterUnit: null,
      filterUnitArmy: null,
      filterUnitDivision: null,
      filterUnitRegiment: null,
      filterUnitBattalion: null,
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
        filterUnitArmy: null,
        filterUnitDivision: null,
        filterUnitRegiment: null,
        filterUnitBattalion: null,
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

    const todayKey = dayjs().startOf('day').valueOf();
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
        tillDateNoninclusiveMs: dayjs().startOf('day').add(1, 'day').valueOf(),
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
