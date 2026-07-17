/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  InboxMessage,
  Network,
  NewCallsignsRes,
  SignalGroupEntry,
  SignalProfileEntry,
  Tag,
  Unit,
} from '../../../../Bindings';
import { emptyQueryState } from './helpers';
import { useAnalysisReloadOrchestrator } from './use-analysis-reload-orchestrator';
import type { UseAnalysisReloadOrchestratorResult } from './use-analysis-reload-orchestrator';
import type {
  AnalysisAorEntry,
  AnalysisCenterTab,
  AnalysisCountItem,
  AnalysisFilterOptions,
  AnalysisFilterSectionId,
  AnalysisQueryState,
  AnalysisSidebarTab,
} from './types';

const reloadAnalysisDataMock = vi.hoisted(() => ({
  reloadAnalysisData: vi.fn(() => Promise.resolve()),
}));

vi.mock('./use-analysis-data.reload', () => reloadAnalysisDataMock);

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latestResult: UseAnalysisReloadOrchestratorResult | null = null;

function buildQueryState(): AnalysisQueryState {
  return {
    ...emptyQueryState(),
    fromDateTimeStr: '2026-06-01T10:00',
    toDateTimeStr: '2026-06-01T11:00',
    sinceDateInclusiveMs: 1,
    tillDateNoninclusiveMs: 2,
  };
}

function buildParams(overrides: Partial<Parameters<typeof useAnalysisReloadOrchestrator>[0]> = {}) {
  const queryState = buildQueryState();
  const noopSetter = vi.fn();
  const base = {
    centerTab: 'messages' as AnalysisCenterTab,
    deferInitialLoad: false,
    newestFirst: true,
    onError: vi.fn(),
    onUnauthorized: vi.fn(() => false),
    queryState,
    rightSidebarTab: null as AnalysisSidebarTab | null,
    rightSidebarVisible: false,
    reloadTriggerKey: 'reload-key-1',
    shouldLoadNewCallsigns: false,
    optionsFreqValuesRef: { current: [] as string[] },
    getLoadedFilterSections: vi.fn(() => [] as AnalysisFilterSectionId[]),
    getReloadFilterSections: vi.fn(() => [] as AnalysisFilterSectionId[]),
    invalidateFilterSectionLoads: vi.fn(),
    invalidateFilterSectionLoadsForPatch: vi.fn(),
    loadInitialFilterSections: vi.fn().mockResolvedValue(undefined),
    invalidateCallsignGraph: vi.fn(),
    invalidateCorrelatedFreqsCache: vi.fn(),
    invalidateRightSidebarData: vi.fn(),
    invalidateSummaryData: vi.fn(),
    loadMapPalitras: vi.fn().mockResolvedValue(undefined),
    loadSummaryData: vi.fn().mockResolvedValue(undefined),
    loadTopSidebarData: vi.fn().mockResolvedValue(undefined),
    clearAnalysisResults: vi.fn(),
    loadMessageComments: vi.fn().mockResolvedValue(undefined),
    getCurrentMessagePageCursor: vi.fn(() => ({
      beforeIdNoninclusive: 120,
      sinceIdNoninclusive: null,
    })),
    invalidateMessagePageRequests: vi.fn(),
    invalidateMessagePaging: vi.fn(),
    setAorEntries: noopSetter as Dispatch<SetStateAction<AnalysisAorEntry[]>>,
    setCounts: noopSetter as Dispatch<
      SetStateAction<import('../../../../Bindings').CountStatsRsp | null>
    >,
    setCountsLoading: noopSetter as Dispatch<SetStateAction<boolean>>,
    setFiltersLoading: noopSetter as Dispatch<SetStateAction<boolean>>,
    setGroupInfos: noopSetter as Dispatch<SetStateAction<Record<string, SignalGroupEntry>>>,
    setMapLoading: noopSetter as Dispatch<SetStateAction<boolean>>,
    setMapDateRange: noopSetter as Dispatch<SetStateAction<{ startDate: number; endDate: number }>>,
    setMapNetworkUnits: noopSetter as Dispatch<
      SetStateAction<import('../../../../Bindings').NetworkUnit[]>
    >,
    setMapOpenMessages: noopSetter as Dispatch<SetStateAction<Array<[number, InboxMessage]>>>,
    setMapPoints: noopSetter as Dispatch<
      SetStateAction<import('../../../../Bindings').FreqDetailedPoint[]>
    >,
    setMessages: noopSetter as Dispatch<SetStateAction<Array<[number, InboxMessage]>>>,
    setMessagesLoading: noopSetter as Dispatch<SetStateAction<boolean>>,
    setNetworks: noopSetter as Dispatch<SetStateAction<Network[]>>,
    setNewCallsigns: noopSetter as Dispatch<SetStateAction<NewCallsignsRes>>,
    setNewCallsignsLoading: noopSetter as Dispatch<SetStateAction<boolean>>,
    setNewCallsignsLoadedKey: vi.fn(),
    newCallsignsRequestRef: { current: 0 },
    newCallsignsLoadedKeyRef: { current: null as string | null },
    newCallsignsPendingKeyRef: { current: null as string | null },
    setNoMoreToLoad: noopSetter as Dispatch<SetStateAction<boolean>>,
    setNolimitShown: noopSetter as Dispatch<SetStateAction<boolean>>,
    setOptions: noopSetter as Dispatch<SetStateAction<AnalysisFilterOptions>>,
    setProfiles: noopSetter as Dispatch<SetStateAction<Record<string, SignalProfileEntry | null>>>,
    setSummaryCallsignsInfo: noopSetter as Dispatch<
      SetStateAction<Record<string, import('../../../../Bindings').CallsignInfoRes>>
    >,
    setTagsMap: noopSetter as Dispatch<SetStateAction<Record<number, Tag>>>,
    setTopCallsigns: noopSetter as Dispatch<SetStateAction<AnalysisCountItem[]>>,
    setTopFreqs: noopSetter as Dispatch<SetStateAction<AnalysisCountItem[]>>,
    setTopLocations: noopSetter as Dispatch<SetStateAction<AnalysisCountItem[]>>,
    setTopUnits: noopSetter as Dispatch<SetStateAction<AnalysisCountItem[]>>,
    setUnitsMap: noopSetter as Dispatch<SetStateAction<Record<number, Unit>>>,
    setHasLoadedInitialMessages: noopSetter as Dispatch<SetStateAction<boolean>>,
  };

  return { ...base, ...overrides } as Parameters<typeof useAnalysisReloadOrchestrator>[0];
}

