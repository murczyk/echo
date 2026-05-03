import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useMediaQuery } from '@mui/material';
import { useTheme } from '@mui/material/styles';

import { isUnauthorizedError } from '../../services/api/client';
import { fetchCurrentUser } from '../../services/api/user';
import { USER_SETTINGS_UPDATED_EVENT, fetchUserSettings } from '../../services/api/user-settings';
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
import type { User } from '../../../../Bindings';
import type { AnalysisPageViewModel, AnalysisQueryState } from './types';
import { useAnalysisData } from './use-analysis-data';
import { useAnalysisMessageEditor } from './use-analysis-message-editor';
import { useAnalysisReport } from './use-analysis-report';
import { useAnalysisSavedFilters } from './use-analysis-saved-filters';
import { DEFAULT_DUTY_TAGS_LAYOUT, type TagsLayoutVariant } from '../rer-duty-neo/utils';
import { getAnalysisSidebarTabs, type AnalysisCenterTab, type AnalysisSidebarTab } from './types';

function initState(): AnalysisQueryState {
  return createInitialQueryState(parseQueryStateFromWindow());
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function useRerAnalysisNeoPage(authUserName: string | null): AnalysisPageViewModel {
  const theme = useTheme();
  const isMobileLayout = useMediaQuery(theme.breakpoints.down('sm'));
  const [initialQueryState] = useState<AnalysisQueryState>(initState);
  const [queryState, setQueryState] = useState<AnalysisQueryState>(initialQueryState);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [lastResetState, setLastResetState] = useState<AnalysisQueryState>(() =>
    hasMeaningfulFiltersBeyondDateRange(initialQueryState) ? createResetQueryState() : initialQueryState,
  );
  const [centerTab, setCenterTabState] = useState<AnalysisCenterTab>('messages');
  const [error, setError] = useState<string | null>(null);
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [newestFirst, setNewestFirst] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [rightSidebarTab, setRightSidebarTab] = useState<AnalysisSidebarTab | null>(null);
  const [tagsLayout, setTagsLayout] = useState<TagsLayoutVariant>(DEFAULT_DUTY_TAGS_LAYOUT);
  const [analysisMapInSidebar, setAnalysisMapInSidebar] = useState(false);
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
    currentUser,
    centerTab,
    newestFirst,
    onError: setPageError,
    onUnauthorized: handleUnauthorized,
    rightPanelOpen,
    rightSidebarVisible: rightPanelOpen || isMobileLayout,
    rightSidebarTab,
    shouldLoadNewCallsigns: (rightPanelOpen || isMobileLayout) && rightSidebarTab === 'newCallsigns',
    queryState,
  });
  const dataFreqValues = useMemo(() => data.options.freqs.map((option) => option.value), [data.options.freqs]);
  const dataNewFreqValues = useMemo(() => data.options.newFreqs.map((option) => option.value), [data.options.newFreqs]);
  const analysisReq = useMemo(() => buildAnalysisReq(queryState, dataFreqValues), [dataFreqValues, queryState]);

  const savedFilters = useAnalysisSavedFilters({
    allFrequencies: dataFreqValues,
    onError: setPageError,
    onUnauthorized: handleUnauthorized,
    queryState,
    setQueryState,
  });

  const report = useAnalysisReport({
    analysisReq,
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
    () => (analysisReq == null ? 'Перевірте дату та час. Дата раніше 2022-01-01 не допускається.' : null),
    [analysisReq],
  );

  const setCenterTab = useCallback((tab: AnalysisCenterTab) => {
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
    if (analysisMapInSidebar) {
      setRightPanelOpen(true);
      setRightSidebarTab('map');
      return;
    }
    setCenterTab('map');
  }, [analysisMapInSidebar, setCenterTab]);

  useEffect(() => {
    const abortController = new AbortController();

    void fetchUserSettings(abortController.signal)
      .then((prefs) => {
        if (abortController.signal.aborted) return;
        setTagsLayout(prefs.tagsLayout);
        setAnalysisMapInSidebar(prefs.analysisMapInSidebar);
      })
      .catch(() => {
        if (abortController.signal.aborted) return;
        setTagsLayout(DEFAULT_DUTY_TAGS_LAYOUT);
        setAnalysisMapInSidebar(false);
      });

    return () => {
      abortController.abort();
    };
  }, []);

  useEffect(() => {
    const abortController = new AbortController();

    void fetchCurrentUser(abortController.signal)
      .then((user) => {
        if (abortController.signal.aborted) return;
        setCurrentUser(user);
      })
      .catch((error) => {
        if (abortController.signal.aborted) return;
        if (isUnauthorizedError(error)) {
          window.location.assign('/login');
          return;
        }
        setCurrentUser(null);
      });

    return () => {
      abortController.abort();
    };
  }, []);

  useEffect(() => {
    const onSettingsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ tagsLayout?: TagsLayoutVariant; analysisMapInSidebar?: boolean }>).detail;
      if (!detail?.tagsLayout) return;
      setTagsLayout(detail.tagsLayout);
      if (detail.analysisMapInSidebar != null) {
        setAnalysisMapInSidebar(detail.analysisMapInSidebar);
      }
    };

    window.addEventListener(USER_SETTINGS_UPDATED_EVENT, onSettingsUpdated as EventListener);
    return () => {
      window.removeEventListener(USER_SETTINGS_UPDATED_EVENT, onSettingsUpdated as EventListener);
    };
  }, []);

  useEffect(() => {
    if (analysisMapInSidebar) {
      if (centerTab === 'map') {
        setCenterTab('messages');
        setRightPanelOpen(true);
        setRightSidebarTab('map');
      }
      if ((rightPanelOpen || isMobileLayout) && rightSidebarTab == null) {
        setRightSidebarTab(getAnalysisSidebarTabs(true)[0]);
      }
      return;
    }

    if (rightSidebarTab === 'map') {
      setRightSidebarTab('stats');
    }
  }, [analysisMapInSidebar, centerTab, isMobileLayout, rightPanelOpen, rightSidebarTab, setCenterTab]);

  const updateQueryState = useCallback((patch: Partial<AnalysisQueryState>) => {
    data.invalidateFilterSectionLoads();
    setQueryState((current) => ({ ...current, ...patch }));
  }, [data.invalidateFilterSectionLoads]);

  const applySavedFilter = useCallback(
    (savedFilter: Parameters<typeof savedFilters.applySavedFilter>[0]) => {
      savedFilters.applySavedFilter(savedFilter);
    },
    [savedFilters],
  );

  useEffect(() => {
    pushQueryStateToUrl(queryState);
  }, [queryState]);

  const toggleUnitFromMap = useCallback((unitName: string | null) => {
    if (!unitName) return;
    data.invalidateFilterSectionLoads();
    setQueryState((current) => ({
      ...current,
      unitsSelected: current.unitsSelected.includes(unitName)
        ? current.unitsSelected.filter((item) => item !== unitName)
        : [...current.unitsSelected, unitName],
    }));
  }, [data.invalidateFilterSectionLoads]);

  const resetFilters = useCallback(() => {
    const nextState = createResetQueryState();
    data.invalidateFilterSectionLoads();
    setQueryState(nextState);
    setLastResetState(nextState);
    setError(null);
    pushQueryStateToUrl(nextState);
  }, [data]);

  const setIncludeOnlyNewFreqs = useCallback(
    (value: boolean) => {
      data.invalidateFilterSectionLoads();
      setQueryState((current) => {
        const freqsSelected = value ? dataNewFreqValues : [];
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
    [data.invalidateFilterSectionLoads, dataNewFreqValues],
  );

  useEffect(() => {
    if (!queryState.includeOnlyNewFreqs) return;
    setQueryState((current) => {
      if (!current.includeOnlyNewFreqs || stringArraysEqual(current.freqsSelected, dataNewFreqValues)) {
        return current;
      }
      return { ...current, freqsSelected: dataNewFreqValues };
    });
  }, [dataNewFreqValues, queryState.includeOnlyNewFreqs]);

  const selectOnlyFreq = useCallback((freq: string) => {
    data.invalidateFilterSectionLoads();
    setQueryState((current) => ({ ...current, includeOnlyNewFreqs: false, freqsSelected: [freq] }));
  }, [data.invalidateFilterSectionLoads]);

  const showFreqOnMap = useCallback((freq: string) => {
    startCenterTabTransition(() => {
      data.invalidateFilterSectionLoads();
      if (analysisMapInSidebar) {
        setRightPanelOpen(true);
        setRightSidebarTab('map');
      } else {
        setCenterTabState('map');
      }
      setQueryState((current) => ({ ...current, includeOnlyNewFreqs: false, freqsSelected: [freq] }));
    });
  }, [analysisMapInSidebar, data.invalidateFilterSectionLoads]);

  const toggleLeftPanel = useCallback(() => {
    setLeftPanelOpen((current) => !current);
  }, []);

  const toggleRightPanel = useCallback(() => {
    setRightPanelOpen((current) => {
      const next = !current;
      if (next && rightSidebarTab == null) {
        setRightSidebarTab(getAnalysisSidebarTabs(analysisMapInSidebar)[0]);
      }
      return next;
    });
  }, [analysisMapInSidebar, rightSidebarTab]);

  useEffect(() => {
    if (!(rightPanelOpen || isMobileLayout) || rightSidebarTab !== 'newCallsigns') return;
    void data.loadNewCallsigns();
  }, [data.loadNewCallsigns, isMobileLayout, rightPanelOpen, rightSidebarTab]);

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
    analysisMapInSidebar,
    currentUser,
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
    hasLoadedInitialMessages: data.hasLoadedInitialMessages,
    includeOnlyNewFreqs: queryState.includeOnlyNewFreqs,
    inboxReq: data.inboxReq,
    isDirty: savedFilters.isDirty,
    leftPanelOpen,
    loadedSavedFilter: savedFilters.loadedSavedFilter,
    mapAttrs: data.mapAttrs,
    messageActionLoading: data.messageActionLoading,
    messagesLoading: data.messagesLoading,
    messagesPaging: data.messagesPaging,
    messageComments: data.messageComments,
    messages: data.messages,
    networkDisplayMap: data.networkDisplayMap,
    networks: data.networks,
    newCallsigns: data.newCallsigns,
    newCallsignsLoading: data.newCallsignsLoading,
    noMoreToLoad: data.noMoreToLoad,
    nolimitShown: data.nolimitShown,
    newestFirst,
    options: data.options,
    onDeleteMessage: data.onDeleteMessage,
    onSaveMessageComment: data.onSaveMessageComment,
    onToggleMessageBookmark: data.onToggleMessageBookmark,
    onToggleMessageImportant: data.onToggleMessageImportant,
    onToggleMessageTag: data.onToggleMessageTag,
    onUpdateLocalMessage: data.onUpdateLocalMessage,
    openEditor: editor.openEditor,
    profiles: data.profiles,
    queryState,
    users: data.users,
    tagsLayout,
    rightPanelOpen,
    rightSidebarTab,
    report: report.report,
    reportDownloadInFlight: report.reportDownloadInFlight,
    reportProgressExpanded: report.reportProgressExpanded,
    reportTaskRuns: report.reportTaskRuns,
    saveInFlight: savedFilters.saveInFlight,
    savedFilterName: savedFilters.savedFilterName,
    savedFilters: savedFilters.savedFilters,
    summaryLoading: data.summaryLoading,
    rightSidebarLoading: data.rightSidebarLoading,
    summaryRows: data.summaryRows,
    summaryCallsignsInfo: data.summaryCallsignsInfo,
    unitsMap: data.unitsMap,
    tagsMap: data.tagsMap,
    topCallsigns: data.topCallsigns,
    topFreqs: data.topFreqs,
    topLocations: data.topLocations,
    topUnits: data.topUnits,
    validationError,
    applySavedFilter,
    deleteLoadedSavedFilter: savedFilters.deleteLoadedSavedFilter,
    renameExistingSavedFilter: savedFilters.renameExisting,
    loadCallsignGraph: data.loadCallsignGraph,
    loadAllMessages: data.loadAllMessages,
    loadFilterSection: data.loadFilterSection,
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
    saveMessageUpdate: editor.saveMessageUpdate,
    repeatReportTaskRun: report.repeatReportTaskRun,
    setReportProgressExpanded: report.setReportProgressExpanded,
    toggleReportTaskRunLogs: report.toggleReportTaskRunLogs,
    updateReport: report.updateReport,
    updateExisting: savedFilters.updateExisting,
    updateQueryState,
  };
}
