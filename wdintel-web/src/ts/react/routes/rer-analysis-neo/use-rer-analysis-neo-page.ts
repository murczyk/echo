import type { ReplyNavigation } from '../shared/message-replies/MessageRepliesProvider';
import {
  readThreadMessageId,
  THREAD_MESSAGE_PARAM,
} from '../shared/message-replies/thread-analysis-link';
import { canWriteMessages } from '../../utils/roles';
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useMediaQuery } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { isNullOrUndefined } from '../../utils/misc';

import { fetchCurrentUser } from '../../services/api/user';
import { currentSystemSettings } from '../../services/api/system-settings';
import { effectiveRadioQuery } from './radio-features';
import { canUseRadioFeatures, canUseMessageDevices } from '../../utils/roles';
import {
  normalizeUnknownUnitFilterValue,
  normalizeUnknownUnitSelections,
} from '../shared/analysis-unit-filter';
import {
  buildAnalysisReq,
  buildInboxReq,
  ANALYSIS_MESSAGES_PAGE_SIZE,
  ANALYSIS_MESSAGE_WINDOW_LIMIT,
  createInitialQueryState,
  createResetQueryState,
  adjustQueryDateRangeForDirectMessage,
  hasMeaningfulUiFiltersBeyondDateRange,
  hasQueryStateInWindow,
  parseQueryStateFromWindow,
  pushQueryStateToUrl,
  normalizeQueryState,
  parseAnalysisPanelQueryStateFromWindow,
  queryStateUiComparisonKey,
  shouldOpenAnalysisMapFromSearchParams,
  parseNewestFirstFromWindow,
  parseMessagesPageIndexFromWindow,
  parseMessageUidFromWindow,
  readAnalysisGroupScopeFromUrl,
  removeMessageUidFromWindowUrl,
  writeAnalysisGroupScopeToUrl,
  writeMessagesPageIndexToWindowUrl,
} from './helpers';
import { fetchInboxWindow } from '../../services/api/inbox-messages';
import {
  createMessageNavigationController,
  messageNavigationErrorText,
  type MessageNavigationController,
} from '../shared/message-navigation';
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
import { useSigintGroupCatalog } from '../../hooks/use-sigint-group-catalog';
import { uniquePointEtalonsForMapSearch } from '../rer-duty-neo/utils';
import { getAnalysisSidebarTabs, type AnalysisCenterTab, type AnalysisSidebarTab } from './types';
import { fetchAnalysisCallsignFrequencyMatches } from '../../services/api/analysis';
import { toErrorMessage } from './use-analysis-data.shared';
import { mergeMessageWindow } from '../shared/message-feed/windowing';
import {
  buildGroupFilterItems,
  groupFilterScope,
  type GroupScope,
} from '../shared/group-navigation';
import {
  persistAnalysisScopeFilters,
  readAnalysisScopeFilters,
} from './analysis-scope-filter-state';

function groupScopesEqual(left: GroupScope, right: GroupScope): boolean {
  return (
    left.kind === right.kind &&
    (left.kind !== 'group' || (right.kind === 'group' && left.masterKey === right.masterKey))
  );
}

function initState(
  parsedQueryState: AnalysisQueryState,
  now: Date,
  radioFeaturesAllowed: boolean,
): AnalysisQueryState {
  return createInitialQueryState(parsedQueryState, now, radioFeaturesAllowed);
}

