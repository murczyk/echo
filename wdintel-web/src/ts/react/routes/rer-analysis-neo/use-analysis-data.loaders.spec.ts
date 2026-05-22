/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { normalizeMapMessageIds, shouldClearMapOpenMessages } from './use-analysis-data.loaders';
import { emptyQueryState } from './helpers';
import { useAnalysisDataLoaders } from './use-analysis-data.loaders';

const apiMocks = vi.hoisted(() => ({
  fetchAnalysisCallsignInfos: vi.fn(),
  fetchAnalysisCallsigns: vi.fn(),
  fetchAnalysisLocations: vi.fn(),
  fetchAnalysisSummaryTable: vi.fn(),
  fetchAnalysisUnits: vi.fn(),
  fetchMessagesByIds: vi.fn(),
}));

vi.mock('../../services/api/analysis', async () => {
  const actual = await vi.importActual<typeof import('../../services/api/analysis')>('../../services/api/analysis');
  return {
    ...actual,
    fetchAnalysisCallsignInfos: apiMocks.fetchAnalysisCallsignInfos,
    fetchAnalysisCallsigns: apiMocks.fetchAnalysisCallsigns,
    fetchAnalysisLocations: apiMocks.fetchAnalysisLocations,
    fetchAnalysisSummaryTable: apiMocks.fetchAnalysisSummaryTable,
    fetchAnalysisUnits: apiMocks.fetchAnalysisUnits,
    fetchMessagesByIds: apiMocks.fetchMessagesByIds,
  };
});

type HookResult = ReturnType<typeof useAnalysisDataLoaders>;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: HookResult | null = null;

function buildQueryState() {
  return {
    ...emptyQueryState(),
    fromDateTimeStr: '2026-04-01T00:00',
    toDateTimeStr: '2026-04-02T00:00',
  };
}

