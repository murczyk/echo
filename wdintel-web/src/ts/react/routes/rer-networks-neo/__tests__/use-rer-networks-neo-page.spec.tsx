/**
 * @vitest-environment happy-dom
 */
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AreaOfResponsibility,
  Network,
  NetworkGroupsActivitySummaryRsp,
  Unit,
} from '../../../../../Bindings';
import { HttpRequestError } from '../../../services/api/client';
import {
  NETWORK_STATUS_ACTIVE,
  NETWORK_STATUS_INACTIVE,
} from '../../rer-network-details-neo/network-status';
import { useRerNetworksNeoPage } from '../use-rer-networks-neo-page';

const apiMock = vi.hoisted(() => ({
  createNetwork: vi.fn(),
  deleteNetwork: vi.fn(),
  downloadNetworkEtalonkaReportTaskResult: vi.fn(),
  getNetworksGroupsActivitySummary: vi.fn(),
  getNetworkLastActivity: vi.fn(),
  getNetworkUnitStats: vi.fn(),
  getEncryptions: vi.fn(),
  currentSystemSettings: vi.fn(),
  listAors: vi.fn(),
  listNetworks: vi.fn(),
  listPosts: vi.fn(),
  launchNetworkEtalonkaBatchReportTask: vi.fn(),
  launchNetworksEtalonkaReportTask: vi.fn(),
  getUnitsList: vi.fn(),
  getUnitsByIds: vi.fn(),
  updateNetwork: vi.fn(),
  updateNetworkPosts: vi.fn(),
  updateNetworkUnits: vi.fn(),
}));

const bgtaskMock = vi.hoisted(() => ({
  fetchBgtaskStatusAndLogs: vi.fn(),
}));

