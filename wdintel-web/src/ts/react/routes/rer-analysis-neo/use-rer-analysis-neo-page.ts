import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';

import { isUnauthorizedError } from '../../services/api/client';
import {
  buildAnalysisReq,
  createInitialQueryState,
  createResetQueryState,
  hasMeaningfulFiltersBeyondDateRange,
  parseQueryStateFromWindow,
  pushQueryStateToUrl,
  queryStateComparisonKey,
  shouldOpenAnalysisMapFromSearchParams,
} from './helpers';
import type { AnalysisPageViewModel, AnalysisQueryState, AnalysisSidebarTab } from './types';
import { useAnalysisData } from './use-analysis-data';
import { useAnalysisMessageEditor } from './use-analysis-message-editor';
import { useAnalysisReport } from './use-analysis-report';
import { useAnalysisSavedFilters } from './use-analysis-saved-filters';

function initState(): AnalysisQueryState {
  return createInitialQueryState(parseQueryStateFromWindow());
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function useRerAnalysisNeoPage(authUserName: string | null): AnalysisPageViewModel {
  const [initialQueryState] = useState<AnalysisQueryState>(initState);
  const [queryState, setQueryState] = useState<AnalysisQueryState>(initialQueryState);
  const [lastResetState, setLastResetState] = useState<AnalysisQueryState>(() =>
    hasMeaningfulFiltersBeyondDateRange(initialQueryState) ? createResetQueryState() : initialQueryState,
  );
  const [centerTab, setCenterTabState] = useState<'messages' | 'map' | 'summary'>('messages');
  const [error, setError] = useState<string | null>(null);
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [newestFirst, setNewestFirst] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [rightSidebarTab, setRightSidebarTab] = useState<AnalysisSidebarTab | null>(null);
  const [centerTabPending, startCenterTabTransition] = useTransition();
  const setPageError = useCallback((message: string) => setError(message || null), []);

  const handleUnauthorized = useCallback((errorValue: unknown) => {
    if (isUnauthorizedError(errorValue)) {
      window.location.assign('/login');
      return true;
    }
    return false;
  }, []);

  const data = useAnalysisData({
    newestFirst,
    onError: setPageError,
    onUnauthorized: handleUnauthorized,
    shouldLoadNewCallsigns: rightPanelOpen && rightSidebarTab === 'newCallsigns',
    queryState,
  });

  const savedFilters = useAnalysisSavedFilters({
    allFrequencies: data.options.freqs,
    onError: setPageError,
    onUnauthorized: handleUnauthorized,
    queryState,
    setQueryState,
  });

  const report = useAnalysisReport({
    fromDateTimeStr: queryState.fromDateTimeStr,
    inboxReq: data.inboxReq,
    onError: setPageError,
    onUnauthorized: handleUnauthorized,
    toDateTimeStr: queryState.toDateTimeStr,
  });

  const editor = useAnalysisMessageEditor({
    messages: data.messages,
    onError: setPageError,
    onUnauthorized: handleUnauthorized,
    onUpdateLocalMessage: data.onUpdateLocalMessage,
  });

  const validationError = useMemo(
    () => (buildAnalysisReq(queryState) == null ? 'Перевірте дату та час. Дата раніше 2022-01-01 не допускається.' : null),
    [queryState],
  );

  const setCenterTab = useCallback((tab: 'messages' | 'map' | 'summary') => {
    startCenterTabTransition(() => {
      setCenterTabState(tab);
    });
  }, []);

  const showMapDeepLinkAppliedRef = useRef(false);
  useEffect(() => {
    if (showMapDeepLinkAppliedRef.current) return;
    if (typeof window === 'undefined') return;
    if (!shouldOpenAnalysisMapFromSearchParams(new URLSearchParams(window.location.search))) return;
    showMapDeepLinkAppliedRef.current = true;
    setCenterTab('map');
  }, [setCenterTab]);

  const updateQueryState = useCallback((patch: Partial<AnalysisQueryState>) => {
    setQueryState((current) => ({ ...current, ...patch }));
  }, []);

  const toggleUnitFromMap = useCallback((unitName: string | null) => {
    if (!unitName) return;
    setQueryState((current) => ({
      ...current,
      unitsSelected: current.unitsSelected.includes(unitName)
        ? current.unitsSelected.filter((item) => item !== unitName)
        : [...current.unitsSelected, unitName],
    }));
  }, []);

  const resetFilters = useCallback(() => {
    const nextState = createResetQueryState();
    setQueryState(nextState);
    setLastResetState(nextState);
    setError(null);
    pushQueryStateToUrl(nextState);
  }, []);

  const setIncludeOnlyNewFreqs = useCallback(
    (value: boolean) => {
      setQueryState((current) => {
        const freqsSelected = value ? data.options.newFreqs : [];
        if (current.includeOnlyNewFreqs === value && stringArraysEqual(current.freqsSelected, freqsSelected)) {
          return current;
        }
        return {
          ...current,
          includeOnlyNewFreqs: value,
          freqsSelected,
        };
      });
    },
    [data.options.newFreqs],
  );

  useEffect(() => {
    if (!queryState.includeOnlyNewFreqs) return;
    setQueryState((current) => {
      if (!current.includeOnlyNewFreqs || stringArraysEqual(current.freqsSelected, data.options.newFreqs)) {
        return current;
      }
      return { ...current, freqsSelected: data.options.newFreqs };
    });
  }, [data.options.newFreqs, queryState.includeOnlyNewFreqs]);

  const selectOnlyFreq = useCallback((freq: string) => {
    setQueryState((current) => ({ ...current, includeOnlyNewFreqs: false, freqsSelected: [freq] }));
  }, []);

  const showFreqOnMap = useCallback((freq: string) => {
    startCenterTabTransition(() => {
      setCenterTabState('map');
      setQueryState((current) => ({ ...current, includeOnlyNewFreqs: false, freqsSelected: [freq] }));
    });
  }, []);

  const toggleLeftPanel = useCallback(() => {
    setLeftPanelOpen((current) => !current);
  }, []);

  const toggleRightPanel = useCallback(() => {
    setRightPanelOpen((current) => {
      const next = !current;
      if (next && rightSidebarTab == null) {
        setRightSidebarTab('stats');
      }
      return next;
    });
  }, [rightSidebarTab]);

  useEffect(() => {
    if (!rightPanelOpen || rightSidebarTab !== 'newCallsigns') return;
    void data.loadNewCallsigns();
  }, [data.loadNewCallsigns, rightPanelOpen, rightSidebarTab]);

  const canResetFilters = useMemo(() => {
    const queryStateKey = queryStateComparisonKey(queryState);
    const lastResetStateKey = queryStateComparisonKey(lastResetState);
    if (queryStateKey == null || lastResetStateKey == null) return false;

    return queryStateKey !== lastResetStateKey;
  }, [lastResetState, queryState]);

  return {
    authUserName,
    aorEntries: data.aorEntries,
    canResetFilters,
    callsignGraph: data.callsignGraph,
    callsignGraphLoading: data.callsignGraphLoading,
    callsignGraphLoadVersion: data.callsignGraphLoadVersion,
    callsignGraphNolimit: data.callsignGraphNolimit,
    centerTab,
    centerTabPending,
    copiedFeedbackId: null,
    correlatedFreqs: data.correlatedFreqs,
    correlatedFreqsLoading: data.correlatedFreqsLoading,
    counts: data.counts,
    countsLoading: data.countsLoading,
    editorMessage: editor.editorMessage,
    editorSaveInFlight: editor.editorSaveInFlight,
    error,
    filtersLoading: data.filtersLoading,
    groupInfos: data.groupInfos,
    groupsActivityPeriod: data.groupsActivityPeriod,
    groupsActivity: data.groupsActivity,
    groupsActivityLoadedFreq: data.groupsActivityLoadedFreq,
    groupsActivityLoadedPeriod: data.groupsActivityLoadedPeriod,
    groupsActivityLoading: data.groupsActivityLoading,
    includeOnlyNewFreqs: queryState.includeOnlyNewFreqs,
    inboxReq: data.inboxReq,
    isDirty: savedFilters.isDirty,
    leftPanelOpen,
    loadedSavedFilter: savedFilters.loadedSavedFilter,
    mapAttrs: data.mapAttrs,
    messageActionLoading: data.messageActionLoading,
    messagesLoading: data.messagesLoading,
    messagesPaging: data.messagesPaging,
    messages: data.messages,
    networkDisplayMap: data.networkDisplayMap,
    networks: data.networks,
    newCallsigns: data.newCallsigns,
    newCallsignsLoading: data.newCallsignsLoading,
    noMoreToLoad: data.noMoreToLoad,
    nolimitShown: data.nolimitShown,
    newestFirst,
    onDeleteMessage: data.onDeleteMessage,
    onSaveMessageComment: data.onSaveMessageComment,
    onToggleMessageBookmark: data.onToggleMessageBookmark,
    onToggleMessageImportant: data.onToggleMessageImportant,
    onToggleMessageTag: data.onToggleMessageTag,
    onUpdateLocalMessage: data.onUpdateLocalMessage,
    options: data.options,
    profiles: data.profiles,
    queryState,
    rightPanelOpen,
    rightSidebarTab,
    report: report.report,
    reportDownloadInFlight: report.reportDownloadInFlight,
    saveInFlight: savedFilters.saveInFlight,
    savedFilterName: savedFilters.savedFilterName,
    savedFilters: savedFilters.savedFilters,
    summaryLoading: data.summaryLoading,
    summaryRows: data.summaryRows,
    summaryCallsignsInfo: data.summaryCallsignsInfo,
    unitsMap: data.unitsMap,
    tagsMap: data.tagsMap,
    topCallsigns: data.topCallsigns,
    topFreqs: data.topFreqs,
    topLocations: data.topLocations,
    topUnits: data.topUnits,
    validationError,
    applySavedFilter: savedFilters.applySavedFilter,
    deleteLoadedSavedFilter: savedFilters.deleteLoadedSavedFilter,
    renameExistingSavedFilter: savedFilters.renameExisting,
    loadCallsignGraph: data.loadCallsignGraph,
    loadAllMessages: data.loadAllMessages,
    loadCorrelatedFreqs: data.loadCorrelatedFreqs,
    loadGroupsActivity: data.loadGroupsActivity,
    loadNewCallsigns: data.loadNewCallsigns,
    loadMoreMessages: data.loadMoreMessages,
    loadMessagesForMap: data.loadMessagesForMap,
    toggleCallsignGraphNolimit: data.toggleCallsignGraphNolimit,
    closeReport: report.closeReport,
    closeEditor: editor.closeEditor,
    downloadGeojson: data.downloadGeojson,
    downloadKmz: data.downloadKmz,
    downloadSummaryXlsx: data.downloadSummaryXlsx,
    downloadReport: report.downloadReport,
    openReport: report.openReport,
    openEditor: editor.openEditor,
    refreshMapDateRange: data.refreshMapDateRange,
    renameSummaryUnit: data.renameSummaryUnit,
    reload: data.reload,
    resetFilters,
    saveAsNew: savedFilters.saveAsNew,
    setIncludeOnlyNewFreqs,
    selectOnlyFreq,
    setCenterTab,
    setNewestFirst,
    setRightSidebarTab,
    setSavedFilterName: savedFilters.setSavedFilterName,
    showFreqOnMap,
    toggleLeftPanel,
    toggleRightPanel,
    toggleUnitFromMap,
    saveEditor: editor.saveEditor,
    updateReport: report.updateReport,
    updateExisting: savedFilters.updateExisting,
    updateQueryState,
  };
}