function renderLoaderHook(overrides: Partial<Parameters<typeof useAnalysisDataLoaders>[0]> = {}) {
  if (container == null) {
    throw new Error('container not initialized');
  }

  root = createRoot(container);

  const Harness = () => {
    latest = useAnalysisDataLoaders({
      callsignGraphNolimit: false,
      callsignGraphRequestRef: { current: 0 },
      groupsActivityPeriod: 'selected',
      mapDateRangeLoadVersionRef: { current: 0 },
      mapMessagesLoadVersionRef: { current: 0 },
      newestFirst: true,
      loadMissingNetworksForMessages: vi.fn().mockResolvedValue(undefined),
      onError: vi.fn(),
      onUnauthorized: vi.fn().mockReturnValue(false),
      optionsFreqs: [],
      queryState: buildQueryState(),
      setCallsignGraph: vi.fn(),
      setCallsignGraphLoading: vi.fn(),
      setCallsignGraphLoadVersion: vi.fn(),
      setCallsignGraphNolimit: vi.fn(),
      setCorrelatedFreqs: vi.fn(),
      setCorrelatedFreqsLoading: vi.fn(),
      setGroupsActivity: vi.fn(),
      setGroupsActivityLoadedFreq: vi.fn(),
      setGroupsActivityLoadedPeriod: vi.fn(),
      setGroupsActivityLoading: vi.fn(),
      setGroupsActivityPeriod: vi.fn(),
      setMapDateRange: vi.fn(),
      setMapLoading: vi.fn(),
      setMapNetworkUnits: vi.fn(),
      setMapOpenMessages: vi.fn(),
      setMapPalitras: vi.fn(),
      setMapPalitrasLoaded: vi.fn(),
      setMapPalitrasLoadState: vi.fn(),
      setMapPoints: vi.fn(),
      setSummaryCallsignsInfo: vi.fn(),
      setSummaryLoaded: vi.fn(),
      setSummaryLoading: vi.fn(),
      setSummaryRows: vi.fn(),
      setTopCallsigns: vi.fn(),
      setTopFreqs: vi.fn(),
      setTopLocations: vi.fn(),
      setRightSidebarLoading: vi.fn(),
      setTopUnits: vi.fn(),
      ...overrides,
    });
    return null;
  };

  act(() => {
    root?.render(createElement(Harness));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  latest = null;
  apiMocks.fetchAnalysisCallsignInfos.mockReset();
  apiMocks.fetchAnalysisCallsigns.mockReset();
  apiMocks.fetchAnalysisLocations.mockReset();
  apiMocks.fetchAnalysisSummaryTable.mockReset();
  apiMocks.fetchAnalysisUnits.mockReset();
  apiMocks.fetchMessagesByIds.mockReset();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  latest = null;
});

describe('normalizeMapMessageIds', () => {
  it('filters nullish and duplicate ids', () => {
    expect(normalizeMapMessageIds([1, null, 2, undefined, 2, Number.NaN, Number.POSITIVE_INFINITY, 3])).toEqual([1, 2, 3]);
  });
});

describe('shouldClearMapOpenMessages', () => {
  it('returns true when the map selection is empty after normalization', () => {
    expect(shouldClearMapOpenMessages([null, undefined, Number.NaN])).toBe(true);
  });

  it('returns false when there are valid ids to fetch', () => {
    expect(shouldClearMapOpenMessages([1, null, 2])).toBe(false);
  });
});

describe('retryable loader caches', () => {
  it('loads missing networks for map messages without blocking map load success', async () => {
    const setMapOpenMessages = vi.fn();
    const loadMissingNetworksForMessages = vi.fn(() => new Promise<void>(() => undefined));
    const messages = [[7, { networkIds: [12] }]];
    apiMocks.fetchMessagesByIds.mockResolvedValueOnce(messages);

    renderLoaderHook({ loadMissingNetworksForMessages, setMapOpenMessages });

    let loaded = false;
    await act(async () => {
      loaded = (await latest?.loadMessagesForMap([7])) ?? false;
    });

    expect(apiMocks.fetchMessagesByIds).toHaveBeenCalledWith([7]);
    expect(setMapOpenMessages).toHaveBeenCalledWith(messages);
    expect(loadMissingNetworksForMessages).toHaveBeenCalledWith(messages);
    expect(loaded).toBe(true);
  });

  it('retries summary loading after a failure for the same query', async () => {
    apiMocks.fetchAnalysisSummaryTable.mockRejectedValueOnce(new Error('summary failed'));
    apiMocks.fetchAnalysisSummaryTable.mockResolvedValueOnce({ rows: [] });

    renderLoaderHook();

    await act(async () => {
      await latest?.loadSummaryData();
    });
    await act(async () => {
      await latest?.loadSummaryData();
    });

    expect(apiMocks.fetchAnalysisSummaryTable).toHaveBeenCalledTimes(2);
  });

  it('loads summary callsign infos together with summary rows', async () => {
    const setSummaryLoaded = vi.fn();
    apiMocks.fetchAnalysisSummaryTable.mockResolvedValueOnce({
      rows: [
        {
          callsigns: [' alpha ', 'alpha', 'bravo'],
        },
      ],
    });
    apiMocks.fetchAnalysisCallsignInfos.mockResolvedValueOnce([]);

    renderLoaderHook({ setSummaryLoaded });

    await act(async () => {
      await latest?.loadSummaryData();
    });

    expect(apiMocks.fetchAnalysisCallsignInfos).toHaveBeenCalledWith(['alpha', 'bravo']);
    expect(setSummaryLoaded).toHaveBeenCalledWith(true);
  });

  it('retries right sidebar loading after a failure for the same query', async () => {
    apiMocks.fetchAnalysisCallsigns.mockRejectedValueOnce(new Error('sidebar failed'));
    apiMocks.fetchAnalysisCallsigns.mockResolvedValueOnce({ callsigns: [] });
    apiMocks.fetchAnalysisUnits.mockResolvedValue({ units: [] });
    apiMocks.fetchAnalysisLocations.mockResolvedValue({ locations: [] });
    apiMocks.fetchAnalysisCallsignInfos.mockResolvedValue([]);

    renderLoaderHook();

    await act(async () => {
      await latest?.loadTopSidebarData();
    });
    await act(async () => {
      await latest?.loadTopSidebarData();
    });

    expect(apiMocks.fetchAnalysisCallsigns).toHaveBeenCalledTimes(2);
    expect(apiMocks.fetchAnalysisUnits).toHaveBeenCalledTimes(2);
    expect(apiMocks.fetchAnalysisLocations).toHaveBeenCalledTimes(2);
  });
});
