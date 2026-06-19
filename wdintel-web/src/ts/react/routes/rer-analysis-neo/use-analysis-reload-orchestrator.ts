import { useCallback, useEffect, useRef, useState } from 'react';

import type { InboxMessage, Network, NewCallsignsRes, SignalGroupEntry, SignalProfileEntry, Tag, Unit } from '../../../../Bindings';
import { buildAnalysisReq } from './helpers';
import { reloadAnalysisData } from './use-analysis-data.reload';
import type { FilterSectionLoadPlan } from './use-analysis-data-filter-sections';
import type { AnalysisAorEntry, AnalysisCenterTab, AnalysisCountItem, AnalysisFilterOptions, AnalysisFilterSectionId, AnalysisQueryState, AnalysisSidebarTab } from './types';

type FetchAnalysisNetworks = typeof import('../../services/api/analysis').fetchAnalysisNetworks;

type Setter<T> = React.Dispatch<React.SetStateAction<T>>;

type Params = {
  centerTab: AnalysisCenterTab;
  deferInitialLoad: boolean;
  newestFirst: boolean;
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  queryState: AnalysisQueryState;
  rightSidebarTab: AnalysisSidebarTab | null;
  rightSidebarVisible: boolean;
  reloadTriggerKey: string;
  shouldLoadNewCallsigns: boolean;
  optionsFreqValuesRef: React.MutableRefObject<string[]>;
  getLoadedFilterSections: () => AnalysisFilterSectionId[];
  getReloadFilterSections: () => AnalysisFilterSectionId[] | null;
  invalidateFilterSectionLoads: () => void;
  invalidateFilterSectionLoadsForPatch: (patch?: Partial<AnalysisQueryState>) => void;
  loadInitialFilterSections: (
    analysisReq: NonNullable<ReturnType<typeof buildAnalysisReq>>,
    plan: FilterSectionLoadPlan | { mode: 'initial'; selectedSections: AnalysisFilterSectionId[] },
    networkStatsCache?: Map<string, ReturnType<FetchAnalysisNetworks>>,
    signal?: AbortSignal,
  ) => Promise<void>;
  invalidateCallsignGraph: () => void;
  invalidateCorrelatedFreqsCache: () => void;
  invalidateRightSidebarData: () => void;
  invalidateSummaryData: (keepLoading?: boolean) => void;
  loadMapPalitras: () => Promise<void>;
  loadSummaryData: () => Promise<void>;
  loadTopSidebarData: () => Promise<void>;
  clearAnalysisResults: () => void;
  loadMessageComments: (messages: Array<[number, InboxMessage]>, forceReload?: boolean) => Promise<void>;
  invalidateMessagePaging: () => void;
  setAorEntries: Setter<AnalysisAorEntry[]>;
  setCounts: Setter<import('../../../../Bindings').CountStatsRsp | null>;
  setCountsLoading: Setter<boolean>;
  setFiltersLoading: Setter<boolean>;
  setGroupInfos: Setter<Record<string, SignalGroupEntry>>;
  setMapLoading: Setter<boolean>;
  setMapDateRange: Setter<{ startDate: number; endDate: number }>;
  setMapNetworkUnits: Setter<import('../../../../Bindings').NetworkUnit[]>;
  setMapOpenMessages: Setter<Array<[number, InboxMessage]>>;
  setMapPoints: Setter<import('../../../../Bindings').FreqDetailedPoint[]>;
  setMessages: Setter<Array<[number, InboxMessage]>>;
  setMessagesLoading: Setter<boolean>;
  setNetworks: Setter<Network[]>;
  setNewCallsigns: Setter<NewCallsignsRes>;
  setNewCallsignsLoading: Setter<boolean>;
  setNewCallsignsLoadedKey: (key: string | null) => void;
  newCallsignsRequestRef: React.MutableRefObject<number>;
  newCallsignsLoadedKeyRef: React.MutableRefObject<string | null>;
  newCallsignsPendingKeyRef: React.MutableRefObject<string | null>;
  setNoMoreToLoad: Setter<boolean>;
  setNolimitShown: Setter<boolean>;
  setOptions: Setter<AnalysisFilterOptions>;
  setProfiles: Setter<Record<string, SignalProfileEntry | null>>;
  setSummaryCallsignsInfo: Setter<Record<string, import('../../../../Bindings').CallsignInfoRes>>;
  setTagsMap: Setter<Record<number, Tag>>;
  setTopCallsigns: Setter<AnalysisCountItem[]>;
  setTopFreqs: Setter<AnalysisCountItem[]>;
  setTopLocations: Setter<AnalysisCountItem[]>;
  setTopUnits: Setter<AnalysisCountItem[]>;
  setUnitsMap: Setter<Record<number, Unit>>;
  setHasLoadedInitialMessages: Setter<boolean>;
};

export type UseAnalysisReloadOrchestratorResult = {
  reload: () => Promise<void>;
  summaryReloadBarrier: number;
};

