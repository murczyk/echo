import React from 'react';

import { isUnauthorizedError } from '../../services/api/client';
import {
  buildAnalysisReq,
  createInitialQueryState,
  createResetQueryState,
  parseQueryStateFromWindow,
  pushQueryStateToUrl,
} from './helpers';
import type { AnalysisPageViewModel, AnalysisQueryState } from './types';
import { useAnalysisData } from './use-analysis-data';
import { useAnalysisMessageEditor } from './use-analysis-message-editor';
import { useAnalysisReport } from './use-analysis-report';
import { useAnalysisSavedFilters } from './use-analysis-saved-filters';

function initState(): AnalysisQueryState {
  return createInitialQueryState(parseQueryStateFromWindow());
}

export function useRerAnalysisNeoPage(authUserName: string | null): AnalysisPageViewModel {
  const [queryState, setQueryState] = React.useState<AnalysisQueryState>(initState);
  const [centerTab, setCenterTab] = React.useState<'messages' | 'map'>('messages');
  const [error, setError] = React.useState<string | null>(null);
  const [includeOnlyNewFreqs, setIncludeOnlyNewFreqsState] = React.useState(false);
  const [newestFirst, setNewestFirst] = React.useState(true);
  const setPageError = React.useCallback((message: string) => setError(message || null), []);

  const handleUnauthorized = React.useCallback((errorValue: unknown) => {
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

  const validationError = React.useMemo(
    () => (buildAnalysisReq(queryState) == null ? 'Перевірте дату та час. Роки раніше 1000 не допускаються.' : null),
    [queryState],
  );

  const updateQueryState = React.useCallback((patch: Partial<AnalysisQueryState>) => {
    setQueryState((current) => ({ ...current, ...patch }));
  }, []);

  const toggleUnitFromMap = React.useCallback((unitName: string | null) => {
    if (!unitName) return;
    setQueryState((current) => ({
      ...current,
      unitsSelected: current.unitsSelected.includes(unitName)
        ? current.unitsSelected.filter((item) => item !== unitName)
        : [...current.unitsSelected, unitName],
    }));
  }, []);

  const resetFilters = React.useCallback(() => {
    const nextState = createResetQueryState();
    setQueryState(nextState);
    setIncludeOnlyNewFreqsState(false);
    setError(null);
    pushQueryStateToUrl(nextState);
  }, []);

  const setIncludeOnlyNewFreqs = React.useCallback(
    (value: boolean) => {
      setIncludeOnlyNewFreqsState(value);
      setQueryState((current) => ({
        ...current,
        freqsSelected: value ? data.options.newFreqs : [],
      }));
    },
    [data.options.newFreqs],
  );

  React.useEffect(() => {
    if (!includeOnlyNewFreqs) return;
    setQueryState((current) => ({ ...current, freqsSelected: data.options.newFreqs }));
  }, [data.options.newFreqs, includeOnlyNewFreqs]);

  const selectOnlyFreq = React.useCallback((freq: string) => {
    setQueryState((current) => ({ ...current, freqsSelected: [freq] }));
  }, []);

  const showFreqOnMap = React.useCallback((freq: string) => {
    setCenterTab('map');
    setQueryState((current) => ({ ...current, freqsSelected: [freq] }));
  }, []);

  return {
    authUserName,
    aorEntries: data.aorEntries,
    callsignGraph: data.callsignGraph,
    callsignGraphLoading: data.callsignGraphLoading,
    callsignGraphNolimit: data.callsignGraphNolimit,
    centerTab,
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
    loadedSavedFilter: savedFilters.loadedSavedFilter,
    loading: data.loading,
    mapAttrs: data.mapAttrs,
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
    toggleUnitFromMap,
    saveEditor: editor.saveEditor,
    updateEditorField: editor.updateEditorField,
    updateReport: report.updateReport,
    updateExisting: savedFilters.updateExisting,
    updateQueryState,
  };
}
