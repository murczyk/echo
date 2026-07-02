/**
 * @vitest-environment happy-dom
 */
import { act, createElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CallsignInfoRes } from '../../../../Bindings';
import { emptyQueryState } from './helpers';
import { useAnalysisSidebarData } from './use-analysis-sidebar-data';

const apiMocks = vi.hoisted(() => ({
  fetchAnalysisCallsignGraph: vi.fn(),
  fetchAnalysisCorrelatedFreqs: vi.fn(),
  fetchAnalysisCallsignInfos: vi.fn(),
  fetchAnalysisCallsigns: vi.fn(),
  fetchAnalysisLocations: vi.fn(),
  fetchAnalysisSummaryTable: vi.fn(),
  fetchAnalysisUnits: vi.fn(),
}));

vi.mock('../../services/api/analysis', async () => {
  const actual = await vi.importActual<typeof import('../../services/api/analysis')>(
    '../../services/api/analysis',
  );
  return {
    ...actual,
    fetchAnalysisCallsignGraph: apiMocks.fetchAnalysisCallsignGraph,
    fetchAnalysisCorrelatedFreqs: apiMocks.fetchAnalysisCorrelatedFreqs,
    fetchAnalysisCallsignInfos: apiMocks.fetchAnalysisCallsignInfos,
    fetchAnalysisCallsigns: apiMocks.fetchAnalysisCallsigns,
    fetchAnalysisLocations: apiMocks.fetchAnalysisLocations,
    fetchAnalysisSummaryTable: apiMocks.fetchAnalysisSummaryTable,
    fetchAnalysisUnits: apiMocks.fetchAnalysisUnits,
  };
});

type HookResult = ReturnType<typeof useAnalysisSidebarData>;