function Harness(props: Parameters<typeof useAnalysisReloadOrchestrator>[0]) {
  latestResult = useAnalysisReloadOrchestrator(props);
  return null;
}

async function renderHook(props: Parameters<typeof useAnalysisReloadOrchestrator>[0]) {
  if (container == null) throw new Error('container not initialized');

  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(Harness, props));
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function rerenderHook(props: Parameters<typeof useAnalysisReloadOrchestrator>[0]) {
  await act(async () => {
    root?.render(createElement(Harness, props));
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  reloadAnalysisDataMock.reloadAnalysisData.mockClear();
  latestResult = null;
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  vi.useRealTimers();
});

describe('useAnalysisReloadOrchestrator', () => {
  it('runs the initial reload immediately', async () => {
    vi.useFakeTimers();
    const params = buildParams();

    await renderHook(params);

    expect(reloadAnalysisDataMock.reloadAnalysisData).toHaveBeenCalledTimes(1);
  });

  it('preserves the current message cursor for a manual page refresh', async () => {
    const params = buildParams();
    await renderHook(params);
    reloadAnalysisDataMock.reloadAnalysisData.mockClear();

    await act(async () => {
      await latestResult?.reload({ preserveMessagePage: true });
    });

    expect(reloadAnalysisDataMock.reloadAnalysisData).toHaveBeenCalledWith(
      expect.objectContaining({
        invalidateMessagePaging: params.invalidateMessagePageRequests,
        messagePageCursor: {
          beforeIdNoninclusive: 120,
          sinceIdNoninclusive: null,
        },
      }),
    );
    expect(params.getCurrentMessagePageCursor).toHaveBeenCalledTimes(1);
  });

  it('loads map palitras on initial eligible load', async () => {
    const params = buildParams({
      queryState: { ...buildQueryState(), search: '47.42135, 35.62197' },
    });

    await renderHook(params);

    expect(params.loadMapPalitras).toHaveBeenCalledTimes(1);
  });

  it('does not reload map palitras when only the search query changes', async () => {
    const params = buildParams();

    await renderHook(params);
    expect(params.loadMapPalitras).toHaveBeenCalledTimes(1);

    await rerenderHook({
      ...params,
      queryState: { ...params.queryState, search: '47.42135, 35.62197' },
    });

    expect(params.loadMapPalitras).toHaveBeenCalledTimes(1);
  });

  it('reloads map palitras when the callback changes', async () => {
    const params = buildParams();

    await renderHook(params);
    expect(params.loadMapPalitras).toHaveBeenCalledTimes(1);

    const nextLoadMapPalitras = vi.fn().mockResolvedValue(undefined);
    await rerenderHook({
      ...params,
      loadMapPalitras: nextLoadMapPalitras,
    });

    expect(nextLoadMapPalitras).toHaveBeenCalledTimes(1);
  });

  it('debounces rapid reload trigger updates and keeps only the latest reload', async () => {
    vi.useFakeTimers();
    const params = buildParams();

    await renderHook(params);
    expect(reloadAnalysisDataMock.reloadAnalysisData).toHaveBeenCalledTimes(1);

    await rerenderHook({
      ...params,
      reloadTriggerKey: 'reload-key-2',
      queryState: { ...params.queryState, search: 'alpha' },
    });
    await rerenderHook({
      ...params,
      reloadTriggerKey: 'reload-key-3',
      queryState: { ...params.queryState, search: 'bravo' },
    });

    expect(reloadAnalysisDataMock.reloadAnalysisData).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(199);
    });
    expect(reloadAnalysisDataMock.reloadAnalysisData).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
    });

    expect(reloadAnalysisDataMock.reloadAnalysisData).toHaveBeenCalledTimes(2);
    expect(reloadAnalysisDataMock.reloadAnalysisData.mock.calls[1]?.[0]?.queryState).toMatchObject({
      search: 'bravo',
    });
  });

  it('reschedules an aborted key when the user reverts before the debounce fires', async () => {
    vi.useFakeTimers();
    let resolveInitialReload: (() => void) | null = null;
    const initialReload = new Promise<void>((resolve) => {
      resolveInitialReload = resolve;
    });
    reloadAnalysisDataMock.reloadAnalysisData.mockImplementationOnce(() => initialReload);

    const params = buildParams({
      queryState: { ...buildQueryState(), search: 'alpha' },
      reloadTriggerKey: 'reload-key-alpha',
    });

    await renderHook(params);
    const firstSignal = reloadAnalysisDataMock.reloadAnalysisData.mock.calls[0]?.[0].signal as
      AbortSignal | undefined;
    expect(firstSignal).toBeDefined();
    expect(firstSignal?.aborted).toBe(false);

    await rerenderHook({
      ...params,
      reloadTriggerKey: 'reload-key-bravo',
      queryState: { ...params.queryState, search: 'bravo' },
    });

    expect(firstSignal?.aborted).toBe(true);
    expect(reloadAnalysisDataMock.reloadAnalysisData).toHaveBeenCalledTimes(1);

    await rerenderHook({
      ...params,
      queryState: { ...params.queryState, search: 'alpha' },
    });

    expect(reloadAnalysisDataMock.reloadAnalysisData).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
      await Promise.resolve();
    });

    expect(reloadAnalysisDataMock.reloadAnalysisData).toHaveBeenCalledTimes(2);
    expect(reloadAnalysisDataMock.reloadAnalysisData.mock.calls[1]?.[0]?.queryState).toMatchObject({
      search: 'alpha',
    });

    await act(async () => {
      resolveInitialReload?.();
      await initialReload;
      await Promise.resolve();
    });
  });

  it('blocks summary reloads until the debounced reload settles', async () => {
    vi.useFakeTimers();
    let resolveNextReload: (() => void) | null = null;
    const nextReload = new Promise<void>((resolve) => {
      resolveNextReload = resolve;
    });
    const initialLoadSummaryData = vi.fn().mockResolvedValue(undefined);
    const nextLoadSummaryData = vi.fn().mockResolvedValue(undefined);
    const params = buildParams({ centerTab: 'summary', loadSummaryData: initialLoadSummaryData });

    await renderHook(params);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(reloadAnalysisDataMock.reloadAnalysisData).toHaveBeenCalledTimes(1);
    expect(initialLoadSummaryData).toHaveBeenCalledTimes(1);

    reloadAnalysisDataMock.reloadAnalysisData.mockImplementationOnce(() => nextReload);

    await rerenderHook({
      ...params,
      reloadTriggerKey: 'reload-key-2',
      queryState: { ...params.queryState, search: 'alpha' },
    });

    expect(initialLoadSummaryData).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
      await Promise.resolve();
    });

    expect(reloadAnalysisDataMock.reloadAnalysisData).toHaveBeenCalledTimes(2);
    expect(initialLoadSummaryData).toHaveBeenCalledTimes(1);

    await rerenderHook({
      ...params,
      loadSummaryData: nextLoadSummaryData,
      reloadTriggerKey: 'reload-key-2',
      queryState: { ...params.queryState, search: 'alpha' },
    });

    expect(nextLoadSummaryData).toHaveBeenCalledTimes(0);

    await act(async () => {
      resolveNextReload?.();
      await nextReload;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(nextLoadSummaryData).toHaveBeenCalledTimes(1);
  });

  it('aborts the previous reload when a newer reload starts', async () => {
    vi.useFakeTimers();
    let resolveFirstReload: (() => void) | null = null;
    const firstReload = new Promise<void>((resolve) => {
      resolveFirstReload = resolve;
    });
    reloadAnalysisDataMock.reloadAnalysisData.mockImplementationOnce(() => firstReload);

    const params = buildParams();

    await renderHook(params);
    const firstSignal = reloadAnalysisDataMock.reloadAnalysisData.mock.calls[0]?.[0].signal as
      AbortSignal | undefined;
    expect(firstSignal).toBeDefined();
    expect(firstSignal?.aborted).toBe(false);

    await rerenderHook({
      ...params,
      reloadTriggerKey: 'reload-key-2',
      queryState: { ...params.queryState, search: 'alpha' },
    });
    expect(firstSignal?.aborted).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
      await Promise.resolve();
    });

    const secondSignal = reloadAnalysisDataMock.reloadAnalysisData.mock.calls[1]?.[0].signal as
      AbortSignal | undefined;
    expect(reloadAnalysisDataMock.reloadAnalysisData).toHaveBeenCalledTimes(2);
    expect(firstSignal?.aborted).toBe(true);
    expect(secondSignal).toBeDefined();
    expect(secondSignal?.aborted).toBe(false);

    await act(async () => {
      resolveFirstReload?.();
      await firstReload;
      await Promise.resolve();
    });
  });

  it('aborts the active reload and clears pending debounce timers on unmount', async () => {
    vi.useFakeTimers();
    let resolveFirstReload: (() => void) | null = null;
    const firstReload = new Promise<void>((resolve) => {
      resolveFirstReload = resolve;
    });
    reloadAnalysisDataMock.reloadAnalysisData.mockImplementationOnce(() => firstReload);

    const params = buildParams();

    await renderHook(params);
    const firstSignal = reloadAnalysisDataMock.reloadAnalysisData.mock.calls[0]?.[0].signal as
      AbortSignal | undefined;
    expect(firstSignal).toBeDefined();

    await rerenderHook({
      ...params,
      reloadTriggerKey: 'reload-key-2',
      queryState: { ...params.queryState, search: 'alpha' },
    });

    act(() => {
      root?.unmount();
    });

    expect(firstSignal?.aborted).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(reloadAnalysisDataMock.reloadAnalysisData).toHaveBeenCalledTimes(1);

    resolveFirstReload?.();
    await act(async () => {
      await firstReload;
      await Promise.resolve();
    });
  });

  it('clears pending summary reload state when unmounted during debounce', async () => {
    vi.useFakeTimers();
    const loadSummaryData = vi.fn().mockResolvedValue(undefined);
    const params = buildParams({ centerTab: 'summary', loadSummaryData });

    await renderHook(params);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(loadSummaryData).toHaveBeenCalledTimes(1);

    await rerenderHook({
      ...params,
      reloadTriggerKey: 'reload-key-2',
      queryState: { ...params.queryState, search: 'alpha' },
    });

    act(() => {
      root?.unmount();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();
    });

    expect(reloadAnalysisDataMock.reloadAnalysisData).toHaveBeenCalledTimes(1);
    expect(loadSummaryData).toHaveBeenCalledTimes(1);
  });

  it('reloads when the map becomes visible even if the trigger key stays the same', async () => {
    const params = buildParams();

    await renderHook(params);
    expect(reloadAnalysisDataMock.reloadAnalysisData).toHaveBeenCalledTimes(1);
    expect(reloadAnalysisDataMock.reloadAnalysisData.mock.calls[0]?.[0]).toMatchObject({
      rightSidebarVisible: false,
      rightSidebarTab: null,
    });

    await rerenderHook({
      ...params,
      rightSidebarVisible: true,
      rightSidebarTab: 'map',
      queryState: { ...params.queryState },
    });

    expect(reloadAnalysisDataMock.reloadAnalysisData).toHaveBeenCalledTimes(2);
    expect(reloadAnalysisDataMock.reloadAnalysisData.mock.calls[1]?.[0]).toMatchObject({
      rightSidebarVisible: true,
      rightSidebarTab: 'map',
    });
  });

  it('retries the map reload after the initial summary reload settles', async () => {
    let resolveInitialReload: (() => void) | null = null;
    const initialReload = new Promise<void>((resolve) => {
      resolveInitialReload = resolve;
    });
    reloadAnalysisDataMock.reloadAnalysisData.mockImplementationOnce(() => initialReload);

    const params = buildParams();

    await renderHook(params);
    expect(reloadAnalysisDataMock.reloadAnalysisData).toHaveBeenCalledTimes(1);

    await rerenderHook({
      ...params,
      rightSidebarVisible: true,
      rightSidebarTab: 'map',
      queryState: { ...params.queryState },
    });

    expect(reloadAnalysisDataMock.reloadAnalysisData).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveInitialReload?.();
      await initialReload;
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(reloadAnalysisDataMock.reloadAnalysisData).toHaveBeenCalledTimes(2);
    expect(reloadAnalysisDataMock.reloadAnalysisData.mock.calls[1]?.[0]).toMatchObject({
      rightSidebarVisible: true,
      rightSidebarTab: 'map',
    });
  });
});
