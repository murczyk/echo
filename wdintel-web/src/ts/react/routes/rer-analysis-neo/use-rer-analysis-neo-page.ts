import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useMediaQuery } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { isNullOrUndefined } from '../../utils/misc';

import { fetchCurrentUser } from '../../services/api/user';
import { currentSystemSettings } from '../../services/api/system-settings';
import {
  normalizeUnknownUnitFilterValue,
  normalizeUnknownUnitSelections,
} from '../shared/analysis-unit-filter';
import {
  buildAnalysisReq,
  createInitialQueryState,
  createResetQueryState,
  hasMeaningfulUiFiltersBeyondDateRange,
  parseQueryStateFromWindow,
  pushQueryStateToUrl,
  normalizeQueryState,
  parseAnalysisPanelQueryStateFromWindow,
  queryStateUiComparisonKey,
  shouldOpenAnalysisMapFromSearchParams,
  parseNewestFirstFromWindow,
} from './helpers';
import type { AnalysisCallsignFrequencyMatchesRsp, InboxMessage, User } from '../../../../Bindings';
import type { AnalysisFilterSectionId, AnalysisPageViewModel, AnalysisQueryState } from './types';
import { useAnalysisData } from './use-analysis-data';
import { useAnalysisMessageEditor } from './use-analysis-message-editor';
import { useAnalysisReport } from './use-analysis-report';
import { useAnalysisSavedFilters } from './use-analysis-saved-filters';
import { useDutySettings } from '../../hooks/use-duty-settings';
import { uniquePointEtalonsForMapSearch } from '../rer-duty-neo/utils';
import { getAnalysisSidebarTabs, type AnalysisCenterTab, type AnalysisSidebarTab } from './types';
import { fetchAnalysisCallsignFrequencyMatches } from '../../services/api/analysis';
import { toErrorMessage } from './use-analysis-data.shared';

