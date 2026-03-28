import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';

import { isUnauthorizedError } from '../../services/api/client';
import {
  buildAnalysisReq,
  createInitialQueryState,
  createResetQueryState,
  parseQueryStateFromWindow,
  pushQueryStateToUrl,
} from './helpers';
import type { AnalysisPageViewModel, AnalysisQueryState, AnalysisSidebarSections } from './types';
import { useAnalysisData } from './use-analysis-data';
import { useAnalysisMessageEditor } from './use-analysis-message-editor';
import { useAnalysisReport } from './use-analysis-report';
import { useAnalysisSavedFilters } from './use-analysis-saved-filters';

function initState(): AnalysisQueryState {
  return createInitialQueryState(parseQueryStateFromWindow());
}

export function useRerAnalysisNeoPage(authUserName: string | null): AnalysisPageViewModel {
  const [queryState, setQueryState] = useState<AnalysisQueryState>(initState);
  const [centerTab, setCenterTabState] = useState<'messages' | 'map' | 'summary'>('messages');
  const [error, setError] = useState<string | null>(null);
  const [includeOnlyNewFreqs, setIncludeOnlyNewFreqsState] = useState(false);
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [newestFirst, setNewestFirst] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [centerTabPending, startCenterTabTransition] = useTransition();
  const [rightSidebarSections, setRightSidebarSections] = useState<AnalysisSidebarSections>({
    stats: false,
    callsigns: false,
    newCallsigns: false,
  });
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
    dateFrom: queryState.dateFromStr,
    dateTo: queryState.dateToStr,
    inboxReq: data.inboxReq,
    onError: setPageError,
    onUnauthorized: handleUnauthorized,
    timeFrom: queryState.timeFromStr,
    timeTo: queryState.timeToStr,
  });

  const editor = useAnalysisMessageEditor({
    messages: data.messages,
    onError: setPageError,
    onUnauthorized: handleUnauthorized,
    onUpdateLocalMessage: data.onUpdateLocalMessage,
  });

  const validationError = useMemo(
    () => (buildAnalysisReq(queryState) == null ? 'Перевірте дату та час. Роки раніше 1000 не допускаються.' : null),
    [queryState],
  );

  const setCenterTab = useCallback((tab: 'messages' | 'map' | 'summary') => {
    startCenterTabTransition(() => {
      setCenterTabState(tab);
      if (tab === 'map') {
        setLeftPanelOpen(false);
        setRightPanelOpen(false);
        return;
      }
      setLeftPanelOpen(true);
    });
  }, []);

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
    setIncludeOnlyNewFreqsState(false);
    setError(null);
    pushQueryStateToUrl(nextState);
  }, []);

  const setIncludeOnlyNewFreqs = useCallback(
    (value: boolean) => {
      setIncludeOnlyNewFreqsState(value);
      setQueryState((current) => ({
        ...current,
        freqsSelected: value ? data.options.newFreqs : [],
      }));
    },
    [data.options.newFreqs],
  );

  useEffect(() => {
    if (!includeOnlyNewFreqs) return;
    setQueryState((current) => ({ ...current, freqsSelected: data.options.newFreqs }));
  }, [data.options.newFreqs, includeOnlyNewFreqs]);

  const selectOnlyFreq = useCallback((freq: string) => {
    setQueryState((current) => ({ ...current, freqsSelected: [freq] }));
  }, []);

  const showFreqOnMap = useCallback((freq: string) => {
    startCenterTabTransition(() => {
      setCenterTabState('map');
      setLeftPanelOpen(false);
      setRightPanelOpen(false);
      setQueryState((current) => ({ ...current, freqsSelected: [freq] }));
    });
  }, []);

  const toggleLeftPanel = useCallback(() => {
    setLeftPanelOpen((current) => !current);
  }, []);

  const toggleRightPanel = useCallback(() => {
    setRightPanelOpen((current) => !current);
  }, []);

  const toggleRightSidebarSection = useCallback((section: keyof AnalysisSidebarSections) => {
    setRightSidebarSections((current) => {
      const next = { ...current, [section]: !current[section] };
      const anyEnabled = Object.values(next).some(Boolean);
      setRightPanelOpen(anyEnabled);
      return next;
    });
  }, []);

  return {
    authUserName,
    aorEntries: data.aorEntries,
    callsignGraph: data.callsignGraph,
    callsignGraphLoading: data.callsignGraphLoading,
    callsignGraphNolimit: data.callsignGraphNolimit,
    centerTab,
    centerTabPending,
    copiedFeedbackId: null,
    correlatedFreqs: data.correlatedFreqs,
    correlatedFreqsLoading: data.correlatedFreqsLoading,
    counts: data.counts,
    editorMessage: editor.editorMessage,
    editorSaveInFlight: editor.editorSaveInFlight,
    error,
    groupInfos: data.groupInfos,
    groupsActivityPeriod: data.groupsActivityPeriod,
    groupsActivity: data.groupsActivity,
    groupsActivityLoading: data.groupsActivityLoading,
    includeOnlyNewFreqs,
    inboxReq: data.inboxReq,
    isDirty: savedFilters.isDirty,
    leftPanelOpen,
    loadedSavedFilter: savedFilters.loadedSavedFilter,
    loading: data.loading,
    mapAttrs: data.mapAttrs,
    messageActionLoading: data.messageActionLoading,
    messages: data.messages,
    networkDisplayMap: data.networkDisplayMap,
    networks: data.networks,
    newCallsigns: data.newCallsigns,
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
    rightSidebarSections,
    report: report.report,
    reportDownloadInFlight: report.reportDownloadInFlight,
    saveInFlight: savedFilters.saveInFlight,
    savedFilterName: savedFilters.savedFilterName,
    savedFilters: savedFilters.savedFilters,
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
    setSavedFilterName: savedFilters.setSavedFilterName,
    showFreqOnMap,
    toggleLeftPanel,
    toggleRightPanel,
    toggleRightSidebarSection,
    toggleUnitFromMap,
    saveEditor: editor.saveEditor,
    updateReport: report.updateReport,
    updateExisting: savedFilters.updateExisting,
    updateQueryState,
  };
}