type HarnessProps = {
  queryState: ReturnType<typeof buildQueryState>;
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: HookResult | null = null;

function buildQueryState(search = '') {
  return {
    ...emptyQueryState(),
    fromDateTimeStr: '2026-04-01T00:00',
    toDateTimeStr: '2026-04-02T00:00',
    search,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function Harness({ queryState }: HarnessProps) {
  const summaryCallsignsInfoRef = useRef<Record<string, CallsignInfoRes>>({});
  latest = useAnalysisSidebarData({
    onError: vi.fn(),
    onUnauthorized: vi.fn(() => false),
    optionsFreqValues: ['100.0000'],
    queryState,
    summaryCallsignsInfoRef,
    setSummaryCallsignsInfo: vi.fn(),
  });
  return null;
}

async function renderHook(queryState = buildQueryState(null)) {
  if (container == null) throw new Error('container not initialized');

  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(Harness, { queryState }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function rerenderHook(queryState = buildQueryState(null)) {
  await act(async () => {
    root?.render(createElement(Harness, { queryState }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  latest = null;
  apiMocks.fetchAnalysisCallsignGraph.mockReset();
  apiMocks.fetchAnalysisCorrelatedFreqs.mockReset();
  apiMocks.fetchAnalysisCallsignInfos.mockReset();
  apiMocks.fetchAnalysisCallsigns.mockReset();
  apiMocks.fetchAnalysisLocations.mockReset();
  apiMocks.fetchAnalysisSummaryTable.mockReset();
  apiMocks.fetchAnalysisUnits.mockReset();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

describe('useAnalysisSidebarData', () => {
  it('aborts the previous summary load when a newer query arrives', async () => {
    const firstLoad = deferred<{ rows: [] }>();
    const secondLoad = deferred<{ rows: [] }>();
    apiMocks.fetchAnalysisSummaryTable.mockImplementationOnce(() => firstLoad.promise);
    apiMocks.fetchAnalysisSummaryTable.mockImplementationOnce(() => secondLoad.promise);

    await renderHook(buildQueryState());

    act(() => {
      void latest?.loadSummaryData();
    });
    const firstSignal = apiMocks.fetchAnalysisSummaryTable.mock.calls[0]?.[1]?.signal as
      AbortSignal | undefined;
    expect(firstSignal).toBeDefined();
    expect(firstSignal?.aborted).toBe(false);

    await act(async () => {
      root?.render(createElement(Harness, { queryState: buildQueryState('next') }));
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      void latest?.loadSummaryData();
    });
    const secondSignal = apiMocks.fetchAnalysisSummaryTable.mock.calls[1]?.[1]?.signal as
      AbortSignal | undefined;

    expect(firstSignal?.aborted).toBe(true);
    expect(secondSignal).toBeDefined();
    expect(secondSignal?.aborted).toBe(false);

    firstLoad.resolve({ rows: [] });
    secondLoad.resolve({ rows: [] });
    await act(async () => {
      await Promise.resolve();
    });
  });

  it('re-requests pending callsign infos after the previous summary batch aborts', async () => {
    apiMocks.fetchAnalysisSummaryTable.mockResolvedValue({ rows: [{ callsigns: ['alpha'] }] });
    const firstCallsignInfos = deferred<Array<CallsignInfoRes>>();
    const secondCallsignInfos = deferred<Array<CallsignInfoRes>>();
    apiMocks.fetchAnalysisCallsignInfos
      .mockImplementationOnce(() => firstCallsignInfos.promise)
      .mockImplementationOnce(() => secondCallsignInfos.promise);

    const setSummaryCallsignsInfo = vi.fn();

    function HarnessWithSpy({ queryState }: HarnessProps) {
      const summaryCallsignsInfoRef = useRef<Record<string, CallsignInfoRes>>({});
      latest = useAnalysisSidebarData({
        onError: vi.fn(),
        onUnauthorized: vi.fn(() => false),
        optionsFreqValues: ['100.0000'],
        queryState,
        summaryCallsignsInfoRef,
        setSummaryCallsignsInfo,
      });
      return null;
    }

    await act(async () => {
      root = createRoot(container as HTMLDivElement);
      root.render(createElement(HarnessWithSpy, { queryState: buildQueryState() }));
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      void latest?.loadSummaryData();
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMocks.fetchAnalysisCallsignInfos).toHaveBeenCalledTimes(1);

    await act(async () => {
      root?.render(createElement(HarnessWithSpy, { queryState: buildQueryState('next') }));
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      void latest?.loadSummaryData();
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMocks.fetchAnalysisCallsignInfos).toHaveBeenCalledTimes(2);
    expect(apiMocks.fetchAnalysisCallsignInfos).toHaveBeenNthCalledWith(
      1,
      ['alpha'],
      expect.any(Object),
    );
    expect(apiMocks.fetchAnalysisCallsignInfos).toHaveBeenNthCalledWith(
      2,
      ['alpha'],
      expect.any(Object),
    );

    secondCallsignInfos.resolve([{ callsign: 'alpha', res: [] }]);
    firstCallsignInfos.resolve([{ callsign: 'alpha', res: [] }]);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(setSummaryCallsignsInfo).toHaveBeenCalled();
    const updater = setSummaryCallsignsInfo.mock.calls.at(-1)?.[0];
    expect(typeof updater).toBe('function');
    expect(updater?.({})).toEqual({
      alpha: { callsign: 'alpha', res: [] },
    });
  });

  it('aborts an in-flight summary load on unmount', async () => {
    const summaryLoad = deferred<{ rows: [] }>();
    apiMocks.fetchAnalysisSummaryTable.mockImplementationOnce(() => summaryLoad.promise);

    await renderHook(buildQueryState());

    act(() => {
      void latest?.loadSummaryData();
    });
    const summarySignal = apiMocks.fetchAnalysisSummaryTable.mock.calls[0]?.[1]?.signal as
      AbortSignal | undefined;
    expect(summarySignal).toBeDefined();

    act(() => {
      root?.unmount();
    });

    expect(summarySignal?.aborted).toBe(true);
    summaryLoad.resolve({ rows: [] });
  });

  it('aborts the previous graph load when a newer query arrives', async () => {
    const firstLoad = deferred<{ callsignGraph: null }>();
    const secondLoad = deferred<{ callsignGraph: null }>();
    apiMocks.fetchAnalysisCallsignGraph.mockImplementationOnce(() => firstLoad.promise);
    apiMocks.fetchAnalysisCallsignGraph.mockImplementationOnce(() => secondLoad.promise);

    await renderHook(buildQueryState());

    act(() => {
      void latest?.loadCallsignGraph();
    });
    const firstSignal = apiMocks.fetchAnalysisCallsignGraph.mock.calls[0]?.[1]?.signal as
      AbortSignal | undefined;
    expect(firstSignal).toBeDefined();
    expect(firstSignal?.aborted).toBe(false);

    await rerenderHook(buildQueryState('next'));
    act(() => {
      void latest?.loadCallsignGraph();
    });
    const secondSignal = apiMocks.fetchAnalysisCallsignGraph.mock.calls[1]?.[1]?.signal as
      AbortSignal | undefined;

    expect(firstSignal?.aborted).toBe(true);
    expect(secondSignal).toBeDefined();
    expect(secondSignal?.aborted).toBe(false);

    firstLoad.resolve({ callsignGraph: null });
    secondLoad.resolve({ callsignGraph: null });
    await act(async () => {
      await Promise.resolve();
    });
  });

  it('aborts correlated freq loading and clears loading on invalidation', async () => {
    const correlatedLoad = deferred<{ freqs: [] }>();
    apiMocks.fetchAnalysisCorrelatedFreqs.mockImplementationOnce(() => correlatedLoad.promise);

    await renderHook({
      ...buildQueryState(),
      freqsSelected: ['100.0000'],
    });

    act(() => {
      void latest?.loadCorrelatedFreqs();
    });
    const correlatedSignal = apiMocks.fetchAnalysisCorrelatedFreqs.mock.calls[0]?.[1]?.signal as
      AbortSignal | undefined;
    expect(correlatedSignal).toBeDefined();

    act(() => {
      latest?.invalidateCorrelatedFreqsCache();
    });

    expect(correlatedSignal?.aborted).toBe(true);
    expect(latest?.correlatedFreqsLoading).toBe(false);

    correlatedLoad.resolve({ freqs: [] });
    await act(async () => {
      await Promise.resolve();
    });
  });

  it('clears correlated freq loading when the query has no selected freqs', async () => {
    await renderHook({
      ...buildQueryState(),
      freqsSelected: ['100.0000'],
    });

    await rerenderHook({
      ...buildQueryState(),
      freqsSelected: [],
    });

    act(() => {
      latest?.setCorrelatedFreqsLoading(true);
      void latest?.loadCorrelatedFreqs();
    });

    expect(latest?.correlatedFreqsLoading).toBe(false);
    expect(latest?.correlatedFreqs).toEqual([]);
  });

  it('aborts an in-flight graph load on unmount', async () => {
    const graphLoad = deferred<{ callsignGraph: null }>();
    apiMocks.fetchAnalysisCallsignGraph.mockImplementationOnce(() => graphLoad.promise);

    await renderHook(buildQueryState());

    act(() => {
      void latest?.loadCallsignGraph();
    });
    const graphSignal = apiMocks.fetchAnalysisCallsignGraph.mock.calls[0]?.[1]?.signal as
      AbortSignal | undefined;
    expect(graphSignal).toBeDefined();

    act(() => {
      root?.unmount();
    });

    expect(graphSignal?.aborted).toBe(true);
    graphLoad.resolve({ callsignGraph: null });
  });

  it('aborts the previous right-sidebar load when a newer query arrives', async () => {
    const firstCallsigns = deferred<{ callsigns: [] }>();
    const secondCallsigns = deferred<{ callsigns: [] }>();
    const firstUnits = deferred<{ units: [] }>();
    const secondUnits = deferred<{ units: [] }>();
    const firstLocations = deferred<{ locations: [] }>();
    const secondLocations = deferred<{ locations: [] }>();

    apiMocks.fetchAnalysisCallsigns.mockImplementationOnce(() => firstCallsigns.promise);
    apiMocks.fetchAnalysisCallsigns.mockImplementationOnce(() => secondCallsigns.promise);
    apiMocks.fetchAnalysisUnits.mockImplementationOnce(() => firstUnits.promise);
    apiMocks.fetchAnalysisUnits.mockImplementationOnce(() => secondUnits.promise);
    apiMocks.fetchAnalysisLocations.mockImplementationOnce(() => firstLocations.promise);
    apiMocks.fetchAnalysisLocations.mockImplementationOnce(() => secondLocations.promise);

    await renderHook(buildQueryState());

    act(() => {
      void latest?.loadTopSidebarData();
    });
    const firstSignal = apiMocks.fetchAnalysisCallsigns.mock.calls[0]?.[1]?.signal as
      AbortSignal | undefined;
    expect(firstSignal).toBeDefined();
    expect(firstSignal?.aborted).toBe(false);

    await rerenderHook(buildQueryState('next'));
    act(() => {
      void latest?.loadTopSidebarData();
    });
    const secondSignal = apiMocks.fetchAnalysisCallsigns.mock.calls[1]?.[1]?.signal as
      AbortSignal | undefined;

    expect(firstSignal?.aborted).toBe(true);
    expect(secondSignal).toBeDefined();
    expect(secondSignal?.aborted).toBe(false);
    expect(apiMocks.fetchAnalysisUnits.mock.calls[0]?.[1]?.signal).toBe(firstSignal);
    expect(apiMocks.fetchAnalysisLocations.mock.calls[0]?.[1]?.signal).toBe(firstSignal);

    firstCallsigns.resolve({ callsigns: [] });
    secondCallsigns.resolve({ callsigns: [] });
    firstUnits.resolve({ units: [] });
    secondUnits.resolve({ units: [] });
    firstLocations.resolve({ locations: [] });
    secondLocations.resolve({ locations: [] });
    await act(async () => {
      await Promise.resolve();
    });
  });

  it('aborts an in-flight right-sidebar load on unmount', async () => {
    const callsignsLoad = deferred<{ callsigns: [] }>();
    const unitsLoad = deferred<{ units: [] }>();
    const locationsLoad = deferred<{ locations: [] }>();

    apiMocks.fetchAnalysisCallsigns.mockImplementationOnce(() => callsignsLoad.promise);
    apiMocks.fetchAnalysisUnits.mockImplementationOnce(() => unitsLoad.promise);
    apiMocks.fetchAnalysisLocations.mockImplementationOnce(() => locationsLoad.promise);

    await renderHook(buildQueryState());

    act(() => {
      void latest?.loadTopSidebarData();
    });
    const sidebarSignal = apiMocks.fetchAnalysisCallsigns.mock.calls[0]?.[1]?.signal as
      AbortSignal | undefined;
    expect(sidebarSignal).toBeDefined();

    act(() => {
      root?.unmount();
    });

    expect(sidebarSignal?.aborted).toBe(true);
    callsignsLoad.resolve({ callsigns: [] });
    unitsLoad.resolve({ units: [] });
    locationsLoad.resolve({ locations: [] });
  });
});