function initState(): AnalysisQueryState {
  return createInitialQueryState(parseQueryStateFromWindow());
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function useRerAnalysisNeoPage(authUserName: string | null): AnalysisPageViewModel {
  const theme = useTheme();
  const isMobileLayout = useMediaQuery(theme.breakpoints.down('sm'));
  const isStackedFiltersLayout = useMediaQuery(theme.breakpoints.down('lg'));
  const [initialPanelQueryState] = useState(parseAnalysisPanelQueryStateFromWindow);
  const [initialQueryState] = useState<AnalysisQueryState>(initState);
  const [queryState, setQueryState] = useState<AnalysisQueryState>(initialQueryState);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [systemSettingsLoaded, setSystemSettingsLoaded] = useState(false);
  const [unitsExactMatchOnlyDefault, setUnitsExactMatchOnlyDefault] = useState<boolean | null>(
    null,
  );
  const [supportNonRerInterceptions, setSupportNonRerInterceptions] = useState(false);
  const [cyberEchoEnabled, setCyberEchoEnabled] = useState(false);
  const [audioTranscriptionEnabled, setAudioTranscriptionEnabled] = useState(false);
  const [lastResetState, setLastResetState] = useState<AnalysisQueryState>(() =>
    hasMeaningfulUiFiltersBeyondDateRange(initialQueryState)
      ? createResetQueryState()
      : initialQueryState,
  );
  const [centerTab, setCenterTabState] = useState<AnalysisCenterTab>('messages');
  const [error, setError] = useState<string | null>(null);
  const [leftPanelOpen, setLeftPanelOpen] = useState(
    () => initialPanelQueryState.leftPanelOpen ?? !isStackedFiltersLayout,
  );
  const leftPanelTouchedRef = useRef(initialPanelQueryState.leftPanelOpen != null);
  const [newestFirst, setNewestFirst] = useState(parseNewestFirstFromWindow);
  const [rightPanelOpen, setRightPanelOpen] = useState(
    () => initialPanelQueryState.rightPanelOpen ?? false,
  );
  const [rightSidebarTab, setRightSidebarTab] = useState<AnalysisSidebarTab | null>(() =>
    initialPanelQueryState.rightPanelOpen ? 'stats' : null,
  );
  const [centerTabPending, startCenterTabTransition] = useTransition();
  const setPageError = useCallback((message: string) => setError(message || null), []);
  const dutySettings = useDutySettings();

  const handleUnauthorized = useCallback((errorValue: unknown) => {
    return false;
  }, []);

  const data = useAnalysisData({
    authUserName,
    currentUser,
    deferInitialLoad: !systemSettingsLoaded,
    leftPanelOpen,
    centerTab,
    newestFirst,
    onError: setPageError,
    onUnauthorized: handleUnauthorized,
    rightPanelOpen,
    rightSidebarVisible: rightPanelOpen,
    rightSidebarTab,
    shouldLoadNewCallsigns: rightPanelOpen && rightSidebarTab === 'newCallsigns',
    queryState,
  });
  const dataFreqValues = useMemo(
    () => data.options.freqs.map((option) => option.value),
    [data.options.freqs],
  );
  const dataNewFreqValues = useMemo(
    () => data.options.newFreqs.map((option) => option.value),
    [data.options.newFreqs],
  );
  const analysisReq = useMemo(
    () => buildAnalysisReq(queryState, dataFreqValues),
    [dataFreqValues, queryState],
  );

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
    () =>
      isNullOrUndefined(analysisReq)
        ? 'Перевірте дату та час. Дата раніше 2022-01-01 не допускається.'
        : null,
    [analysisReq],
  );

  const findCallsignFrequencyMatches = useCallback(
    async (
      callsigns: string[],
      minMatches: number,
    ): Promise<AnalysisCallsignFrequencyMatchesRsp | null> => {
      if (isNullOrUndefined(analysisReq)) {
        setPageError('Перевірте дату та час перед пошуком частот.');
        return null;
      }

      try {
        return await fetchAnalysisCallsignFrequencyMatches({
          req: analysisReq,
          callsigns,
          minMatches,
        });
      } catch (loadError) {
        if (!handleUnauthorized(loadError)) setPageError(toErrorMessage(loadError));
        return null;
      }
    },
    [analysisReq, handleUnauthorized, setPageError],
  );

  const setCenterTab = useCallback((tab: AnalysisCenterTab) => {
    startCenterTabTransition(() => {
      setCenterTabState(tab);
    });
  }, []);

  useEffect(() => {
    if (leftPanelTouchedRef.current) return;
    setLeftPanelOpen(!isStackedFiltersLayout);
  }, [isStackedFiltersLayout]);

  const showMapDeepLinkAppliedRef = useRef(false);
  useEffect(() => {
    if (showMapDeepLinkAppliedRef.current) return;
    if (typeof window === 'undefined') return;
    if (!shouldOpenAnalysisMapFromSearchParams(new URLSearchParams(window.location.search))) return;
    showMapDeepLinkAppliedRef.current = true;
    if (dutySettings.analysisMapInSidebar) {
      setRightPanelOpen(true);
      setRightSidebarTab('map');
      return;
    }
    setCenterTab('map');
  }, [dutySettings.analysisMapInSidebar, setCenterTab]);

  useEffect(() => {
    const abortController = new AbortController();

    void currentSystemSettings()
      .then((settings) => {
        if (abortController.signal.aborted) return;
        setUnitsExactMatchOnlyDefault(settings.rerAnalysisUnitsExactMatchOnlyDefault);
        setSupportNonRerInterceptions(settings.supportNonRerInterceptions);
        setCyberEchoEnabled(settings.devicesSectionEnabled);
        setAudioTranscriptionEnabled(settings.enableAudioTranscription ?? false);
      })
      .catch(() => {
        if (abortController.signal.aborted) return;
        setPageError('Не вдалося завантажити системні налаштування.');
      })
      .finally(() => {
        if (abortController.signal.aborted) return;
        setSystemSettingsLoaded(true);
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
        setCurrentUser(null);
      });

    return () => {
      abortController.abort();
    };
  }, []);

  useEffect(() => {
    if (rightPanelOpen && isNullOrUndefined(rightSidebarTab)) {
      setRightSidebarTab(getAnalysisSidebarTabs(dutySettings.analysisMapInSidebar)[0]);
    }

    if (dutySettings.analysisMapInSidebar) {
      if (centerTab === 'map') {
        setCenterTab('messages');
        setRightPanelOpen(true);
        setRightSidebarTab('map');
      }
      return;
    }

    if (rightSidebarTab === 'map') {
      setRightSidebarTab('stats');
    }
  }, [
    centerTab,
    dutySettings.analysisMapInSidebar,
    isMobileLayout,
    rightPanelOpen,
    rightSidebarTab,
    setCenterTab,
  ]);

  const updateQueryState = useCallback(
    (patch: Partial<AnalysisQueryState>) => {
      const normalizedPatch =
        patch.unitsSelected?.length === 0 ? { ...patch, unitsExactMatchOnly: null } : patch;
      data.invalidateFilterSectionLoadsForPatch(normalizedPatch);
      setQueryState((current) => normalizeQueryState({ ...current, ...normalizedPatch }));
    },
    [data.invalidateFilterSectionLoadsForPatch],
  );

  const applySavedFilter = useCallback(
    (savedFilter: Parameters<typeof savedFilters.applySavedFilter>[0]) => {
      if (savedFilter != null) {
        data.invalidateFilterSectionLoads();
      }
      savedFilters.applySavedFilter(savedFilter);
    },
    [data.invalidateFilterSectionLoads, savedFilters],
  );

  useEffect(() => {
    if (!systemSettingsLoaded) return;
    pushQueryStateToUrl(queryState, newestFirst, { leftPanelOpen, rightPanelOpen });
  }, [leftPanelOpen, newestFirst, queryState, rightPanelOpen, systemSettingsLoaded]);

  const toggleUnitFromMap = useCallback(
    (unitName: string | null) => {
      if (unitName === null) return;
      const normalizedUnitName = normalizeUnknownUnitFilterValue(unitName);
      data.invalidateFilterSectionLoadsForPatch({
        unitsExactMatchOnly: false,
        unitsSelected: [],
      });
      setQueryState((current) => {
        const normalizedUnits = normalizeUnknownUnitSelections(current.unitsSelected);
        const isSelected = normalizedUnits.includes(normalizedUnitName);
        const unitsSelected = isSelected
          ? normalizedUnits.filter((item) => item !== normalizedUnitName)
          : [...normalizedUnits, normalizedUnitName];
        return {
          ...current,
          unitsExactMatchOnly:
            unitsSelected.length === 0 ? null : isSelected ? current.unitsExactMatchOnly : false,
          unitsSelected,
        };
      });
    },
    [data.invalidateFilterSectionLoadsForPatch],
  );

  const resetFilters = useCallback(() => {
    const nextState = createResetQueryState();
    savedFilters.applySavedFilter(null);
    data.invalidateFilterSectionLoads();
    setQueryState(nextState);
    setLastResetState(nextState);
    setError(null);
    pushQueryStateToUrl(nextState, newestFirst);
  }, [data, savedFilters, newestFirst]);

  const setIncludeOnlyNewFreqs = useCallback(
    (value: boolean) => {
      data.invalidateFilterSectionLoadsForPatch({
        includeOnlyNewFreqs: value,
        freqsSelected: value ? dataNewFreqValues : [],
      });
      setQueryState((current) => {
        const freqsSelected = value ? dataNewFreqValues : [];
        if (
          current.includeOnlyNewFreqs === value &&
          stringArraysEqual(current.freqsSelected, freqsSelected)
        ) {
          return current;
        }
        return {
          ...current,
          includeOnlyNewFreqs: value,
          freqsSelected,
        };
      });
    },
    [data.invalidateFilterSectionLoadsForPatch, dataNewFreqValues],
  );

  useEffect(() => {
    if (!queryState.includeOnlyNewFreqs) return;
    if (stringArraysEqual(queryState.freqsSelected, dataNewFreqValues)) return;

    data.invalidateFilterSectionLoadsForPatch({ freqsSelected: dataNewFreqValues });
    setQueryState((current) => {
      if (
        !current.includeOnlyNewFreqs ||
        stringArraysEqual(current.freqsSelected, dataNewFreqValues)
      ) {
        return current;
      }
      return { ...current, freqsSelected: dataNewFreqValues };
    });
  }, [
    data.invalidateFilterSectionLoadsForPatch,
    dataNewFreqValues,
    queryState.includeOnlyNewFreqs,
  ]);

  const selectOnlyFreq = useCallback(
    (freq: string) => {
      data.invalidateFilterSectionLoadsForPatch({
        freqsSelected: [freq],
        includeOnlyNewFreqs: false,
      });
      setQueryState((current) => ({
        ...current,
        includeOnlyNewFreqs: false,
        freqsSelected: [freq],
      }));
    },
    [data.invalidateFilterSectionLoadsForPatch],
  );

  const addFrequencyToFilter = useCallback(
    (freq: string) => {
      const trimmed = freq.trim();
      if (trimmed === '') return;
      data.invalidateFilterSectionLoadsForPatch({ freqsSelected: [trimmed] });
      setRightPanelOpen(true);
      setRightSidebarTab('stats');
      setQueryState((current) => {
        const nextFreqsSelected = current.freqsSelected.includes(trimmed)
          ? current.freqsSelected
          : [...current.freqsSelected, trimmed];
        if (
          !current.includeOnlyNewFreqs &&
          stringArraysEqual(current.freqsSelected, nextFreqsSelected)
        ) {
          return current;
        }
        return {
          ...current,
          includeOnlyNewFreqs: false,
          freqsSelected: nextFreqsSelected,
        };
      });
    },
    [data.invalidateFilterSectionLoadsForPatch, setRightSidebarTab],
  );

  const showFreqOnMap = useCallback(
    (freq: string) => {
      startCenterTabTransition(() => {
        data.invalidateFilterSectionLoadsForPatch({
          freqsSelected: [freq],
          includeOnlyNewFreqs: false,
        });
        if (dutySettings.analysisMapInSidebar) {
          setRightPanelOpen(true);
          setRightSidebarTab('map');
        } else {
          setCenterTabState('map');
        }
        setQueryState((current) => ({
          ...current,
          includeOnlyNewFreqs: false,
          freqsSelected: [freq],
        }));
      });
    },
    [data.invalidateFilterSectionLoadsForPatch, dutySettings.analysisMapInSidebar],
  );

  const openPointsOnMap = useCallback(
    (etalons: string[], _message: InboxMessage) => {
      const search = uniquePointEtalonsForMapSearch(etalons).join(',');
      if (search === '') {
        return;
      }

      startCenterTabTransition(() => {
        data.invalidateFilterSectionLoadsForPatch({
          search,
        });
        if (dutySettings.analysisMapInSidebar) {
          setRightPanelOpen(true);
          setRightSidebarTab('map');
        } else {
          setCenterTabState('map');
        }
        setQueryState((current) => ({
          ...current,
          search,
        }));
      });
    },
    [data.invalidateFilterSectionLoadsForPatch, dutySettings.analysisMapInSidebar],
  );

  const toggleLeftPanel = useCallback(() => {
    leftPanelTouchedRef.current = true;
    setLeftPanelOpen((current) => !current);
  }, []);

  const toggleRightPanel = useCallback(() => {
    setRightPanelOpen((current) => {
      const next = !current;
      if (next && isNullOrUndefined(rightSidebarTab)) {
        setRightSidebarTab(getAnalysisSidebarTabs(dutySettings.analysisMapInSidebar)[0]);
      }
      return next;
    });
  }, [dutySettings.analysisMapInSidebar, rightSidebarTab]);

  useEffect(() => {
    if (!rightPanelOpen || rightSidebarTab !== 'newCallsigns') return;
    void data.loadNewCallsigns();
  }, [data.loadNewCallsigns, isMobileLayout, rightPanelOpen, rightSidebarTab]);

  useEffect(() => {
    const sections = new Set<AnalysisFilterSectionId>();
    if (leftPanelOpen) {
      (['tags', 'groups', 'senders'] as const).forEach((section) => sections.add(section));
    }
    if (rightPanelOpen && rightSidebarTab === 'stats') sections.add('groups');
    if (rightPanelOpen && rightSidebarTab === 'callsigns') sections.add('callsigns');
    if (sections.size === 0) return;
    void Promise.all(Array.from(sections, (section) => data.loadFilterSection(section)));
  }, [data.loadFilterSection, leftPanelOpen, rightPanelOpen, rightSidebarTab]);

  const canResetFilters = useMemo(() => {
    const queryStateKey = queryStateUiComparisonKey(queryState);
    const lastResetStateKey = queryStateUiComparisonKey(lastResetState);
    if (isNullOrUndefined(queryStateKey) || isNullOrUndefined(lastResetStateKey)) return false;

    return queryStateKey !== lastResetStateKey;
  }, [lastResetState, queryState]);

  return {
    authUserName,
    aorEntries: data.aorEntries,
    canResetFilters,
    analysisMapInSidebar: dutySettings.analysisMapInSidebar,
    showAnalysisCallsignAddForm: dutySettings.showAnalysisCallsignAddForm,
    currentUser,
    callsignGraph: data.callsignGraph,
    callsignGraphLoading: data.callsignGraphLoading,
    callsignGraphLoadVersion: data.callsignGraphLoadVersion,
    callsignGraphLoadError: data.callsignGraphLoadError,
    centerTab,
    centerTabPending,
    copiedFeedbackId: null,
    correlatedFreqs: data.correlatedFreqs,
    correlatedFreqsLoaded: data.correlatedFreqsLoaded,
    correlatedFreqsLoading: data.correlatedFreqsLoading,
    counts: data.counts,
    countsLoading: data.countsLoading,
    editorMessage: editor.editorMessage,
    editorSaveInFlight: editor.editorSaveInFlight,
    error,
    filtersLoading: data.filtersLoading,
    filterSectionLoadStates: data.filterSectionLoadStates,
    isFilterSectionLoading: data.isFilterSectionLoading,
    isFilterSectionEmptyLoading: data.isFilterSectionEmptyLoading,
    isFilterSectionStale: data.isFilterSectionStale,
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
    botTagAction: data.botTagAction,
    messagesLoading: data.messagesLoading,
    messagesOverallCount: data.messagesOverallCount,
    messagesPaging: data.messagesPaging,
    messagesTotalCount: data.messagesTotalCount,
    messagesTotalLoading: data.messagesTotalLoading,
    messageComments: data.messageComments,
    messages: data.messages,
    networkDisplayMap: data.networkDisplayMap,
    networks: data.networks,
    newCallsigns: data.newCallsigns,
    newCallsignsLoading: data.newCallsignsLoading,
    noMoreToLoad: data.noMoreToLoad,
    nolimitShown: data.nolimitShown,
    pageIndex: data.pageIndex,
    newestFirst,
    options: data.options,
    onDeleteMessage: data.onDeleteMessage,
    onCancelBotTagAction: data.onCancelBotTagAction,
    onMarkBotTagWrong: data.onMarkBotTagWrong,
    onSaveMessageComment: data.onSaveMessageComment,
    onToggleMessageBookmark: data.onToggleMessageBookmark,
    onToggleMessageImportant: data.onToggleMessageImportant,
    onToggleMessageTag: data.onToggleMessageTag,
    onPrependLocalMessage: data.onPrependLocalMessage,
    onUpdateLocalMessage: data.onUpdateLocalMessage,
    openEditor: editor.openEditor,
    profiles: data.profiles,
    queryState,
    tagsLayout: dutySettings.tagsLayout,
    audioTranscriptionCollapsed: dutySettings.analysisAudioTranscriptionCollapsed,
    audioTranscriptionEnabled,
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
    summaryLoaded: data.summaryLoaded,
    summaryHasLoadedOnce: data.summaryHasLoadedOnce,
    rightSidebarLoading: data.rightSidebarLoading,
    summaryRows: data.summaryRows,
    summaryCallsignsInfo: data.summaryCallsignsInfo,
    unitsMap: data.unitsMap,
    tagsMap: data.tagsMap,
    tagsOrder: data.tagsOrder,
    topCallsigns: data.topCallsigns,
    topFreqs: data.topFreqs,
    topLocations: data.topLocations,
    topUnits: data.topUnits,
    validationError,
    applySavedFilter,
    deleteLoadedSavedFilter: savedFilters.deleteLoadedSavedFilter,
    renameExistingSavedFilter: savedFilters.renameExisting,
    findCallsignFrequencyMatches,
    loadCallsignGraph: data.loadCallsignGraph,
    loadAllMessages: data.loadAllMessages,
    loadFilterSection: data.loadFilterSection,
    loadCorrelatedFreqs: data.loadCorrelatedFreqs,
    loadGroupsActivity: data.loadGroupsActivity,
    loadNewCallsigns: data.loadNewCallsigns,
    loadFirstPage: data.loadFirstPage,
    loadLastPage: data.loadLastPage,
    loadNextPage: data.loadNextPage,
    loadMoreMessages: data.loadMoreMessages,
    loadPrevPage: data.loadPrevPage,
    loadMessagesForMap: data.loadMessagesForMap,
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
    openPointsOnMap,
    setCenterTab,
    setNewestFirst,
    setRightSidebarTab,
    setSavedFilterName: savedFilters.setSavedFilterName,
    addFrequencyToFilter,
    showFreqOnMap,
    toggleLeftPanel,
    toggleRightPanel,
    toggleUnitFromMap,
    saveEditor: editor.saveEditor,
    saveMessageUpdate: editor.saveMessageUpdate,
    repeatReportTaskRun: report.repeatReportTaskRun,
    setReportProgressExpanded: report.setReportProgressExpanded,
    toggleReportTaskRunLogs: report.toggleReportTaskRunLogs,
    unitsExactMatchOnlyDefault,
    supportNonRerInterceptions,
    cyberEchoEnabled,
    updateReport: report.updateReport,
    updateExisting: savedFilters.updateExisting,
    updateQueryState,
  };
}