function resolveRoleDefaultFromDate({
  currentUserLoaded,
  initialFromDateTimeStr,
  initialParsedFromDateTimeStr,
  now,
  queryState,
  radioFeaturesAllowed,
}: {
  currentUserLoaded: boolean;
  initialFromDateTimeStr: string;
  initialParsedFromDateTimeStr: string;
  now: Date;
  queryState: AnalysisQueryState;
  radioFeaturesAllowed: boolean;
}): AnalysisQueryState {
  if (
    !currentUserLoaded ||
    initialParsedFromDateTimeStr !== '' ||
    queryState.fromDateTimeStr !== initialFromDateTimeStr
  ) {
    return queryState;
  }
  const roleDefault = createResetQueryState(now, radioFeaturesAllowed);
  return roleDefault.fromDateTimeStr === queryState.fromDateTimeStr
    ? queryState
    : { ...queryState, fromDateTimeStr: roleDefault.fromDateTimeStr };
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

function boundFocusedInboxWindow(inboxWindow: InboxWindowRsp): InboxWindowRsp {
  const inboxItems = inboxWindow.inbox.inboxItems;
  if (inboxItems.length <= ANALYSIS_MESSAGE_WINDOW_LIMIT) return inboxWindow;
  const bounded = mergeMessageWindow([], inboxItems, 'below', {
    limit: ANALYSIS_MESSAGE_WINDOW_LIMIT,
    getId: ([id]) => id,
  });
  return {
    ...inboxWindow,
    inbox: { ...inboxWindow.inbox, inboxItems: bounded.items },
    hasMoreBefore: inboxWindow.hasMoreBefore || bounded.removedItems.length > 0,
  };
}

type DeviceAccess =
  { status: 'loading' } | { status: 'allowed' } | { status: 'denied' } | { status: 'error' };

type RerReportFilterAccess =
  { status: 'loading' } | { status: 'allowed' } | { status: 'denied' } | { status: 'error' };

export function useRerAnalysisNeoPage(
  authUserName: string | null,
  authUserRoles: readonly string[] = [],
): AnalysisPageViewModel {
  const [threadMessageId, setThreadMessageId] = useState(readThreadMessageId);
  const exitThread = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete(THREAD_MESSAGE_PARAM);
    window.history.replaceState({}, '', `${url.pathname}?${url.searchParams}`);
    setThreadMessageId(null);
  }, []);
  const theme = useTheme();
  const isMobileLayout = useMediaQuery(theme.breakpoints.down('sm'));
  const initialRadioFeaturesAllowed = canUseRadioFeatures(authUserRoles);
  const [initialPanelQueryState] = useState(parseAnalysisPanelQueryStateFromWindow);
  const [initialNow] = useState(() => new Date());
  const [initialParsedQueryState] = useState(parseQueryStateFromWindow);
  const [initialGroupScope] = useState(readAnalysisGroupScopeFromUrl);
  const [initialHasQueryState] = useState(hasQueryStateInWindow);
  const [initialQueryState] = useState<AnalysisQueryState>(() => {
    const state = initState(initialParsedQueryState, initialNow, initialRadioFeaturesAllowed);
    const storedFilters =
      initialHasQueryState || threadMessageId != null
        ? null
        : readAnalysisScopeFilters({ kind: 'all' });
    return normalizeQueryState({
      ...state,
      ...storedFilters,
      ...(initialGroupScope.kind === 'group'
        ? { groupsSelected: [initialGroupScope.masterKey] }
        : {}),
    });
  });
  const [queryState, setQueryState] = useState<AnalysisQueryState>(initialQueryState);
  const groupScope = useMemo(
    () => groupFilterScope(queryState.groupsSelected),
    [queryState.groupsSelected],
  );
  const groupCatalog = useSigintGroupCatalog();
  const groupScopeTransitionRequestedRef = useRef(false);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [currentUserStatus, setCurrentUserStatus] = useState<'loading' | 'success' | 'error'>(
    'loading',
  );
  const [systemSettingsStatus, setSystemSettingsStatus] = useState<'loading' | 'success' | 'error'>(
    'loading',
  );
  const [unitsExactMatchOnlyDefault, setUnitsExactMatchOnlyDefault] = useState<boolean | null>(
    null,
  );
  const [supportNonRerInterceptions, setSupportNonRerInterceptions] = useState(false);
  const [rerReportEnabled, setRerReportEnabled] = useState(false);
  const [devicesSectionEnabled, setDevicesSectionEnabled] = useState(false);
  const [audioTranscriptionEnabled, setAudioTranscriptionEnabled] = useState(false);
  const [showPelengDistanceToBattleline, setShowPelengDistanceToBattleline] = useState(false);
  const [analysisAorFilterEnabled, setAnalysisAorFilterEnabled] = useState(true);
  const [hideBotTags, setHideBotTags] = useState(false);
  const [hideNetworks, setHideNetworks] = useState(false);
  const [lastResetState, setLastResetState] = useState<AnalysisQueryState>(() =>
    hasMeaningfulUiFiltersBeyondDateRange(initialQueryState)
      ? createResetQueryState(initialNow, initialRadioFeaturesAllowed)
      : initialQueryState,
  );
  const [selectedCenterTab, setCenterTabState] = useState<AnalysisCenterTab>('messages');
  const [error, setError] = useState<string | null>(null);
  const [directMessageError, setDirectMessageError] = useState<string | null>(null);
  const [leftPanelOpenOverride, setLeftPanelOpen] = useState(
    () => initialPanelQueryState.leftPanelOpen,
  );
  const leftPanelStateReady = leftPanelOpenOverride != null || systemSettingsStatus === 'success';
  const leftPanelOpen =
    leftPanelOpenOverride ?? (systemSettingsStatus === 'success' && hideNetworks);
  const [newestFirst, setNewestFirst] = useState(parseNewestFirstFromWindow);
  const [initialMessagesPageIndex] = useState(parseMessagesPageIndexFromWindow);
  const initialMessagesPageRestoredRef = useRef(initialMessagesPageIndex === 0);
  const [messagePageNavigationTarget, setMessagePageNavigationTarget] = useState<number | null>(
    null,
  );
  const [messageViewportPreservationKey, setMessageViewportPreservationKey] = useState(0);
  const [messageEdgeLoadRetryKey, setMessageEdgeLoadRetryKey] = useState(0);
  const [messageViewportPreserving, setMessageViewportPreserving] = useState(false);
  const [showMessagesLoading, setShowMessagesLoading] = useState(true);
  const messageViewportPreservationRequestRef = useRef(0);
  const messageViewportCaptureRef = useRef<(() => void) | null>(null);
  const setMessageViewportCapture = useCallback((capture: (() => void) | null) => {
    messageViewportCaptureRef.current = capture;
  }, []);
  const preserveMessageViewportForRealtime = useCallback(() => {
    messageViewportCaptureRef.current?.();
    setMessageViewportPreservationKey((current) => current + 1);
  }, []);
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
  const [selectedSidebarTab, setRightSidebarTab] = useState<AnalysisSidebarTab | null>(() =>
    initialPanelQueryState.rightPanelOpen ? 'callsigns' : null,
  );
  const replyNavigationRef = useRef(false);
  const [replyNavigationVersion, setReplyNavigationVersion] = useState(0);
  const [loadedReplyTarget, setLoadedReplyTarget] = useState<{ messageId: number } | null>(null);
  const [targetMessageUid, setTargetMessageUid] = useState(() =>
    threadMessageId == null ? parseMessageUidFromWindow() : null,
  );
  const [targetMessageQueryState, setTargetMessageQueryState] = useState(initialQueryState);
  const [highlightTargetMessage, setHighlightTargetMessage] = useState(true);
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
  const targetMessageControllerRef = useRef<MessageNavigationController | null>(null);
  const pendingLinkedMessageLandingRef = useRef<{
    messageId: number;
    resolve: (landed: boolean) => void;
  } | null>(null);
  const targetMessageIdRef = useRef<number | null>(null);
  const targetMessageContextSawReloadRef = useRef(false);
  const dataMessagesRef = useRef<Array<[number, InboxMessage]> | null>(null);
  const targetMessageContextPreviousMessagesRef = useRef<Array<[number, InboxMessage]> | null>(
    null,
  );
  const [centerTabPending, startCenterTabTransition] = useTransition();
  const setPageError = useCallback((message: string) => setError(message || null), []);
  const dutySettings = useDutySettings();
  const deviceAccess: DeviceAccess =
    currentUserStatus === 'error' || systemSettingsStatus === 'error'
      ? { status: 'error' }
      : currentUserStatus === 'loading' || systemSettingsStatus === 'loading'
        ? { status: 'loading' }
        : canUseMessageDevices(currentUser?.roles, devicesSectionEnabled)
          ? { status: 'allowed' }
          : { status: 'denied' };
  const canUseDevices = deviceAccess.status === 'allowed';
  const rerReportFilterAccess: RerReportFilterAccess =
    currentUserStatus === 'error' || systemSettingsStatus === 'error'
      ? { status: 'error' }
      : currentUserStatus === 'loading' || systemSettingsStatus === 'loading'
        ? { status: 'loading' }
        : rerReportEnabled && currentUser?.rerReportEligible === true
          ? { status: 'allowed' }
          : { status: 'denied' };
  const rerReportFilterEnabled = rerReportFilterAccess.status === 'allowed';
  const rerReportFilterAccessPending =
    rerReportFilterAccess.status === 'loading' || rerReportFilterAccess.status === 'error';
  const radioFeaturesAllowed = canUseRadioFeatures(currentUser?.roles ?? authUserRoles);
  const directQueryBoundaryRef = useRef({
    fromDateTimeStr: initialQueryState.fromDateTimeStr,
    toDateTimeStr: initialQueryState.toDateTimeStr,
    search: initialQueryState.search,
    searchMode: initialQueryState.searchMode,
  });
  const queryStateWithResolvedRoleDate = useMemo(
    () =>
      resolveRoleDefaultFromDate({
        currentUserLoaded: currentUserStatus === 'success',
        initialFromDateTimeStr: initialQueryState.fromDateTimeStr,
        initialParsedFromDateTimeStr: initialParsedQueryState.fromDateTimeStr,
        now: initialNow,
        queryState,
        radioFeaturesAllowed,
      }),
    [
      currentUserStatus,
      initialNow,
      initialParsedQueryState.fromDateTimeStr,
      initialQueryState.fromDateTimeStr,
      queryState,
      radioFeaturesAllowed,
    ],
  );
  useEffect(() => {
    if (queryStateWithResolvedRoleDate !== queryState) {
      directQueryBoundaryRef.current = {
        fromDateTimeStr: queryStateWithResolvedRoleDate.fromDateTimeStr,
        toDateTimeStr: queryStateWithResolvedRoleDate.toDateTimeStr,
        search: queryStateWithResolvedRoleDate.search,
        searchMode: queryStateWithResolvedRoleDate.searchMode,
      };
      setQueryState(queryStateWithResolvedRoleDate);
    }
  }, [queryState, queryStateWithResolvedRoleDate]);
  const centerTab =
    threadMessageId != null || (!radioFeaturesAllowed && selectedCenterTab === 'summary')
      ? 'messages'
      : selectedCenterTab;
  const rightSidebarTab =
    !radioFeaturesAllowed && selectedSidebarTab === 'frequencies'
      ? 'callsigns'
      : selectedSidebarTab;
  const effectiveQueryState = useMemo(
    () =>
      effectiveRadioQuery(
        {
          ...queryStateWithResolvedRoleDate,
          deviceNamesSelected:
            deviceAccess.status === 'denied'
              ? []
              : queryStateWithResolvedRoleDate.deviceNamesSelected,
          onlyWithNetwork:
            rerReportFilterAccess.status === 'denied'
              ? false
              : queryStateWithResolvedRoleDate.onlyWithNetwork,
          networksSelected: hideNetworks ? [] : queryStateWithResolvedRoleDate.networksSelected,
          withoutNetwork: hideNetworks ? false : queryStateWithResolvedRoleDate.withoutNetwork,
        },
        radioFeaturesAllowed,
      ),
    [
      deviceAccess.status,
      queryStateWithResolvedRoleDate,
      radioFeaturesAllowed,
      rerReportFilterAccess.status,
      hideNetworks,
    ],
  );
  const scopedEffectiveQueryState = useMemo(
    () =>
      groupScope.kind === 'group'
        ? { ...effectiveQueryState, groupsSelected: [groupScope.masterKey] }
        : effectiveQueryState,
    [effectiveQueryState, groupScope],
  );
  useEffect(() => {
    if (dutySettings.loadInProgress) return;
    setQueryState((current) =>
      current.messageTimeBasis === dutySettings.messageSortBy
        ? current
        : { ...current, messageTimeBasis: dutySettings.messageSortBy },
    );
  }, [dutySettings.loadInProgress, dutySettings.messageSortBy]);
  const linkedMessageQueryState = replyNavigationVersion > 0 ? queryState : targetMessageQueryState;
  const directMessageWindowQueryState = useMemo(
    () =>
      effectiveRadioQuery(
        {
          ...linkedMessageQueryState,
          deviceNamesSelected:
            deviceAccess.status === 'denied' ? [] : linkedMessageQueryState.deviceNamesSelected,
          onlyWithNetwork:
            rerReportFilterAccess.status === 'denied'
              ? false
              : linkedMessageQueryState.onlyWithNetwork,
          groupsSelected:
            groupScope.kind === 'group' ? [groupScope.masterKey] : queryState.groupsSelected,
          freqsSelected: queryState.freqsSelected,
          networksSelected: hideNetworks ? [] : queryState.networksSelected,
          withoutNetwork: hideNetworks ? false : queryState.withoutNetwork,
          messageTimeBasis: dutySettings.messageSortBy,
        },
        radioFeaturesAllowed,
      ),
    [
      linkedMessageQueryState,
      radioFeaturesAllowed,
      deviceAccess.status,
      rerReportFilterAccess.status,
      hideNetworks,
      queryState.freqsSelected,
      queryState.groupsSelected,
      queryState.networksSelected,
      queryState.withoutNetwork,
      dutySettings.messageSortBy,
      groupScope,
    ],
  );

  const directMessageDefaultsPending =
    currentUserStatus === 'loading' ||
    (rerReportFilterAccessPending && targetMessageQueryState.onlyWithNetwork) ||
    queryStateWithResolvedRoleDate !== queryState ||
    queryState.messageTimeBasis !== dutySettings.messageSortBy;

  useEffect(() => {
    if (
      !targetMessageUid ||
      !targetMessageContextActive ||
      directMessageDefaultsPending ||
      dutySettings.loadInProgress ||
      deviceAccess.status === 'loading' ||
      (deviceAccess.status === 'error' &&
        directMessageWindowQueryState.deviceNamesSelected.length > 0)
    ) {
      return;
    }
    const isContextRefresh = targetMessageLoadedRef.current;
    if (isContextRefresh) {
      setLoadedReplyTarget(null);
      targetMessageContextSawReloadRef.current = false;
      targetMessageContextPreviousMessagesRef.current = dataMessagesRef.current;
      setTargetMessageContextLoading(true);
      setTargetMessageContextResponsePending(true);
    } else {
      setTargetMessageLoading(true);
    }
    const requestQueryState = {
      ...directMessageWindowQueryState,
      ...directQueryBoundaryRef.current,
    };
    const publishPeriod = (period: AnalysisQueryState) => {
      directQueryBoundaryRef.current = {
        fromDateTimeStr: period.fromDateTimeStr,
        toDateTimeStr: period.toDateTimeStr,
        search: period.search,
        searchMode: queryStateWithResolvedRoleDate.searchMode,
      };
      setQueryState((current) => ({
        ...current,
        fromDateTimeStr: period.fromDateTimeStr,
        toDateTimeStr: period.toDateTimeStr,
      }));
      pushQueryStateToUrl(period, newestFirst, {
        leftPanelOpen: leftPanelStateReady ? leftPanelOpen : null,
        rightPanelOpen,
      });
    };
    let periodAdjusted = false;
    const restorePeriod = () => {
      if (periodAdjusted) publishPeriod(requestQueryState);
    };
    const navigation = createMessageNavigationController<{
      targetMessageId: number;
      window: InboxWindowRsp;
    }>(
      () => ({
        materialize: async (context, signal) => {
          const next = replyNavigationRef.current
            ? requestQueryState
            : adjustQueryDateRangeForDirectMessage(requestQueryState, context.message![1]);
          periodAdjusted = next !== requestQueryState;
          if (periodAdjusted) publishPeriod(next);
          try {
            const window = await fetchInboxWindow(
              { messageRef: targetMessageUid, inboxReq: buildInboxReq(next, [], true) },
              { signal },
            );
            if (signal.aborted) return null;
            if (
              window == null ||
              !window.inbox.inboxItems.some(([messageId]) => messageId === window.targetMessageId)
            ) {
              restorePeriod();
              return null;
            }
            setDirectMessageError(null);
            targetMessageLoadedRef.current = true;
            targetMessageIdRef.current = window.targetMessageId;
            setTargetMessageWindow(boundFocusedInboxWindow(window));
            setTargetMessageContextResponsePending(false);
            return { targetMessageId: window.targetMessageId, window };
          } catch (error) {
            if (!signal.aborted) restorePeriod();
            throw error;
          } finally {
            if (!signal.aborted) setTargetMessageLoading(false);
          }
        },
        land: ({ targetMessageId }, signal) =>
          new Promise<boolean>((resolve) => {
            if (signal.aborted) {
              resolve(false);
              return;
            }
            const onAbort = () => {
              if (pendingLinkedMessageLandingRef.current?.messageId === targetMessageId) {
                pendingLinkedMessageLandingRef.current = null;
              }
              resolve(false);
            };
            signal.addEventListener('abort', onAbort, { once: true });
            pendingLinkedMessageLandingRef.current = {
              messageId: targetMessageId,
              resolve: (landed) => {
                signal.removeEventListener('abort', onAbort);
                pendingLinkedMessageLandingRef.current = null;
                resolve(landed);
              },
            };
          }),
        invalidateNavigation: () => {
          pendingLinkedMessageLandingRef.current?.resolve(false);
          pendingLinkedMessageLandingRef.current = null;
        },
      }),
      (outcome) => {
        if (outcome.status === 'unavailable' || outcome.status === 'landing-error') {
          restorePeriod();
          if (isContextRefresh) {
            setTargetMessageWindow(null);
            setTargetMessageFocusActive(false);
            removeMessageUidFromWindowUrl();
          }
          setTargetMessageContextActive(false);
        } else if (outcome.status === 'load-error' && !isContextRefresh) {
          setTargetMessageContextActive(false);
        }
        if (outcome.status !== 'focused') {
          targetMessageContextSawReloadRef.current = false;
          if (!isContextRefresh || outcome.status === 'load-error') {
            setTargetMessageContextLoading(false);
          }
          setTargetMessageContextResponsePending(false);
        }
        setTargetMessageLoading(false);
        if (!isContextRefresh || outcome.status === 'load-error') {
          setDirectMessageError(
            replyNavigationRef.current && outcome.status === 'landing-error'
              ? 'Повідомлення поза поточними фільтрами. Змініть фільтри, щоб побачити його.'
              : messageNavigationErrorText(outcome),
          );
        }
      },
    );
    targetMessageControllerRef.current = navigation;
    void navigation.navigate(targetMessageUid);
    return () => {
      navigation.cancel();
      if (targetMessageControllerRef.current === navigation)
        targetMessageControllerRef.current = null;
    };
  }, [
    directMessageDefaultsPending,
    directMessageWindowQueryState,
    deviceAccess.status,
    dutySettings.loadInProgress,
    targetMessageContextActive,
    targetMessageUid,
    replyNavigationVersion,
  ]);

  const navigateReply = useCallback<ReplyNavigation>(
    (message) => {
      const reference = new URL(message.href, window.location.origin).searchParams.get('m');
      if (!reference) return;
      targetMessageControllerRef.current?.cancel();
      if (dataMessagesRef.current?.some(([id]) => id === message.id)) {
        setDirectMessageError(null);
        setTargetMessageFocusActive(false);
        setTargetMessageLoading(false);
        setTargetMessageContextLoading(false);
        setTargetMessageContextResponsePending(false);
        setLoadedReplyTarget({ messageId: message.id });
        setCenterTabState('messages');
        return;
      }
      if (threadMessageId != null) {
        setDirectMessageError(
          'Повідомлення поза поточними фільтрами. Змініть фільтри, щоб побачити його.',
        );
        return;
      }
      setLoadedReplyTarget(null);
      replyNavigationRef.current = true;
      targetMessageLoadedRef.current = false;
      setDirectMessageError(null);
      setTargetMessageQueryState(queryState);
      setTargetMessageUid(reference);
      setTargetMessageFocusActive(true);
      setHighlightTargetMessage(true);
      setTargetMessageContextActive(true);
      setTargetMessageContextResponsePending(true);
      setTargetMessageLoading(true);
      setReplyNavigationVersion((version) => version + 1);
      setCenterTabState('messages');
    },
    [queryState, threadMessageId],
  );

  const clearTargetMessageFocus = useCallback(() => {
    targetMessageControllerRef.current?.cancel();
    setTargetMessageFocusActive(false);
    removeMessageUidFromWindowUrl();
  }, []);

  const clearTargetMessageContext = useCallback(() => {
    targetMessageControllerRef.current?.cancel();
    setLoadedReplyTarget(null);
    setTargetMessageContextActive(false);
    setTargetMessageLoading(false);
    setTargetMessageContextLoading(false);
    setTargetMessageContextResponsePending(false);
    clearTargetMessageFocus();
  }, [clearTargetMessageFocus]);

  useEffect(() => {
    if (threadMessageId != null) return;
    persistAnalysisScopeFilters({ kind: 'all' }, queryState);
  }, [queryState, threadMessageId]);

  useEffect(() => {
    const onPopState = () => {
      setThreadMessageId(readThreadMessageId());
      replyNavigationRef.current = false;
      clearTargetMessageContext();
      setTargetMessageUid(null);
      const nextGroupScope = readAnalysisGroupScopeFromUrl();
      if (!groupScopesEqual(groupScope, nextGroupScope)) {
        groupScopeTransitionRequestedRef.current = true;
      }
      const historyState = initState(parseQueryStateFromWindow(), new Date(), radioFeaturesAllowed);
      setQueryState((current) =>
        normalizeQueryState({
          ...historyState,
          messageTimeBasis: current.messageTimeBasis,
          radioFeaturesAllowed: current.radioFeaturesAllowed,
          groupsSelected:
            nextGroupScope.kind === 'group'
              ? [nextGroupScope.masterKey]
              : historyState.groupsSelected,
        }),
      );
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [clearTargetMessageContext, groupScope, queryState, radioFeaturesAllowed]);

  const onLinkedMessageMounted = useCallback((messageId: number) => {
    if (pendingLinkedMessageLandingRef.current?.messageId === messageId) {
      pendingLinkedMessageLandingRef.current.resolve(true);
    }
  }, []);

  useEffect(() => {
    const nextBoundary = {
      fromDateTimeStr: queryStateWithResolvedRoleDate.fromDateTimeStr,
      toDateTimeStr: queryStateWithResolvedRoleDate.toDateTimeStr,
      search: queryStateWithResolvedRoleDate.search,
      searchMode: queryStateWithResolvedRoleDate.searchMode,
    };
    const previousBoundary = directQueryBoundaryRef.current;
    directQueryBoundaryRef.current = nextBoundary;
    if (!targetMessageContextActive) return;
    if (
      previousBoundary.fromDateTimeStr === nextBoundary.fromDateTimeStr &&
      previousBoundary.toDateTimeStr === nextBoundary.toDateTimeStr &&
      previousBoundary.search === nextBoundary.search &&
      previousBoundary.searchMode === nextBoundary.searchMode
    ) {
      return;
    }
    clearTargetMessageContext();
  }, [
    clearTargetMessageContext,
    queryStateWithResolvedRoleDate.fromDateTimeStr,
    queryStateWithResolvedRoleDate.search,
    queryStateWithResolvedRoleDate.searchMode,
    queryStateWithResolvedRoleDate.toDateTimeStr,
    targetMessageContextActive,
  ]);

  const handleUnauthorized = useCallback((errorValue: unknown) => {
    return false;
  }, []);

  const data = useAnalysisData({
    threadMessageId,
    canUseDevices,
    authUserName,
    currentUser,
    deferInitialLoad:
      systemSettingsStatus === 'loading' ||
      deviceAccess.status === 'loading' ||
      (rerReportFilterAccessPending && queryState.onlyWithNetwork) ||
      (deviceAccess.status === 'error' && queryState.deviceNamesSelected.length > 0) ||
      targetMessageContextResponsePending,
    focusedWindow: targetMessageWindow,
    focusedMessageActive: targetMessageContextActive,
    centerTab,
    newestFirst,
    onBeforeRealtimeMessageListChange: preserveMessageViewportForRealtime,
    onError: setPageError,
    onUnauthorized: handleUnauthorized,
    rightPanelOpen,
    rightSidebarVisible: threadMessageId == null && rightPanelOpen,
    rightSidebarTab,
    shouldLoadNewCallsigns:
      threadMessageId == null && rightPanelOpen && rightSidebarTab === 'newCallsigns',
    queryState: scopedEffectiveQueryState,
    hideNetworks,
  });
  const previousMessageGroupInfosRef = useRef<typeof data.groupInfos>({});
  useEffect(() => {
    if (
      threadMessageId == null ||
      data.threadAnchorId == null ||
      data.threadAnchorId === threadMessageId
    )
      return;
    const url = new URL(window.location.href);
    url.searchParams.set(THREAD_MESSAGE_PARAM, String(data.threadAnchorId));
    window.history.replaceState({}, '', `${url.pathname}?${url.searchParams}`);
  }, [threadMessageId, data.threadAnchorId]);
  useEffect(() => {
    const previous = previousMessageGroupInfosRef.current;
    previousMessageGroupInfosRef.current = data.groupInfos;
    const changed = Object.entries(data.groupInfos).filter(([key, info]) => previous[key] !== info);
    if (changed.length === 0) return;
    groupCatalog.setGroupInfos((current) => ({ ...current, ...Object.fromEntries(changed) }));
  }, [data.groupInfos, groupCatalog.setGroupInfos]);
  const groupInfos = groupCatalog.groupInfos;
  const selectGroupScope = useCallback(
    (scope: GroupScope) => {
      clearTargetMessageContext();
      setTargetMessageUid(null);
      groupScopeTransitionRequestedRef.current = true;
      data.invalidateFilterSectionLoadsForPatch({ groupsSelected: [] });
      setQueryState((current) =>
        normalizeQueryState({
          ...current,
          groupsSelected: scope.kind === 'group' ? [scope.masterKey] : [],
        }),
      );
      writeAnalysisGroupScopeToUrl({ kind: 'all' });
    },
    [clearTargetMessageContext, data.invalidateFilterSectionLoadsForPatch],
  );
  const catalogGroups = useMemo(
    () =>
      buildGroupFilterItems(
        [
          ...groupCatalog.groupsList,
          ...Object.keys(groupInfos),
          ...queryState.groupsSelected,
          ...data.messages.flatMap(
            ([, message]) =>
              message.groupMasterKeys ?? (message.groupMasterKey ? [message.groupMasterKey] : []),
          ),
        ],
        groupInfos,
      ),
    [groupCatalog.groupsList, queryState.groupsSelected, groupInfos, data.messages],
  );
  useEffect(() => {
    groupCatalog.setRequiredGroupKeys(
      catalogGroups.flatMap((group) => (group.kind === 'group' ? [group.masterKey] : [])),
    );
  }, [catalogGroups, groupCatalog.setRequiredGroupKeys]);
  const groupNavigation = {
    scope: groupScope,
    loading: groupCatalog.groupCatalogLoading,
    error: groupCatalog.groupCatalogError?.message ?? null,
    retry: groupCatalog.reloadGroupCatalog,
    groups: catalogGroups,
    select: selectGroupScope,
  };
  const groupScopeTransitionPending =
    groupScopeTransitionRequestedRef.current && !data.messagesLoadedForCurrentQuery;
  useEffect(() => {
    if (data.messagesLoadedForCurrentQuery) {
      groupScopeTransitionRequestedRef.current = false;
    }
  }, [data.messagesLoadedForCurrentQuery, groupScope]);
  dataMessagesRef.current = data.messages;
  const reload = useCallback(
    (options: Parameters<typeof data.reload>[0] = {}) => {
      const requestId = messageViewportPreservationRequestRef.current + 1;
      messageViewportPreservationRequestRef.current = requestId;
      setShowMessagesLoading(options.showMessagesLoading !== false);
      const preserveMessagePage = options.preserveMessagePage === true;
      if (!preserveMessagePage) {
        setMessageViewportPreserving(false);
      } else {
        messageViewportCaptureRef.current?.();
        setMessageViewportPreserving(true);
        setMessageViewportPreservationKey((current) => current + 1);
      }
      const reloadOptions = preserveMessagePage
        ? { ...options, messagePageIndex: visibleMessagesPageIndex }
        : options;
      void Promise.resolve(data.reload(reloadOptions)).finally(() => {
        if (messageViewportPreservationRequestRef.current === requestId) {
          setShowMessagesLoading(true);
          if (preserveMessagePage) setMessageViewportPreserving(false);
          setMessageEdgeLoadRetryKey((current) => current + 1);
        }
      });
    },
    [data.reload, visibleMessagesPageIndex],
  );
  const isPageStartLoaded = useCallback(
    (targetPageIndex: number) => {
      const targetMessageIndex = targetPageIndex * ANALYSIS_MESSAGES_PAGE_SIZE;
      return (
        targetMessageIndex >= data.firstLoadedMessageIndex &&
        targetMessageIndex < data.firstLoadedMessageIndex + data.messages.length
      );
    },
    [data.firstLoadedMessageIndex, data.messages.length],
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
      clearTargetMessageFocus();
      const firstLoadedMessageIndex = data.firstLoadedMessageIndex;
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
      data.firstLoadedMessageIndex,
      data.messages.length,
      clearTargetMessageFocus,
      directTargetMessageIndex,
      newestFirst,
      requestLoadedMessagesPage,
      targetMessageContextActive,
    ],
  );
  const loadFirstPage = useCallback(async () => {
    if (visibleMessagesPageIndex === 0) return;
    if (isPageStartLoaded(0)) {
      requestLoadedMessagesPage(0);
      return;
    }
    if (await data.loadFirstPage()) requestLoadedMessagesPage(0);
  }, [data.loadFirstPage, isPageStartLoaded, requestLoadedMessagesPage, visibleMessagesPageIndex]);
  const loadLastPage = useCallback(async () => {
    if (data.messagesTotalCount == null || data.messagesTotalCount === 0) return;
    const lastPageIndex = Math.max(
      0,
      Math.ceil(data.messagesTotalCount / ANALYSIS_MESSAGES_PAGE_SIZE) - 1,
    );
    if (visibleMessagesPageIndex === lastPageIndex) return;
    if (isPageStartLoaded(lastPageIndex)) {
      requestLoadedMessagesPage(lastPageIndex);
      return;
    }
    if (await data.loadLastPage()) requestLoadedMessagesPage(lastPageIndex);
  }, [
    data.loadLastPage,
    data.messagesTotalCount,
    isPageStartLoaded,
    requestLoadedMessagesPage,
    visibleMessagesPageIndex,
  ]);
  const loadNextPage = useCallback(async () => {
    const targetPageIndex = visibleMessagesPageIndex + 1;
    if (targetMessageContextActive) {
      await loadDirectAdjacentPage(targetPageIndex);
      return;
    }
    if (isPageStartLoaded(targetPageIndex)) {
      requestLoadedMessagesPage(targetPageIndex);
      return;
    }
    if (await data.loadNextPage()) requestLoadedMessagesPage(targetPageIndex);
  }, [
    data.loadNextPage,
    isPageStartLoaded,
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
    if (isPageStartLoaded(targetPageIndex)) {
      requestLoadedMessagesPage(targetPageIndex);
      return;
    }
    if (await data.loadPrevPage(targetPageIndex)) requestLoadedMessagesPage(targetPageIndex);
  }, [
    data.loadPrevPage,
    isPageStartLoaded,
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
    () => buildAnalysisReq(effectiveQueryState, dataFreqValues),
    [dataFreqValues, effectiveQueryState],
  );

  const savedFilters = useAnalysisSavedFilters({
    allFrequencies: dataFreqValues,
    onError: setPageError,
    onUnauthorized: handleUnauthorized,
    queryState:
      deviceAccess.status === 'denied'
        ? { ...queryStateWithResolvedRoleDate, deviceNamesSelected: [] }
        : queryStateWithResolvedRoleDate,
    setQueryState,
  });

  const report = useAnalysisReport({
    radioFeaturesAllowed,
    analysisReq,
    fromDateTimeStr: queryState.fromDateTimeStr,
    inboxReq: data.inboxReq,
    onError: setPageError,
    onUnauthorized: handleUnauthorized,
    toDateTimeStr: queryState.toDateTimeStr,
  });

  const editor = useAnalysisMessageEditor({
    canWrite: canWriteMessages(currentUser?.roles),
    messages: data.messages,
    profiles: data.profiles,
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
      signal?: AbortSignal,
    ): Promise<AnalysisCallsignFrequencyMatchesRsp | null> => {
      if (isNullOrUndefined(analysisReq)) {
        setPageError('Перевірте дату та час перед пошуком частот.');
        return null;
      }

      try {
        return await fetchAnalysisCallsignFrequencyMatches(
          {
            req: analysisReq,
            callsigns,
            minMatches,
          },
          { signal },
        );
      } catch (loadError) {
        if (signal?.aborted) return null;
        if (!handleUnauthorized(loadError)) setPageError(toErrorMessage(loadError));
        return null;
      }
    },
    [analysisReq, handleUnauthorized, setPageError],
  );

  const setCenterTab = useCallback(
    (tab: AnalysisCenterTab) => {
      if (threadMessageId != null && tab !== 'messages') return;
      startCenterTabTransition(() => {
        setCenterTabState(tab);
      });
    },
    [threadMessageId],
  );

  useEffect(() => {
    if (systemSettingsStatus !== 'success') return;
    setLeftPanelOpen((current) => current ?? hideNetworks);
  }, [hideNetworks, systemSettingsStatus]);

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
        setRerReportEnabled(settings.rerReportEnabled);
        setDevicesSectionEnabled(settings.devicesSectionEnabled);
        setAudioTranscriptionEnabled(settings.enableAudioTranscription ?? false);
        setShowPelengDistanceToBattleline(settings.showPelengDistanceToBattleline);
        setHideBotTags(settings.disableBotTags ?? false);
        setHideNetworks(settings.hideNetworks ?? false);
        setAnalysisAorFilterEnabled(settings.analysisAorFilterEnabled ?? true);
        setSystemSettingsStatus('success');
      })
      .catch(() => {
        if (abortController.signal.aborted) return;
        setSystemSettingsStatus('error');
        setPageError('Не вдалося завантажити системні налаштування.');
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
        setCurrentUserStatus('success');
      })
      .catch((error) => {
        if (abortController.signal.aborted) return;
        setCurrentUser(null);
        setCurrentUserStatus('error');
        setPageError(`Не вдалося завантажити поточного користувача: ${toErrorMessage(error)}`);
      });

    return () => {
      abortController.abort();
    };
  }, []);

  useEffect(() => {
    if (deviceAccess.status !== 'denied') return;
    setQueryState((current) =>
      current.deviceNamesSelected.length === 0 ? current : { ...current, deviceNamesSelected: [] },
    );
  }, [deviceAccess.status, queryState.deviceNamesSelected]);

  useEffect(() => {
    if (rerReportFilterAccess.status !== 'denied') return;
    setQueryState((current) =>
      current.onlyWithNetwork ? { ...current, onlyWithNetwork: false } : current,
    );
  }, [rerReportFilterAccess.status, queryState.onlyWithNetwork]);

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
      setRightSidebarTab('callsigns');
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
      const boundary = directQueryBoundaryRef.current;
      if (
        targetMessageContextActive &&
        ((patch.fromDateTimeStr != null && patch.fromDateTimeStr !== boundary.fromDateTimeStr) ||
          (patch.toDateTimeStr != null && patch.toDateTimeStr !== boundary.toDateTimeStr) ||
          (patch.search != null && patch.search !== boundary.search) ||
          (patch.searchMode != null && patch.searchMode !== boundary.searchMode))
      ) {
        clearTargetMessageContext();
      }
      data.invalidateFilterSectionLoadsForPatch(normalizedPatch);
      setQueryState((current) => normalizeQueryState({ ...current, ...normalizedPatch }));
    },
    [
      clearTargetMessageContext,
      data.invalidateFilterSectionLoadsForPatch,
      targetMessageContextActive,
    ],
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
    if (deviceAccess.status === 'loading' || deviceAccess.status === 'error') return;
    pushQueryStateToUrl(effectiveQueryState, newestFirst, {
      leftPanelOpen: leftPanelStateReady ? leftPanelOpen : null,
      rightPanelOpen,
    });
  }, [
    deviceAccess.status,
    effectiveQueryState,
    leftPanelOpen,
    leftPanelStateReady,
    newestFirst,
    rightPanelOpen,
  ]);

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
    const nextState = {
      ...createResetQueryState(new Date(), radioFeaturesAllowed),
      messageTimeBasis: dutySettings.messageSortBy,
    };
    savedFilters.applySavedFilter(null);
    data.invalidateFilterSectionLoads();
    setQueryState(nextState);
    setLastResetState(nextState);
    setError(null);
    pushQueryStateToUrl(nextState, newestFirst);
  }, [data, dutySettings.messageSortBy, newestFirst, radioFeaturesAllowed, savedFilters]);

  const setIncludeOnlyNewFreqs = useCallback(
    (value: boolean) => {
      if (threadMessageId != null) return;
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
    [data.invalidateFilterSectionLoadsForPatch, dataNewFreqValues, threadMessageId],
  );

  useEffect(() => {
    if (threadMessageId != null) {
      if (queryState.includeOnlyNewFreqs)
        setQueryState((current) => ({ ...current, includeOnlyNewFreqs: false }));
      return;
    }
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
    threadMessageId,
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
      if (threadMessageId != null) {
        setPageError('Мапа недоступна під час перегляду ланцюжка.');
        return;
      }
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
    [
      data.invalidateFilterSectionLoadsForPatch,
      dutySettings.analysisMapInSidebar,
      threadMessageId,
      setPageError,
    ],
  );

  const openPointsOnMap = useCallback(
    (etalons: string[], _message: InboxMessage) => {
      if (threadMessageId != null) {
        setPageError('Мапа недоступна під час перегляду ланцюжка.');
        return;
      }
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
    [
      data.invalidateFilterSectionLoadsForPatch,
      dutySettings.analysisMapInSidebar,
      threadMessageId,
      setPageError,
    ],
  );

  const toggleLeftPanel = useCallback(() => {
    setLeftPanelOpen((current) => !(current ?? leftPanelOpen));
  }, [leftPanelOpen]);
  const openLeftPanel = useCallback(() => {
    setLeftPanelOpen(true);
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
    if (threadMessageId != null) return;
    if (!rightPanelOpen || rightSidebarTab !== 'newCallsigns') return;
    void data.loadNewCallsigns();
  }, [threadMessageId, data.loadNewCallsigns, isMobileLayout, rightPanelOpen, rightSidebarTab]);

  useEffect(() => {
    const sections = new Set<AnalysisFilterSectionId>();
    if (rightPanelOpen && rightSidebarTab === 'stats') sections.add('groups');
    if (sections.size === 0) return;
    void Promise.all(Array.from(sections, (section) => data.loadFilterSection(section)));
  }, [data.loadFilterSection, rightPanelOpen, rightSidebarTab]);

  const canResetFilters = useMemo(() => {
    const queryStateKey = queryStateUiComparisonKey(queryState);
    const lastResetStateKey = queryStateUiComparisonKey(lastResetState);
    if (isNullOrUndefined(queryStateKey) || isNullOrUndefined(lastResetStateKey)) return false;

    return queryStateKey !== lastResetStateKey;
  }, [lastResetState, queryState]);

  const profiles = data.profiles;

  useEffect(() => {
    if (!targetMessageContextLoading || targetMessageContextResponsePending) return;

    if (targetMessageContextActive) {
      if (data.messagesLoading) {
        targetMessageContextSawReloadRef.current = true;
        return;
      }
      if (
        !targetMessageContextSawReloadRef.current &&
        data.messages === targetMessageContextPreviousMessagesRef.current
      ) {
        return;
      }
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
      highlightTarget: highlightTargetMessage,
      scrollBehavior: replyNavigationRef.current ? ('smooth' as const) : ('auto' as const),
      constrainToContent: replyNavigationRef.current,
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
    highlightTargetMessage,
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
    navigateReply,
    threadMode:
      threadMessageId == null
        ? null
        : { deletedCount: data.threadDeletedCount ?? 0, exit: exitThread },
    authUserName,
    aorEntries: data.aorEntries,
    radioFeaturesAllowed,
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
    directMessageError,
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
    groupNavigation,
    groupsActivityPeriod: data.groupsActivityPeriod,
    groupsActivity: data.groupsActivity,
    groupsActivityLoadedFreq: data.groupsActivityLoadedFreq,
    groupsActivityLoadedPeriod: data.groupsActivityLoadedPeriod,
    groupsActivityLoading: data.groupsActivityLoading,
    hasLoadedInitialMessages: data.hasLoadedInitialMessages,
    groupScopeTransitionPending,
    includeOnlyNewFreqs: effectiveQueryState.includeOnlyNewFreqs,
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
    showMessagesLoading:
      showMessagesLoading &&
      !(replyNavigationRef.current && targetMessageContextActive && !targetMessageContextLoading),
    messagesOverallCount: data.messagesOverallCount,
    messagesPaging: data.messagesPaging,
    messagesTotalCount: directMessageNavigation?.totalCount ?? data.messagesTotalCount,
    messagesTotalLoading:
      directMessageNavigation == null ? data.messagesTotalLoading : targetMessageContextLoading,
    messageComments: data.messageComments,
    messages: data.messages,
    firstLoadedMessageIndex: data.firstLoadedMessageIndex,
    hasMoreBeforeWindow: data.hasMoreBeforeWindow,
    hasMoreAfterWindow: data.hasMoreAfterWindow,
    loadingBeforeWindow: data.loadingBeforeWindow,
    loadingAfterWindow: data.loadingAfterWindow,
    directMessageLoading,
    directMessageNavigation,
    loadedReplyTarget,
    onLinkedMessageMounted,
    networkDisplayMap: data.networkDisplayMap,
    networks: data.networks,
    newCallsigns: data.newCallsigns,
    newCallsignsLoading: data.newCallsignsLoading,
    noMoreToLoad: data.noMoreToLoad,
    pageIndex: data.pageIndex,
    messagePageNavigationTarget,
    messageViewportPreservationKey,
    messageEdgeLoadRetryKey,
    messageViewportPreserving,
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
    queryState: effectiveQueryState,
    tagsLayout: dutySettings.tagsLayout,
    hideBotTags,
    hideNetworks,
    networkVisibilityReady: systemSettingsStatus === 'success',
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
    rightSidebarOutdated: data.rightSidebarOutdated,
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
    loadFilterSection: data.loadFilterSection,
    loadCorrelatedFreqs: data.loadCorrelatedFreqs,
    loadGroupsActivity: data.loadGroupsActivity,
    loadNewCallsigns: data.loadNewCallsigns,
    loadFirstPage,
    loadLastPage,
    loadNextPage,
    loadMoreMessages: data.loadMoreMessages,
    loadPreviousMessages: data.loadPreviousMessages,
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
    reload,
    resetFilters,
    saveAsNew: savedFilters.saveAsNew,
    setIncludeOnlyNewFreqs,
    selectOnlyFreq,
    openPointsOnMap,
    setCenterTab,
    setNewestFirst,
    clearMessagePageNavigationTarget,
    setMessageViewportCapture,
    setVisibleMessagesPageIndex,
    setRightSidebarTab,
    setSavedFilterName: savedFilters.setSavedFilterName,
    showFreqOnMap,
    toggleLeftPanel,
    openLeftPanel,
    selectGroupScope,
    toggleRightPanel,
    toggleUnitFromMap,
    saveEditor: editor.saveEditor,
    saveMessageUpdate: editor.saveMessageUpdate,
    repeatReportTaskRun: report.repeatReportTaskRun,
    setReportProgressExpanded: report.setReportProgressExpanded,
    toggleReportTaskRunLogs: report.toggleReportTaskRunLogs,
    unitsExactMatchOnlyDefault,
    analysisAorFilterEnabled,
    rerReportEnabled,
    rerReportFilterEnabled,
    supportNonRerInterceptions,
    cyberEchoEnabled: canUseDevices,
    updateReport: report.updateReport,
    updateExisting: savedFilters.updateExisting,
    updateQueryState,
  };
}