export function useAnalysisReloadOrchestrator(params: Params): UseAnalysisReloadOrchestratorResult {
  const {
    centerTab,
    clearAnalysisResults,
    deferInitialLoad,
    getLoadedFilterSections,
    getReloadFilterSections,
    invalidateCallsignGraph,
    invalidateCorrelatedFreqsCache,
    invalidateFilterSectionLoads,
    invalidateFilterSectionLoadsForPatch,
    invalidateMessagePaging,
    invalidateRightSidebarData,
    invalidateSummaryData,
    loadInitialFilterSections,
    loadMapPalitras,
    loadMessageComments,
    loadSummaryData,
    loadTopSidebarData,
    newestFirst,
    newCallsignsLoadedKeyRef,
    newCallsignsPendingKeyRef,
    newCallsignsRequestRef,
    onError,
    onUnauthorized,
    optionsFreqValuesRef,
    queryState,
    reloadTriggerKey,
    rightSidebarTab,
    rightSidebarVisible,
    setAorEntries,
    setCounts,
    setCountsLoading,
    setFiltersLoading,
    setGroupInfos,
    setHasLoadedInitialMessages,
    setMapDateRange,
    setMapLoading,
    setMapNetworkUnits,
    setMapOpenMessages,
    setMapPoints,
    setMessages,
    setMessagesLoading,
    setNetworks,
    setNewCallsigns,
    setNewCallsignsLoading,
    setNewCallsignsLoadedKey,
    setNoMoreToLoad,
    setNolimitShown,
    setOptions,
    setProfiles,
    setSummaryCallsignsInfo,
    setTagsMap,
    setTopCallsigns,
    setTopFreqs,
    setTopLocations,
    setTopUnits,
    setUnitsMap,
    shouldLoadNewCallsigns,
  } = params;
  const reloadRequestRef = useRef(0);
  const lastReloadTriggerKeyRef = useRef<string | null>(null);
  const summaryReloadPendingKeyRef = useRef<string | null>(null);
  const summaryDebouncePendingKeyRef = useRef<string | null>(null);
  const reloadAbortControllerRef = useRef<AbortController | null>(null);
  const reloadDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [summaryReloadBarrier, setSummaryReloadBarrier] = useState(0);

  const reload = useCallback(async () => {
    reloadAbortControllerRef.current?.abort();
    const abortController = new AbortController();
    reloadAbortControllerRef.current = abortController;

    try {
      await reloadAnalysisData({
        clearAnalysisResults,
        invalidateCallsignGraph,
        invalidateCorrelatedFreqsCache,
        invalidateMessagePaging,
        newestFirst,
        onError,
        onUnauthorized,
        optionsFreqsRef: optionsFreqValuesRef,
        queryState,
        reloadRequestRef,
        newCallsignsRequestRef,
        newCallsignsLoadedKeyRef,
        newCallsignsPendingKeyRef,
        setAorEntries,
        setCounts,
        setCountsLoading,
        setFiltersLoading,
        setGroupInfos,
        setMapLoading,
        setMapDateRange,
        setMapNetworkUnits,
        setMapOpenMessages,
        setMapPoints,
        setMessages,
        loadMessageComments,
        setMessagesLoading,
        setNetworks,
        setNewCallsigns,
        setNewCallsignsLoading,
        setNewCallsignsLoadedKey,
        shouldLoadNewCallsigns,
        setNoMoreToLoad,
        setNolimitShown,
        setOptions,
        setProfiles,
        setSummaryCallsignsInfo,
        setTagsMap,
        setTopCallsigns,
        setTopFreqs,
        setTopLocations,
        setTopUnits,
        setUnitsMap,
        setHasLoadedInitialMessages,
        invalidateSummaryLoads: () => invalidateSummaryData(centerTab === 'summary'),
        invalidateTopSidebarLoads: invalidateRightSidebarData,
        getLoadedFilterSections,
        getReloadFilterSections,
        loadInitialFilterSections,
        invalidateFilterSectionLoads,
        invalidateFilterSectionLoadsForPatch,
        centerTab,
        rightSidebarVisible,
        rightSidebarTab,
        signal: abortController.signal,
      });
    } finally {
      if (reloadAbortControllerRef.current === abortController) {
        reloadAbortControllerRef.current = null;
      }
    }
  }, [
    centerTab,
    clearAnalysisResults,
    getLoadedFilterSections,
    getReloadFilterSections,
    invalidateCallsignGraph,
    invalidateCorrelatedFreqsCache,
    invalidateFilterSectionLoads,
    invalidateFilterSectionLoadsForPatch,
    invalidateMessagePaging,
    invalidateRightSidebarData,
    invalidateSummaryData,
    loadInitialFilterSections,
    loadMessageComments,
    newestFirst,
    newCallsignsLoadedKeyRef,
    newCallsignsPendingKeyRef,
    newCallsignsRequestRef,
    onError,
    onUnauthorized,
    optionsFreqValuesRef,
    queryState,
    reloadTriggerKey,
    setAorEntries,
    setCounts,
    setCountsLoading,
    setFiltersLoading,
    setGroupInfos,
    setHasLoadedInitialMessages,
    setMapDateRange,
    setMapLoading,
    setMapNetworkUnits,
    setMapOpenMessages,
    setMapPoints,
    setMessages,
    setMessagesLoading,
    setNetworks,
    setNewCallsigns,
    setNewCallsignsLoading,
    setNewCallsignsLoadedKey,
    setNoMoreToLoad,
    setNolimitShown,
    setOptions,
    setProfiles,
    setSummaryCallsignsInfo,
    setTagsMap,
    setTopCallsigns,
    setTopFreqs,
    setTopLocations,
    setTopUnits,
    setUnitsMap,
    shouldLoadNewCallsigns,
    rightSidebarVisible,
    rightSidebarTab,
  ]);

  const mapVisible = centerTab === 'map' || (rightSidebarVisible && rightSidebarTab === 'map');

  useEffect(() => {
    if (deferInitialLoad) return;
    if (lastReloadTriggerKeyRef.current === reloadTriggerKey) return;
    const runReload = () => {
      lastReloadTriggerKeyRef.current = reloadTriggerKey;
      summaryDebouncePendingKeyRef.current = null;
      const summaryReloadWasAlreadyPending = summaryReloadPendingKeyRef.current === reloadTriggerKey;
      summaryReloadPendingKeyRef.current = reloadTriggerKey;
      if (centerTab === 'summary' && !summaryReloadWasAlreadyPending) {
        invalidateSummaryData(true);
      }
      void reload()
        .then(() => {
          if (mapVisible) {
            mapReloadedKeyRef.current = reloadTriggerKey;
          }
        })
        .finally(() => {
          if (summaryReloadPendingKeyRef.current !== reloadTriggerKey) return;
          summaryReloadPendingKeyRef.current = null;
          setSummaryReloadBarrier((current) => current + 1);
        });
    };

    if (lastReloadTriggerKeyRef.current === null) {
      runReload();
      return;
    }

    reloadAbortControllerRef.current?.abort();
    reloadRequestRef.current += 1;
    if (reloadDebounceTimerRef.current != null) {
      clearTimeout(reloadDebounceTimerRef.current);
    }
    summaryReloadPendingKeyRef.current = reloadTriggerKey;
    summaryDebouncePendingKeyRef.current = reloadTriggerKey;
    if (centerTab === 'summary') {
      invalidateSummaryData(true);
    }
    reloadDebounceTimerRef.current = setTimeout(runReload, 200);

    return () => {
      if (summaryDebouncePendingKeyRef.current === reloadTriggerKey) {
        summaryReloadPendingKeyRef.current = null;
        summaryDebouncePendingKeyRef.current = null;
      }
      if (reloadDebounceTimerRef.current != null) {
        clearTimeout(reloadDebounceTimerRef.current);
        reloadDebounceTimerRef.current = null;
      }
    };
  }, [centerTab, deferInitialLoad, invalidateSummaryData, mapVisible, reload, reloadTriggerKey]);

  const mapReloadPendingKeyRef = useRef<string | null>(null);
  const mapReloadedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (deferInitialLoad) return;
    if (!mapVisible) return;
    if (lastReloadTriggerKeyRef.current !== reloadTriggerKey) return;
    if (summaryReloadPendingKeyRef.current === reloadTriggerKey) return;
    if (mapReloadPendingKeyRef.current === reloadTriggerKey) return;
    if (mapReloadedKeyRef.current === reloadTriggerKey) return;

    mapReloadPendingKeyRef.current = reloadTriggerKey;
    void reload().finally(() => {
      if (mapReloadPendingKeyRef.current !== reloadTriggerKey) return;
      mapReloadPendingKeyRef.current = null;
      mapReloadedKeyRef.current = reloadTriggerKey;
    });
  }, [deferInitialLoad, mapVisible, reload, reloadTriggerKey, summaryReloadBarrier]);

  useEffect(() => {
    if (deferInitialLoad) return;
    if (centerTab !== 'summary') return;
    if (summaryReloadPendingKeyRef.current !== null) return;
    void loadSummaryData();
  }, [centerTab, deferInitialLoad, loadSummaryData, summaryReloadBarrier]);

  useEffect(() => {
    if (deferInitialLoad) return;
    if (!rightSidebarVisible) return;
    if (rightSidebarTab !== 'stats' && rightSidebarTab !== 'callsigns') return;
    void loadTopSidebarData();
  }, [deferInitialLoad, loadTopSidebarData, rightSidebarTab, rightSidebarVisible]);

  useEffect(() => {
    if (deferInitialLoad) return;
    void loadMapPalitras();
  }, [deferInitialLoad, loadMapPalitras]);

  useEffect(() => {
    return () => {
      reloadAbortControllerRef.current?.abort();
      reloadAbortControllerRef.current = null;
      if (reloadDebounceTimerRef.current != null) {
        clearTimeout(reloadDebounceTimerRef.current);
        reloadDebounceTimerRef.current = null;
      }
    };
  }, []);

  return { reload, summaryReloadBarrier };
}