const reportHistoryMock = vi.hoisted(() => ({
  fetchReportHistoryStatus: vi.fn(),
  fetchReportHistoryTaskStatus: vi.fn(),
  parseUtcDateTime: (value: string | null | undefined) => {
    if (value == null || value.trim() === '') return null;
    const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date;
  },
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
const browserMock = vi.hoisted(() => ({
  navigateWithinSpa: vi.fn(),
}));

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

vi.mock('../../../components/mui-customized/table/table-state-provider', () => ({
  useTableStateContext: () => tableStateMock,
}));

vi.mock('../../../services/api/aor', () => ({
  listAors: apiMock.listAors,
}));

vi.mock('../../../services/api/units', () => ({
  getUnitsList: apiMock.getUnitsList,
  getUnitsByIds: apiMock.getUnitsByIds,
  mergeUnitsById: (...unitLists: Unit[][]) => {
    const unitsById = new Map<number, Unit>();
    unitLists.flat().forEach((unit) => unitsById.set(unit.id, unit));
    return Array.from(unitsById.values());
  },
}));

vi.mock('../../../services/api/posts', () => ({
  listPosts: apiMock.listPosts,
}));

vi.mock('../../../services/api/networks', () => ({
  createNetwork: apiMock.createNetwork,
  deleteNetwork: apiMock.deleteNetwork,
  downloadNetworkEtalonkaReportTaskResult: apiMock.downloadNetworkEtalonkaReportTaskResult,
  getNetworksGroupsActivitySummary: apiMock.getNetworksGroupsActivitySummary,
  getNetworkLastActivity: apiMock.getNetworkLastActivity,
  getNetworkUnitStats: apiMock.getNetworkUnitStats,
  listNetworks: apiMock.listNetworks,
  launchNetworkEtalonkaBatchReportTask: apiMock.launchNetworkEtalonkaBatchReportTask,
  launchNetworksEtalonkaReportTask: apiMock.launchNetworksEtalonkaReportTask,
  updateNetwork: apiMock.updateNetwork,
  updateNetworkPosts: apiMock.updateNetworkPosts,
  updateNetworkUnits: apiMock.updateNetworkUnits,
}));

vi.mock('../../../utils/browser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/browser')>();
  return {
    ...actual,
    navigateWithinSpa: browserMock.navigateWithinSpa,
  };
});

vi.mock('../../../services/api/bgtask', () => ({
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

vi.mock('../../../services/api/report-history', () => ({
  fetchReportHistoryStatus: reportHistoryMock.fetchReportHistoryStatus,
  fetchReportHistoryTaskStatus: reportHistoryMock.fetchReportHistoryTaskStatus,
  isCancelledReportHistory: (row: { status: string; lastError: string | null | undefined }) =>
    row.status === 'failed' && (row.lastError ?? '').includes('Скасовано користувачем'),
  isCancelledReportHistoryError: (value: string | null | undefined) =>
    value?.includes('Скасовано користувачем') ?? false,
  parseUtcDateTime: reportHistoryMock.parseUtcDateTime,
}));

vi.mock('../../../services/api/encryptions', () => ({
  getEncryptions: apiMock.getEncryptions,
}));

vi.mock('../../../services/api/system-settings', () => ({
  currentSystemSettings: apiMock.currentSystemSettings,
}));

vi.mock('../../../utils/download-blob', () => ({
  downloadBlob: downloadBlobMock,
}));

type HookResult = ReturnType<typeof useRerNetworksNeoPage>;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: HookResult | null = null;
let locationReplaceSpy: any = null;
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
    lastActivityAt: null,
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
    reportHistoryMock.fetchReportHistoryStatus.mockReset();
    reportHistoryMock.fetchReportHistoryTaskStatus.mockReset();
    apiMock.getNetworksGroupsActivitySummary.mockReset();
    apiMock.getNetworkLastActivity.mockReset();
    apiMock.getNetworkUnitStats.mockReset();
    apiMock.getEncryptions.mockReset();
    apiMock.currentSystemSettings.mockReset();
    apiMock.listAors.mockReset();
    apiMock.listNetworks.mockReset();
    apiMock.listPosts.mockReset();
    apiMock.getUnitsList.mockReset();
    apiMock.getUnitsByIds.mockReset();
    apiMock.updateNetwork.mockReset();
    apiMock.updateNetworkPosts.mockReset();
    apiMock.updateNetworkUnits.mockReset();

    apiMock.listAors.mockResolvedValue([buildAor(1, 'AOR 1')]);
    apiMock.getUnitsList.mockResolvedValue([buildUnit(1, 'Unit 1')]);
    apiMock.getUnitsByIds.mockResolvedValue([]);
    apiMock.getNetworkUnitStats.mockResolvedValue([]);
    apiMock.listPosts.mockResolvedValue([]);
    apiMock.getNetworksGroupsActivitySummary.mockResolvedValue({
      activity: {},
      lastActivityAt: {},
    });
    apiMock.getNetworkLastActivity.mockResolvedValue([]);
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
    browserMock.navigateWithinSpa.mockReset();
    authUserRoles = ['Rer', 'Full'];

    locationReplaceSpy = vi.spyOn(window.location, 'replace').mockImplementation(() => undefined);
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
    vi.useRealTimers();
  });

  // @test-scope safeguard: prevents an edited network from retaining stale relations.
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

  // @test-scope safeguard: prevents an edited network outside the active filter from remaining visible.
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

  // @test-scope safeguard: prevents a filter change during bootstrap from being lost.
  it('replays a filter change after bootstrap completes', async () => {
    const firstLoad = deferred<{
      list: Network[];
      statusCounts: { active: number; inactive: number; archived: number };
    }>();
    apiMock.listNetworks.mockImplementationOnce(() => firstLoad.promise);
    apiMock.getNetworksGroupsActivitySummary.mockResolvedValue({
      activity: {},
      lastActivityAt: {},
    });

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

  // @test-scope safeguard: prevents unauthorized network data from remaining accessible.
  it('redirects to login on unauthorized network load', async () => {
    apiMock.listNetworks.mockRejectedValueOnce(new HttpRequestError(401, 'unauthorized'));

    await renderHook();
    await flushEffects();

    expect(locationReplaceSpy).toHaveBeenCalled();
    expect(String(locationReplaceSpy.mock.calls[0]?.[0] ?? '')).toContain('/login');
  });

  // @test-scope safeguard: prevents a cancellation race from downloading a cancelled report.
  it('shows the cancelled message when cancellation races with bgtask polling', async () => {
    await renderHook();
    await flushEffects();

    vi.useFakeTimers();
    reportHistoryMock.fetchReportHistoryStatus.mockReset();
    reportHistoryMock.fetchReportHistoryStatus
      .mockResolvedValueOnce({
        id: 456,
        reportKind: 'etalonka',
        requestedBy: 'tester',
        createdAt: '2026-05-01T10:00:00',
        startedAt: '2026-05-01T10:00:01',
        plannedForTs: null,
        queuePosition: null,
        status: 'in_progress',
        completedAt: null,
        hasFile: false,
        fileName: null,
        contentType: null,
        bgtaskId: 77,
        lastError: null,
        details: '',
        progress: 45,
        errorLog: null,
      })
      .mockResolvedValueOnce({
        id: 456,
        reportKind: 'etalonka',
        requestedBy: 'tester',
        createdAt: '2026-05-01T10:00:00',
        startedAt: '2026-05-01T10:00:01',
        plannedForTs: null,
        queuePosition: null,
        status: 'failed',
        completedAt: '2026-05-01T10:00:10',
        hasFile: false,
        fileName: null,
        contentType: null,
        bgtaskId: 77,
        lastError: 'Скасовано користувачем',
        details: '',
        progress: 45,
        errorLog: null,
      });
    bgtaskMock.fetchBgtaskStatusAndLogs.mockReset();
    bgtaskMock.fetchBgtaskStatusAndLogs.mockResolvedValueOnce({
      running: false,
      loglines: [],
      finishedWithError: 'BL { msg: "Скасовано користувачем" }',
      finishedWithErrorCode: null,
      progress: 45,
    });
    apiMock.downloadNetworkEtalonkaReportTaskResult.mockReset();

    await act(async () => {
      const downloadPromise = latest?.runDownload('etalonka');
      await downloadPromise;
    });
    vi.useRealTimers();

    expect(reportHistoryMock.fetchReportHistoryStatus).toHaveBeenCalledTimes(2);
    expect(latest?.status).toEqual({ kind: 'info', text: 'Звіт скасовано в Моїх звітах.' });
    expect(latest?.etalonkaReport.running).toBe(false);
    expect(latest?.etalonkaReport.error).toBe('Звіт скасовано в Моїх звітах.');
    expect(apiMock.downloadNetworkEtalonkaReportTaskResult).not.toHaveBeenCalled();
  });

  // @test-scope safeguard: prevents a failed query from becoming permanently unreloadable.
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

  // @test-scope regression: https://github.com/echoua/echo/pull/3489
  it('uses precise visible activity from the chart response', async () => {
    const cachedLastActivityAt = Date.now() - 24 * 60 * 60 * 1000;
    const visibleLastActivityAt = cachedLastActivityAt - 60 * 60 * 1000;
    apiMock.listNetworks.mockResolvedValueOnce({
      list: [buildNetwork(1, { lastActivityAt: cachedLastActivityAt }), buildNetwork(2)],
      statusCounts: { active: 2, inactive: 0, archived: 0 },
    });
    apiMock.getNetworksGroupsActivitySummary.mockResolvedValueOnce({
      activity: {},
      lastActivityAt: { 1: visibleLastActivityAt },
    });

    await renderHook();
    await flushEffects();

    expect(latest?.rows[0]?.lastActivityLabel).toBe(
      dayjs(visibleLastActivityAt).format('DD.MM.YY HH:mm'),
    );
    expect(latest?.rows[0]?.network.lastActivityAt).toBe(cachedLastActivityAt);
    expect(latest?.rows[1]?.lastActivityDetail).toBe('Немає перехоплень за останні 10 днів');
    expect(apiMock.getNetworkLastActivity).not.toHaveBeenCalled();
  });

  // @test-scope safeguard: prevents pagination from leaving first-page activity permanently loading.
  it('settles first-page activity after pagination starts', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => buildNetwork(index + 1));
    const initialActivity = deferred<NetworkGroupsActivitySummaryRsp>();
    apiMock.listNetworks.mockResolvedValueOnce({
      list: firstPage,
      statusCounts: { active: 100, inactive: 0, archived: 0 },
    });
    apiMock.listNetworks.mockResolvedValueOnce({
      list: [buildNetwork(101)],
      statusCounts: { active: 101, inactive: 0, archived: 0 },
    });
    apiMock.getNetworksGroupsActivitySummary.mockImplementationOnce(() => initialActivity.promise);

    await renderHook();
    await flushEffects();

    await act(async () => {
      await latest?.loadMoreNetworks();
    });
    expect(latest?.rows[0]?.activityLoadState).toBe('loading');

    await act(async () => {
      initialActivity.resolve({ activity: {}, lastActivityAt: {} });
      await initialActivity.promise;
    });
    await vi.waitFor(() => expect(latest?.rows[0]?.activityLoadState).toBe('loaded'));
  });

  // @test-scope regression: https://github.com/echoua/echo/issues/3329
  it('does not abort page-two activity when page three starts loading', async () => {
    const pageOne = Array.from({ length: 100 }, (_, index) => buildNetwork(index + 1));
    const pageTwo = Array.from({ length: 100 }, (_, index) => buildNetwork(index + 101));
    const pageTwoActivity = deferred<NetworkGroupsActivitySummaryRsp>();
    apiMock.listNetworks.mockResolvedValueOnce({
      list: pageOne,
      statusCounts: { active: 100, inactive: 0, archived: 0 },
    });
    apiMock.listNetworks.mockResolvedValueOnce({
      list: pageTwo,
      statusCounts: { active: 200, inactive: 0, archived: 0 },
    });
    apiMock.listNetworks.mockResolvedValueOnce({
      list: [buildNetwork(201)],
      statusCounts: { active: 201, inactive: 0, archived: 0 },
    });
    apiMock.getNetworksGroupsActivitySummary
      .mockResolvedValueOnce({ activity: {}, lastActivityAt: {} })
      .mockImplementationOnce(() => pageTwoActivity.promise)
      .mockResolvedValueOnce({ activity: {}, lastActivityAt: {} });

    await renderHook();
    await flushEffects();
    await act(async () => {
      await latest?.loadMoreNetworks();
    });
    expect(latest?.rows[100]?.lastActivityLabel).toBe('Завантаження…');
    await act(async () => {
      await latest?.loadMoreNetworks();
    });

    const pageTwoActivityCall = apiMock.getNetworksGroupsActivitySummary.mock.results[1];
    expect(pageTwoActivityCall).toBeDefined();
    const pageTwoSignal = apiMock.getNetworksGroupsActivitySummary.mock.calls[1]?.[1]?.signal;
    expect(pageTwoSignal?.aborted).toBe(false);

    await act(async () => {
      pageTwoActivity.resolve({ activity: {}, lastActivityAt: {} });
      await pageTwoActivity.promise;
    });
    await vi.waitFor(() => expect(latest?.rows[100]?.activityLoadState).toBe('loaded'));
    expect(latest?.rows[100]?.lastActivityDetail).toBe('Немає перехоплень за останні 10 днів');
  });

  // @test-scope regression: https://github.com/echoua/echo/issues/3329
  it('ignores activity from a replaced list query', async () => {
    const oldActivity = deferred<NetworkGroupsActivitySummaryRsp>();
    const newActivity = deferred<NetworkGroupsActivitySummaryRsp>();
    apiMock.getNetworksGroupsActivitySummary
      .mockImplementationOnce(() => oldActivity.promise)
      .mockImplementationOnce(() => newActivity.promise);
    apiMock.listNetworks.mockResolvedValueOnce({
      list: [buildNetwork(1), buildNetwork(2)],
      statusCounts: { active: 2, inactive: 0, archived: 0 },
    });
    apiMock.listNetworks.mockResolvedValueOnce({
      list: [buildNetwork(3)],
      statusCounts: { active: 1, inactive: 0, archived: 0 },
    });

    await renderHook();
    await flushEffects();

    await act(async () => {
      latest?.setFilters((current) => ({ ...current, status: 'active' }));
    });
    await flushEffects();
    expect(latest?.rows.map((row) => row.id)).toEqual([3]);
    expect(latest?.rows[0]?.activityLoadState).toBe('loading');

    await act(async () => {
      oldActivity.resolve({ activity: {}, lastActivityAt: {} });
      await oldActivity.promise;
    });
    await flushEffects();
    expect(latest?.rows[0]?.activityLoadState).toBe('loading');

    await act(async () => {
      newActivity.resolve({ activity: {}, lastActivityAt: {} });
      await newActivity.promise;
    });
    await vi.waitFor(() => expect(latest?.rows[0]?.activityLoadState).toBe('loaded'));
  });

  // @test-scope regression: https://github.com/echoua/echo/issues/3329
  it('marks every requested network as activity error without rendering inactivity', async () => {
    apiMock.getNetworksGroupsActivitySummary.mockRejectedValueOnce(
      new Error('activity unavailable'),
    );

    await renderHook();
    await vi.waitFor(() =>
      expect(latest?.rows.every((row) => row.activityLoadState === 'error')).toBe(true),
    );
    expect(latest?.rows.every((row) => row.activityLoadState !== 'loaded')).toBe(true);
    expect(latest?.rows.every((row) => row.lastActivityLabel === 'Не вдалося завантажити')).toBe(
      true,
    );
    expect(latest?.status?.text).toContain('activity unavailable');
  });

  // @test-scope safeguard: prevents authorized UnitsEditor users from being denied network mutations.
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

  // @test-scope safeguard: prevents a soft-deleted network from remaining in the active list.
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
