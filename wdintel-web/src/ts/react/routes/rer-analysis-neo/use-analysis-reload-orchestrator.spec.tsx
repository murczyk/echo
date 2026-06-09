/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage, Network, NewCallsignsRes, SignalGroupEntry, SignalProfileEntry, Tag, Unit } from '../../../../Bindings';
import { emptyQueryState } from './helpers';
import { useAnalysisReloadOrchestrator } from './use-analysis-reload-orchestrator';
import type { AnalysisAorEntry, AnalysisCenterTab, AnalysisCountItem, AnalysisFilterOptions, AnalysisFilterSectionId, AnalysisQueryState, AnalysisSidebarTab } from './types';

const reloadAnalysisDataMock = vi.hoisted(() => ({
  reloadAnalysisData: vi.fn(() => Promise.resolve()),
}));

vi.mock('./use-analysis-data.reload', () => reloadAnalysisDataMock);

let container: HTMLDivElement | null = null;
let root: Root | null = null;

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
    invalidateMessagePaging: vi.fn(),
    setAorEntries: noopSetter as Dispatch<SetStateAction<AnalysisAorEntry[]>>,
    setCounts: noopSetter as Dispatch<SetStateAction<import('../../../../Bindings').CountStatsRsp | null>>,
    setCountsLoading: noopSetter as Dispatch<SetStateAction<boolean>>,
    setFiltersLoading: noopSetter as Dispatch<SetStateAction<boolean>>,
    setGroupInfos: noopSetter as Dispatch<SetStateAction<Record<string, SignalGroupEntry>>>,
    setMapLoading: noopSetter as Dispatch<SetStateAction<boolean>>,
    setMapDateRange: noopSetter as Dispatch<SetStateAction<{ startDate: number; endDate: number }>>,
    setMapNetworkUnits: noopSetter as Dispatch<SetStateAction<import('../../../../Bindings').NetworkUnit[]>>,
    setMapOpenMessages: noopSetter as Dispatch<SetStateAction<Array<[number, InboxMessage]>>>,
    setMapPoints: noopSetter as Dispatch<SetStateAction<import('../../../../Bindings').FreqDetailedPoint[]>>,
    setMessages: noopSetter as Dispatch<SetStateAction<Array<[number, InboxMessage]>>>,
    setMessagesLoading: noopSetter as Dispatch<SetStateAction<boolean>>,
    setNetworkDisplayMap: noopSetter as Dispatch<SetStateAction<Record<number, string>>>,
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
    setSummaryCallsignsInfo: noopSetter as Dispatch<SetStateAction<Record<string, import('../../../../Bindings').CallsignInfoRes>>>,
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
  useAnalysisReloadOrchestrator(props);
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
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

describe('useAnalysisReloadOrchestrator', () => {
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
});
