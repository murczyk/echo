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
  buildInboxReq,
  ANALYSIS_MESSAGES_PAGE_SIZE,
  createInitialQueryState,
  createResetQueryState,
  extendQueryDateRangeForDirectMessage,
  hasMeaningfulUiFiltersBeyondDateRange,
  parseQueryStateFromWindow,
  pushQueryStateToUrl,
  normalizeQueryState,
  parseAnalysisPanelQueryStateFromWindow,
  queryStateUiComparisonKey,
  shouldOpenAnalysisMapFromSearchParams,
  parseNewestFirstFromWindow,
  parseMessagesPageIndexFromWindow,
  parseMessageUidFromWindow,
  removeMessageUidFromWindowUrl,
  writeMessagesPageIndexToWindowUrl,
  getFirstLoadedMessagesPageIndex,
} from './helpers';
import { fetchInboxWindow } from '../../services/api/inbox-messages';
import type {
  AnalysisCallsignFrequencyMatchesRsp,
  InboxMessage,
  InboxWindowRsp,
  User,
} from '../../../../Bindings';
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

function inboxWindowMatchesMessages(
  inboxWindow: InboxWindowRsp,
  messages: Array<[number, InboxMessage]>,
): boolean {
  if (inboxWindow.inbox.inboxItems.length !== messages.length) return false;
  const messageIds = new Set(messages.map(([messageId]) => messageId));
  return inboxWindow.inbox.inboxItems.every(([messageId]) => messageIds.has(messageId));
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
  const [showPelengDistanceToBattleline, setShowPelengDistanceToBattleline] = useState(false);
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
  const [initialMessagesPageIndex] = useState(parseMessagesPageIndexFromWindow);
  const initialMessagesPageRestoredRef = useRef(initialMessagesPageIndex === 0);
  const [messagePageNavigationTarget, setMessagePageNavigationTarget] = useState<number | null>(
    null,
  );
  const [visibleMessagesPageIndex, setVisibleMessagesPageIndexState] =
    useState(initialMessagesPageIndex);
  const setVisibleMessagesPageIndex = useCallback(
    (pageIndex: number) => {
      const normalizedPageIndex = Math.max(0, Math.floor(pageIndex));
      if (
        !initialMessagesPageRestoredRef.current &&
        normalizedPageIndex !== initialMessagesPageIndex
      ) {
        return;
      }
      setVisibleMessagesPageIndexState(normalizedPageIndex);
      writeMessagesPageIndexToWindowUrl(normalizedPageIndex);
    },
    [initialMessagesPageIndex],
  );
  const [rightPanelOpen, setRightPanelOpen] = useState(
    () => initialPanelQueryState.rightPanelOpen ?? false,
  );
  const [rightSidebarTab, setRightSidebarTab] = useState<AnalysisSidebarTab | null>(() =>
    initialPanelQueryState.rightPanelOpen ? 'stats' : null,
  );
  const [targetMessageUid] = useState(parseMessageUidFromWindow);
  const [targetMessageWindow, setTargetMessageWindow] = useState<InboxWindowRsp | null>(null);
  const [targetMessageLoading, setTargetMessageLoading] = useState(targetMessageUid !== null);
  const [targetMessageContextLoading, setTargetMessageContextLoading] = useState(false);
  const [targetMessageContextResponsePending, setTargetMessageContextResponsePending] =
    useState(false);
  const [targetMessageContextActive, setTargetMessageContextActive] = useState(
    targetMessageUid !== null,
  );
  const [targetMessageFocusActive, setTargetMessageFocusActive] = useState(
    targetMessageUid !== null,
  );
  const targetMessageLoadedRef = useRef(false);
  const targetMessageIdRef = useRef<number | null>(null);
  const targetMessageContextSawReloadRef = useRef(false);
  const [centerTabPending, startCenterTabTransition] = useTransition();
  const setPageError = useCallback((message: string) => setError(message || null), []);
  const dutySettings = useDutySettings();
  const directQueryBoundaryRef = useRef({
    fromDateTimeStr: initialQueryState.fromDateTimeStr,
    toDateTimeStr: initialQueryState.toDateTimeStr,
    search: initialQueryState.search,
  });
  const directMessageWindowQueryState = useMemo(
    () => ({
      ...initialQueryState,
      groupsSelected: queryState.groupsSelected,
      freqsSelected: queryState.freqsSelected,
      networksSelected: queryState.networksSelected,
      withoutNetwork: queryState.withoutNetwork,
    }),
    [
      initialQueryState,
      queryState.freqsSelected,
      queryState.groupsSelected,
      queryState.networksSelected,
      queryState.withoutNetwork,
    ],
  );

  useEffect(() => {
    if (!targetMessageUid || !targetMessageContextActive) return;
    let cancelled = false;
    const isContextRefresh = targetMessageLoadedRef.current;
    if (isContextRefresh) {
      targetMessageContextSawReloadRef.current = false;
      setTargetMessageContextLoading(true);
      setTargetMessageContextResponsePending(true);
    } else {
      setTargetMessageLoading(true);
    }
    void fetchInboxWindow({
      messageRef: targetMessageUid,
      inboxReq: buildInboxReq(directMessageWindowQueryState, [], true),
    })
      .then((res) => {
        if (cancelled) return;
        if (res == null) {
          if (isContextRefresh) {
            setTargetMessageWindow(null);
            setTargetMessageContextActive(false);
            setTargetMessageFocusActive(false);
            removeMessageUidFromWindowUrl();
          } else {
            setTargetMessageContextActive(false);
            setPageError('Не вдалося знайти повідомлення за посиланням.');
          }
          if (!isContextRefresh) setTargetMessageContextLoading(false);
          setTargetMessageContextResponsePending(false);
          return;
        }
        targetMessageLoadedRef.current = true;
        targetMessageIdRef.current = res.targetMessageId;
        const targetMessage = res.inbox.inboxItems.find(
          ([messageId]) => messageId === res.targetMessageId,
        )?.[1];
        if (targetMessage != null) {
          setQueryState((current) => {
            const next = extendQueryDateRangeForDirectMessage(current, targetMessage);
            if (next === current) return current;
            directQueryBoundaryRef.current = {
              fromDateTimeStr: next.fromDateTimeStr,
              toDateTimeStr: next.toDateTimeStr,
              search: next.search,
            };
            return next;
          });
        }
        setTargetMessageWindow(res);
        if (isContextRefresh) setTargetMessageContextResponsePending(false);
      })
      .catch((err) => {
        if (cancelled) return;
        if (!targetMessageLoadedRef.current) {
          setTargetMessageContextActive(false);
        }
        targetMessageContextSawReloadRef.current = false;
        setTargetMessageContextLoading(false);
        setTargetMessageContextResponsePending(false);
        setPageError(`Не вдалося відкрити повідомлення за посиланням: ${toErrorMessage(err)}`);
      })
      .finally(() => {
        if (!cancelled) setTargetMessageLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [directMessageWindowQueryState, setPageError, targetMessageContextActive, targetMessageUid]);

  const clearTargetMessageFocus = useCallback(() => {
    setTargetMessageFocusActive(false);
    removeMessageUidFromWindowUrl();
  }, []);

  useEffect(() => {
    const nextBoundary = {
      fromDateTimeStr: queryState.fromDateTimeStr,
      toDateTimeStr: queryState.toDateTimeStr,
      search: queryState.search,
    };
    const previousBoundary = directQueryBoundaryRef.current;
    directQueryBoundaryRef.current = nextBoundary;
    if (!targetMessageContextActive) return;
    if (
      previousBoundary.fromDateTimeStr === nextBoundary.fromDateTimeStr &&
      previousBoundary.toDateTimeStr === nextBoundary.toDateTimeStr &&
      previousBoundary.search === nextBoundary.search
    ) {
      return;
    }
    setTargetMessageContextActive(false);
    clearTargetMessageFocus();
  }, [
    clearTargetMessageFocus,
    queryState.fromDateTimeStr,
    queryState.search,
    queryState.toDateTimeStr,
    targetMessageContextActive,
  ]);

  const handleUnauthorized = useCallback((errorValue: unknown) => {
    return false;
  }, []);

  const data = useAnalysisData({
    authUserName,
    currentUser,
    deferInitialLoad: !systemSettingsLoaded || targetMessageContextResponsePending,
    focusedWindow: targetMessageWindow,
    focusedMessageActive: targetMessageContextActive,
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
  const firstLoadedMessagesPageIndex = getFirstLoadedMessagesPageIndex(
    data.pageIndex,
    data.messages.length,
  );
  const requestLoadedMessagesPage = useCallback(
    (pageIndex: number) => {
      setVisibleMessagesPageIndex(pageIndex);
      setMessagePageNavigationTarget(pageIndex);
    },
    [setVisibleMessagesPageIndex],
  );
  const messagesPageRestoreInFlightRef = useRef(false);
  useEffect(() => {
    if (initialMessagesPageRestoredRef.current) return;
    if (targetMessageContextActive) {
      initialMessagesPageRestoredRef.current = true;
      return;
    }
    if (
      !data.hasLoadedInitialMessages ||
      data.messagesLoading ||
      data.messagesPaging ||
      messagesPageRestoreInFlightRef.current
    ) {
      return;
    }
    if (data.pageIndex >= initialMessagesPageIndex) {
      initialMessagesPageRestoredRef.current = true;
      requestLoadedMessagesPage(initialMessagesPageIndex);
      return;
    }
    if (data.noMoreToLoad) {
      initialMessagesPageRestoredRef.current = true;
      setVisibleMessagesPageIndex(data.pageIndex);
      return;
    }
    messagesPageRestoreInFlightRef.current = true;
    void data.loadMoreMessages().finally(() => {
      messagesPageRestoreInFlightRef.current = false;
    });
  }, [
    data.hasLoadedInitialMessages,
    data.loadMoreMessages,
    data.messagesLoading,
    data.messagesPaging,
    data.noMoreToLoad,
    data.pageIndex,
    initialMessagesPageIndex,
    requestLoadedMessagesPage,
    setVisibleMessagesPageIndex,
    targetMessageContextActive,
  ]);
  const clearMessagePageNavigationTarget = useCallback(() => {
    setMessagePageNavigationTarget(null);
  }, []);
  const directTargetMessageIndex = targetMessageWindow
    ? newestFirst
      ? targetMessageWindow.messagesAfter
      : targetMessageWindow.messagesBefore
    : null;
  const loadDirectAdjacentPage = useCallback(
    async (targetPageIndex: number) => {
      if (!targetMessageContextActive || directTargetMessageIndex == null) return false;
      const targetLocalIndex = data.messages.findIndex(
        ([messageId]) => messageId === targetMessageWindow?.targetMessageId,
      );
      if (targetLocalIndex < 0) return false;
      clearTargetMessageFocus();
      const firstLoadedMessageIndex = directTargetMessageIndex - targetLocalIndex;
      const lastLoadedMessageIndex = firstLoadedMessageIndex + data.messages.length - 1;
      const targetMessageIndex = targetPageIndex * ANALYSIS_MESSAGES_PAGE_SIZE;
      if (
        targetMessageIndex >= firstLoadedMessageIndex &&
        targetMessageIndex <= lastLoadedMessageIndex
      ) {
        requestLoadedMessagesPage(targetPageIndex);
        return true;
      }

      const load =
        targetMessageIndex < firstLoadedMessageIndex
          ? newestFirst
            ? data.loadFocusedLater
            : data.loadFocusedEarlier
          : newestFirst
            ? data.loadFocusedEarlier
            : data.loadFocusedLater;
      const loaded = await load();
      if (loaded) requestLoadedMessagesPage(targetPageIndex);
      return loaded;
    },
    [
      data.loadFocusedEarlier,
      data.loadFocusedLater,
      data.messages,
      clearTargetMessageFocus,
      directTargetMessageIndex,
      newestFirst,
      requestLoadedMessagesPage,
      targetMessageContextActive,
      targetMessageWindow?.targetMessageId,
    ],
  );
  const loadFirstPage = useCallback(async () => {
    if (visibleMessagesPageIndex === 0) return;
    if (firstLoadedMessagesPageIndex === 0) {
      requestLoadedMessagesPage(0);
      return;
    }
    await data.loadFirstPage();
  }, [
    data.loadFirstPage,
    firstLoadedMessagesPageIndex,
    requestLoadedMessagesPage,
    visibleMessagesPageIndex,
  ]);
  const loadLastPage = useCallback(async () => {
    if (data.messagesTotalCount == null || data.messagesTotalCount === 0) return;
    const lastPageIndex = Math.max(
      0,
      Math.ceil(data.messagesTotalCount / ANALYSIS_MESSAGES_PAGE_SIZE) - 1,
    );
    if (visibleMessagesPageIndex === lastPageIndex) return;
    if (lastPageIndex >= firstLoadedMessagesPageIndex && lastPageIndex <= data.pageIndex) {
      requestLoadedMessagesPage(lastPageIndex);
      return;
    }
    await data.loadLastPage();
  }, [
    data.loadLastPage,
    data.messagesTotalCount,
    data.pageIndex,
    firstLoadedMessagesPageIndex,
    requestLoadedMessagesPage,
    visibleMessagesPageIndex,
  ]);
  const loadNextPage = useCallback(async () => {
    const targetPageIndex = visibleMessagesPageIndex + 1;
    if (targetMessageContextActive) {
      await loadDirectAdjacentPage(targetPageIndex);
      return;
    }
    if (targetPageIndex <= data.pageIndex) {
      requestLoadedMessagesPage(targetPageIndex);
      return;
    }
    await data.loadNextPage();
  }, [
    data.loadNextPage,
    data.pageIndex,
    loadDirectAdjacentPage,
    requestLoadedMessagesPage,
    targetMessageContextActive,
    visibleMessagesPageIndex,
  ]);
  const loadPrevPage = useCallback(async () => {
    const targetPageIndex = visibleMessagesPageIndex - 1;
    if (targetPageIndex < 0) return;
    if (targetMessageContextActive) {
      await loadDirectAdjacentPage(targetPageIndex);
      return;
    }
    if (targetPageIndex >= firstLoadedMessagesPageIndex) {
      requestLoadedMessagesPage(targetPageIndex);
      return;
    }
    await data.loadPrevPage(targetPageIndex);
  }, [
    data.loadPrevPage,
    firstLoadedMessagesPageIndex,
    loadDirectAdjacentPage,
    requestLoadedMessagesPage,
    targetMessageContextActive,
    visibleMessagesPageIndex,
  ]);
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
        setShowPelengDistanceToBattleline(settings.showPelengDistanceToBattleline);
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

  const groupInfos = data.groupInfos;
  const profiles = data.profiles;

  useEffect(() => {
    if (!targetMessageContextLoading || targetMessageContextResponsePending) return;

    if (targetMessageContextActive) {
      if (
        targetMessageWindow == null ||
        !inboxWindowMatchesMessages(targetMessageWindow, data.messages)
      ) {
        return;
      }
    } else {
      if (data.messagesLoading) {
        targetMessageContextSawReloadRef.current = true;
        return;
      }
      if (
        !targetMessageContextSawReloadRef.current &&
        data.messages.some(([messageId]) => messageId === targetMessageIdRef.current)
      ) {
        return;
      }
    }

    targetMessageContextSawReloadRef.current = false;
    setTargetMessageContextLoading(false);
  }, [
    data.messages,
    data.messagesLoading,
    targetMessageContextActive,
    targetMessageContextLoading,
    targetMessageContextResponsePending,
    targetMessageWindow,
  ]);

  const directMessageNavigation = useMemo(() => {
    if (!targetMessageContextActive || targetMessageWindow == null) return null;
    const targetMessageId = targetMessageWindow.targetMessageId;
    const targetMessageIndex = newestFirst
      ? targetMessageWindow.messagesAfter
      : targetMessageWindow.messagesBefore;
    const contextLoading = targetMessageContextLoading || data.messagesLoading;
    return {
      targetMessageId,
      targetMessageIndex,
      totalCount: targetMessageWindow.messagesBefore + targetMessageWindow.messagesAfter + 1,
      focusActive: targetMessageFocusActive,
      contextLoading,
      newestFirst,
      canLoadEarlier: data.focusedHasMoreEarlier,
      canLoadLater: data.focusedHasMoreLater,
      loadingEarlier: contextLoading || data.focusedLoadingEarlier,
      loadingLater: contextLoading || data.focusedLoadingLater,
      onClearFocus: clearTargetMessageFocus,
      onLoadEarlier: data.loadFocusedEarlier,
      onLoadLater: data.loadFocusedLater,
    };
  }, [
    clearTargetMessageFocus,
    data.focusedHasMoreEarlier,
    data.focusedHasMoreLater,
    data.focusedLoadingEarlier,
    data.focusedLoadingLater,
    data.messagesLoading,
    data.loadFocusedEarlier,
    data.loadFocusedLater,
    newestFirst,
    targetMessageWindow,
    targetMessageContextActive,
    targetMessageContextLoading,
    targetMessageFocusActive,
  ]);
  const directMessageLoading =
    targetMessageContextLoading ||
    (targetMessageUid !== null &&
      targetMessageContextActive &&
      (targetMessageLoading ||
        targetMessageWindow == null ||
        !data.messages.some(([messageId]) => messageId === targetMessageWindow.targetMessageId)));

  useEffect(() => {
    if (directMessageNavigation == null) return;
    setVisibleMessagesPageIndex(
      Math.floor(directMessageNavigation.targetMessageIndex / ANALYSIS_MESSAGES_PAGE_SIZE),
    );
  }, [directMessageNavigation?.targetMessageId, directMessageNavigation?.targetMessageIndex]);

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
    editorEditAsReport: editor.editorEditAsReport,
    editTargetLoadState: editor.editTargetLoadState,
    reportSource: editor.reportSource,
    editorSaveInFlight: editor.editorSaveInFlight,
    error,
    filtersLoading: data.filtersLoading,
    filterSectionLoadStates: data.filterSectionLoadStates,
    isFilterSectionLoading: data.isFilterSectionLoading,
    isFilterSectionEmptyLoading: data.isFilterSectionEmptyLoading,
    isFilterSectionStale: data.isFilterSectionStale,
    groupInfos,
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
    mapAttrs: {
      ...data.mapAttrs,
      showPelengDistanceToBattleline: showPelengDistanceToBattleline ? 'true' : 'false',
    },
    messageActionLoading: data.messageActionLoading,
    botTagAction: data.botTagAction,
    messagesLoading: targetMessageLoading || data.messagesLoading,
    messagesOverallCount: data.messagesOverallCount,
    messagesPaging: data.messagesPaging,
    messagesTotalCount: directMessageNavigation?.totalCount ?? data.messagesTotalCount,
    messagesTotalLoading:
      directMessageNavigation == null ? data.messagesTotalLoading : targetMessageContextLoading,
    messageComments: data.messageComments,
    messages: data.messages,
    directMessageLoading,
    directMessageNavigation,
    networkDisplayMap: data.networkDisplayMap,
    networks: data.networks,
    newCallsigns: data.newCallsigns,
    newCallsignsLoading: data.newCallsignsLoading,
    noMoreToLoad: data.noMoreToLoad,
    nolimitShown: data.nolimitShown,
    pageIndex: data.pageIndex,
    messagePageNavigationTarget,
    visibleMessagesPageIndex,
    newestFirst,
    options: data.options,
    onDeleteMessage: data.onDeleteMessage,
    onCancelBotTagAction: data.onCancelBotTagAction,
    onMarkBotTagWrong: data.onMarkBotTagWrong,
    onToggleMessageBookmark: data.onToggleMessageBookmark,
    onToggleMessageImportant: data.onToggleMessageImportant,
    onToggleMessageTag: data.onToggleMessageTag,
    onAddPointHighlightBlacklist: data.onAddPointHighlightBlacklist,
    onPrependLocalMessage: data.onPrependLocalMessage,
    onUpdateLocalMessage: data.onUpdateLocalMessage,
    openEditor: editor.openEditor,
    openReportCreator: editor.openReportCreator,
    openReportEditor: editor.openReportEditor,
    retryEditTargetLoad: editor.retryEditTargetLoad,
    profiles,
    queryState,
    tagsLayout: dutySettings.tagsLayout,
    mediaSummaryEnabled: dutySettings.mediaSummaryEnabled,
    collapseMediaPreviews: dutySettings.dutyCollapseMediaPreviews,
    messageTextPreviewLines: dutySettings.messageTextPreviewLines,
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
    loadFirstPage,
    loadLastPage,
    loadNextPage,
    loadMoreMessages: data.loadMoreMessages,
    loadPrevPage,
    loadMessagesForMap: data.loadMessagesForMap,
    loadSettlementMessagesForMap: data.loadSettlementMessagesForMap,
    closeReport: report.closeReport,
    closeEditor: editor.closeEditor,
    downloadGeojson: data.downloadGeojson,
    downloadKmz: data.downloadKmz,
    downloadSummaryXlsx: data.downloadSummaryXlsx,
    downloadReport: report.downloadReport,
    openReport: report.openReport,
    refreshMapDateRange: data.refreshMapDateRange,
    setShowSettlements: data.setShowSettlements,
    renameSummaryUnit: data.renameSummaryUnit,
    reload: data.reload,
    resetFilters,
    saveAsNew: savedFilters.saveAsNew,
    setIncludeOnlyNewFreqs,
    selectOnlyFreq,
    openPointsOnMap,
    setCenterTab,
    setNewestFirst,
    clearMessagePageNavigationTarget,
    setVisibleMessagesPageIndex,
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
    unitsExactMatchOnlyDefault,
    supportNonRerInterceptions,
    cyberEchoEnabled,
    updateReport: report.updateReport,
    updateExisting: savedFilters.updateExisting,
    updateQueryState,
  };
}
