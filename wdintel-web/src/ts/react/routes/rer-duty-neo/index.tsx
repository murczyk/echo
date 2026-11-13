import { MessageCardQuickActionContext } from '../shared/message-card/MessageCardQuickAction';
import {
  MessageRepliesProvider,
  ReplyMessageEditor,
  type ReplyTarget,
  type ReplyNavigation,
} from '../shared/message-replies/MessageRepliesProvider';
import {
  MessageDeleteAccessContext,
  MessageWriteAccessContext,
} from '../shared/message-card/MessageWriteAccess';
import { canWriteMessages, hasRole } from '../../utils/roles';
import { DutyExcludeMenuContext } from '../shared/message-card/DutyExcludeMenu';
import { RadioFeaturesProvider } from '../shared/RadioFeatures';
import { canUseRadioFeatures } from '../../utils/roles';
import { Box, useMediaQuery, useTheme } from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isPresent } from '../../utils/misc';

import { DeleteConfirmDialog } from './dialogs';
import {
  setDutyNeoDocumentTitleUnreadCount,
  startDutyNeoDocumentTitleTracking,
} from './notifications';
import {
  feedIndicatorUnreadCount,
  parseDutyMessageUidFromWindow,
  resolveDutyTargetMessageIds,
  stableStringify,
  type MessageItem,
} from './utils';
import { useRerDutyFeeds } from './useRerDutyFeeds';
import { useDutySearch } from './useDutySearch';
import { useRerDutyPageSettings } from './useRerDutyPageSettings';
import { useDutyFeedColumnModel, type DutyFeedColumnModelDeps } from './useDutyFeedColumnModel';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { PowerButton } from '../../components/PowerButton';
import { RerDutyNeoWorkspace } from './RerDutyNeoWorkspace';
import type { InboxItemContextRsp, InboxMessage } from '../../../../Bindings';
import type { ManageMessageEditorHandle } from '../shared/manage-message/ManageMessageDrawer';
import { focusAfterEditorSurfacesClose } from '../shared/manage-message/focus-restoration';
import {
  MANAGE_MESSAGE_EDITOR_TRANSITION_EASING,
  MANAGE_MESSAGE_EDITOR_TRANSITION_MS,
  useManageMessageEditorPresentation,
} from '../shared/manage-message/ManageMessageEditorSurface';
import type { ReportEditLoadState } from '../shared/manage-message/useManageMessageDrawer';
import { AudioTranscriptionPreferencesProvider } from '../shared/message-card/MessageCardAudioTranscription';
import { fetchMessagesByIds } from '../../services/api/inbox-messages';
import { fetchMessagesByIdsMatchingFilters } from '../../services/api/analysis';
import { isAbortError } from '../../services/api/client';
import { isIntelligenceReport } from '../shared/intelligence-reports';
import { PointBlacklistPaletteNamesCacheProvider } from '../shared/message-card/PointBlacklistPaletteNamesCache';
import { MessageDeviceAccessProvider } from '../shared/message-card/MessageDeviceAccess';
import type { MessageCardEtalonDisplayModel } from '../shared/message-card/message-card.utils';
import { dutyEditorLayoutColumns } from './duty-editor-layout';
import { findDutyFeedColumn, useDutyMinimalReportEditor } from './useDutyMinimalReportEditor';
import {
  createMessageNavigationController,
  messageNavigationErrorText,
  type MessageNavigationHost,
} from '../shared/message-navigation';
import { groupFilterScope, type GroupScope } from '../shared/group-navigation';

type DutyLinkedMessageLanding = { feedId: string; targetIds: number[]; behavior?: ScrollBehavior };

type PendingDutyLinkedMessage = DutyLinkedMessageLanding & {
  filterSignature: string;
  errorVersion: number;
  sawLoading: boolean;
  resolve: (landing: DutyLinkedMessageLanding | null) => void;
  reject: (reason: unknown) => void;
};

export type RerDutyNeoPageProps = {
  /** Auth user display name from the host page (avoids duplicate /api/user request). */
  authUserName?: string | null;
};

/** Below `sm`: scales subtree ~12.5%; height is divided so the zoomed box still fits the viewport. */
const DUTY_MOBILE_ROOT_ZOOM = 1.125;
const DUTY_VIEWPORT_HEIGHT = 'calc(100vh - var(--app-shell-total-offset, 0px))';
const DUTY_VIEWPORT_HEIGHT_DVH = 'calc(100dvh - var(--app-shell-total-offset, 0px))';

export function RerDutyNeoPage({
  authUserName: authUserNameProp = null,
}: RerDutyNeoPageProps = {}) {
  const theme = useTheme();
  const narrowScreen = useMediaQuery(theme.breakpoints.down(1024));
  const authUserName = authUserNameProp ?? null;
  const [activeFeedId, setActiveFeedId] = useState<string | null>(null);
  const [editorSourceFeedId, setEditorSourceFeedId] = useState<string | null>(null);
  const [editorSourceMessageId, setEditorSourceMessageId] = useState<number | null>(null);
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  const [createMessageOpen, setCreateMessageOpen] = useState(false);
  const [createMessageGroupMasterKey, setCreateMessageGroupMasterKey] = useState<string | null>(
    null,
  );
  const [editTarget, setEditTarget] = useState<{ id: number; message: InboxMessage } | null>(null);
  const [editAsReport, setEditAsReport] = useState(false);
  const [editTargetLoadState, setEditTargetLoadState] = useState<ReportEditLoadState>({
    status: 'idle',
  });
  const editorRef = useRef<ManageMessageEditorHandle>(null);
  const editorInitialFocusTargetRef = useRef<HTMLElement | null>(null);
  const createMessageFabRef = useRef<HTMLElement | null>(null);
  const reportLoadControllerRef = useRef<AbortController | null>(null);
  const cancelReportEditLoad = useCallback(() => {
    reportLoadControllerRef.current?.abort();
    reportLoadControllerRef.current = null;
    setEditTargetLoadState({ status: 'idle' });
  }, []);
  const [reportSource, setReportSource] = useState<{
    id: number;
    message: InboxMessage;
    senderName?: string | null;
    etalonDisplayModel: MessageCardEtalonDisplayModel;
  } | null>(null);
  const { notify } = usePowerSnackbar();
  const {
    currentUser,
    cyberEchoEnabled,
    deviceAccess,
    tagsLayout,
    audioTranscriptionCollapsed,
    audioTranscriptionEnabled,
    hideBotTags,
    hideNetworks,
    networkVisibilityReady,
    dutyExcludeMenuEnabled,
    dutySelectedGroupsEnabled,
    collapseMediaPreviews,
    largeMediaPreviews,
    largeMessageCardText,
    messageCardQuickAction,
    mediaSummaryEnabled,
    messageTextPreviewLines,
    minimalReportWindowEnabled,
    importantOnlyMyOrganism,
  } = useRerDutyPageSettings();
  const requestEditorIntent = useCallback(
    (
      key: string,
      sourceFeedId: string | null,
      commit: () => void,
      invokingControl?: HTMLElement,
      sourceMessageId?: number,
    ) => {
      if (!canWriteMessages(currentUser?.roles)) return;
      const focusTarget =
        invokingControl ??
        (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      editorInitialFocusTargetRef.current = focusTarget;
      const applyIntent = () => {
        if (sourceFeedId) setActiveFeedId(sourceFeedId);
        setEditorSourceFeedId(sourceFeedId);
        setEditorSourceMessageId(sourceMessageId ?? null);
        setReplyTarget(null);
        commit();
      };
      if (editorRef.current) {
        editorRef.current.requestIntentChange({ key, focusTarget, commit: applyIntent });
      } else {
        applyIntent();
      }
    },
    [currentUser?.roles],
  );
  const startReportEditor = useCallback(
    (reportId: number) => {
      cancelReportEditLoad();
      const controller = new AbortController();
      reportLoadControllerRef.current = controller;
      setCreateMessageOpen(false);
      setReportSource(null);
      setEditTarget(null);
      setEditAsReport(true);
      setEditTargetLoadState({ status: 'loading', reportId });
      void fetchMessagesByIds([reportId], null, { signal: controller.signal })
        .then(([report]) => {
          if (controller.signal.aborted || reportLoadControllerRef.current !== controller) return;
          if (!report) throw new Error('Розвіддонесення не знайдено.');
          reportLoadControllerRef.current = null;
          setEditTargetLoadState({ status: 'idle' });
          setEditTarget({ id: report[0], message: report[1] });
        })
        .catch((error) => {
          if (controller.signal.aborted || isAbortError(error)) return;
          if (reportLoadControllerRef.current !== controller) return;
          reportLoadControllerRef.current = null;
          setEditTargetLoadState({
            status: 'error',
            reportId,
            message:
              error instanceof Error ? error.message : 'Не вдалося відкрити розвіддонесення.',
          });
        });
    },
    [cancelReportEditLoad],
  );
  const openReportEditor = useCallback(
    (sourceFeedId: string, reportId: number, sourceMessageId: number) => {
      requestEditorIntent(
        `edit-report:${reportId}`,
        sourceFeedId,
        () => startReportEditor(reportId),
        undefined,
        sourceMessageId,
      );
    },
    [requestEditorIntent, startReportEditor],
  );
  const openMessageEditor = useCallback(
    (
      sourceFeedId: string,
      target: { id: number; message: InboxMessage },
      invokingControl?: HTMLElement,
    ) => {
      const isReport = isIntelligenceReport(target.message);
      requestEditorIntent(
        `${isReport ? 'edit-report' : 'edit-message'}:${target.id}`,
        sourceFeedId,
        () => {
          cancelReportEditLoad();
          setCreateMessageOpen(false);
          setReportSource(null);
          setEditAsReport(isReport);
          setEditTarget(target);
        },
        invokingControl,
        target.id,
      );
    },
    [cancelReportEditLoad, requestEditorIntent],
  );
  const openReportComposer = useCallback(
    (
      sourceFeedId: string,
      source: {
        id: number;
        message: InboxMessage;
        senderName?: string | null;
        etalonDisplayModel: MessageCardEtalonDisplayModel;
      },
      invokingControl: HTMLElement,
    ) => {
      requestEditorIntent(
        `create-report:${source.id}`,
        sourceFeedId,
        () => {
          cancelReportEditLoad();
          setCreateMessageOpen(false);
          setEditAsReport(false);
          setEditTarget(null);
          setReportSource(source);
        },
        invokingControl,
        source.id,
      );
    },
    [cancelReportEditLoad, requestEditorIntent],
  );
  const previousFeedCountRef = useRef(0);
  const radioFeaturesAllowed = canUseRadioFeatures(currentUser?.roles);
  const feeds = useRerDutyFeeds(
    authUserName,
    currentUser?.organismId ?? null,
    deviceAccess,
    radioFeaturesAllowed,
    hideNetworks,
    networkVisibilityReady,
  );
  const {
    messageFeeds,
    error,
    errorNotificationVersion,
    columnRefsRef,
    nearBottomByFeedIdRef,
    confirmedTailPreviewByFeedId,
    createMessageFeed,
    reloadEmptyFeeds,
    reloadFeeds,
    reloadEditedFeeds,
    flushPendingNewerMessages,
    handleEditedMessage,
    handleDeleteConfirm,
    setDeleteConfirmId,
    setDeleteConfirmFeedId,
    deleteConfirmId,
    applyFilter,
    setGroupScope,
    setFeedInitialTarget,
    setWatchModeByFeedId,
    cancelFollowTail,
  } = feeds;
  const notifiedDutyErrorRef = useRef<string | null>(null);
  const linkedNavigationPendingRef = useRef(false);
  useEffect(() => {
    if (!error) {
      notifiedDutyErrorRef.current = null;
      return;
    }
    const notificationKey = `${errorNotificationVersion}:${error}`;
    if (notifiedDutyErrorRef.current === notificationKey) return;
    notifiedDutyErrorRef.current = notificationKey;
    if (linkedNavigationPendingRef.current) return;
    notify({ message: error, severity: 'error' });
  }, [error, errorNotificationVersion, notify]);

  const [linkedMessageFocus, setLinkedMessageFocus] =
    useState<DutyFeedColumnModelDeps['linkedMessageFocus']>(null);
  const [initialTargetMessageUid] = useState(parseDutyMessageUidFromWindow);
  const [replyNavigation, setReplyNavigation] = useState<{
    feedId: string;
    reference: string;
    behavior: ScrollBehavior;
    searchTarget?: MessageItem;
  } | null>(null);
  const [searchNavigationFeedId, setSearchNavigationFeedId] = useState<string | null>(null);
  const targetMessageUid = replyNavigation?.reference ?? initialTargetMessageUid;
  const messageFeedsRef = useRef(messageFeeds);
  const applyFilterRef = useRef(applyFilter);
  const buildReqForFeedRef = useRef(feeds.buildReqForFeed);
  buildReqForFeedRef.current = feeds.buildReqForFeed;
  const setFeedInitialTargetRef = useRef(setFeedInitialTarget);
  const errorNotificationVersionRef = useRef(errorNotificationVersion);
  const notifyRef = useRef(notify);
  messageFeedsRef.current = messageFeeds;
  applyFilterRef.current = applyFilter;
  setFeedInitialTargetRef.current = setFeedInitialTarget;
  errorNotificationVersionRef.current = errorNotificationVersion;
  notifyRef.current = notify;
  const targetFeedId = replyNavigation?.feedId ?? messageFeeds[0]?.id ?? null;
  const replyNavigationRef = useRef(replyNavigation);
  replyNavigationRef.current = replyNavigation;
  const targetFeedIdRef = useRef(targetFeedId);
  targetFeedIdRef.current = targetFeedId;
  const targetMessageUidRef = useRef(targetMessageUid);
  const targetFilterSignatureRef = useRef<string | null>(null);
  const pendingLinkedMessageRef = useRef<PendingDutyLinkedMessage | null>(null);
  const linkedMessageHostRef = useRef<MessageNavigationHost<DutyLinkedMessageLanding> | null>(null);
  if (linkedMessageHostRef.current === null) {
    linkedMessageHostRef.current = {
      materialize: async (context, signal) => {
        const feedId = targetFeedIdRef.current;
        const feed = messageFeedsRef.current.find((entry) => entry.id === feedId);
        const filterSignature = targetFilterSignatureRef.current;
        if (
          !feedId ||
          !feed ||
          !filterSignature ||
          stableStringify(feed.filter) !== filterSignature
        ) {
          return Promise.resolve(null);
        }
        const targetIds = resolveDutyTargetMessageIds(
          targetMessageUidRef.current ?? '',
          context.sigintInboxItemIds.length > 0
            ? context.sigintInboxItemIds
            : context.message == null
              ? []
              : [context.message[0]],
        );
        if (targetIds.length === 0) return Promise.resolve(null);
        if (feed.items.some(([id]) => targetIds.includes(id))) {
          return { feedId, targetIds, behavior: replyNavigationRef.current?.behavior ?? 'auto' };
        }
        if (replyNavigationRef.current) {
          const matching = await fetchMessagesByIdsMatchingFilters(
            targetIds,
            buildReqForFeedRef.current({ ...feed, historySinceMs: null }, {}),
            { signal },
          );
          if (signal.aborted || matching.length === 0) return null;
        }
        return new Promise<DutyLinkedMessageLanding | null>((resolve, reject) => {
          pendingLinkedMessageRef.current = {
            feedId,
            targetIds,
            filterSignature,
            errorVersion: errorNotificationVersionRef.current,
            sawLoading: false,
            resolve,
            reject,
          };
          setFeedInitialTargetRef.current(feedId, {
            beforeIdNoninclusive: targetIds[0],
            messageIds: targetIds,
            signal,
          });
          applyFilterRef.current(feedId, feed.filter, true, {
            preserveUnread: replyNavigationRef.current != null,
          });
        });
      },
      land: async ({ feedId, targetIds, behavior = 'auto' }, signal) => {
        if (signal.aborted) return false;
        if (replyNavigationRef.current) {
          setLinkedMessageFocus({
            feedId,
            filterSignature: targetFilterSignatureRef.current!,
            focus: {
              messageId: targetIds[0],
              active: true,
              constrainToContent: true,
              behavior: replyNavigationRef.current.behavior,
              onRelease: () => setLinkedMessageFocus(null),
            },
          });
        }
        for (const id of targetIds) {
          const element = columnRefsRef.current[feedId]?.scrollToMessage?.(
            id,
            window.matchMedia('(prefers-reduced-motion: reduce)').matches
              ? 'auto'
              : (replyNavigationRef.current?.behavior ?? behavior),
          );
          if (!element) continue;
          if (replyNavigationRef.current) {
            element.getAnimations?.({ subtree: true }).forEach((animation) => {
              if (
                animation instanceof CSSAnimation &&
                animation.animationName === 'message-feed-linked-highlight'
              ) {
                animation.currentTime = 0;
              }
            });
          }
          if (columnRefsRef.current[feedId]?.highlightLinkedMessage?.(id)) return true;
        }
        return false;
      },
      invalidateNavigation: () => {
        setSearchNavigationFeedId(null);
        linkedNavigationPendingRef.current = false;
        targetFilterSignatureRef.current = null;
        pendingLinkedMessageRef.current?.resolve(null);
        pendingLinkedMessageRef.current = null;
      },
    };
  }
  const linkedMessageControllerRef = useRef<ReturnType<
    typeof createMessageNavigationController<DutyLinkedMessageLanding>
  > | null>(null);
  if (linkedMessageControllerRef.current === null) {
    linkedMessageControllerRef.current = createMessageNavigationController(
      () => linkedMessageHostRef.current!,
      (outcome) => {
        setSearchNavigationFeedId(null);
        linkedNavigationPendingRef.current = false;
        const message =
          replyNavigationRef.current && outcome.status === 'landing-error'
            ? 'Повідомлення поза поточними фільтрами. Змініть фільтри, щоб побачити його.'
            : messageNavigationErrorText(outcome);
        if (message) notifyRef.current({ message, severity: 'error' });
      },
    );
  }

  useEffect(() => {
    if (!targetMessageUid || !targetFeedId) return;
    const feed = messageFeedsRef.current.find((feed) => feed.id === targetFeedId);
    targetFilterSignatureRef.current = stableStringify(feed?.filter);
    linkedNavigationPendingRef.current = true;
    setActiveFeedId(targetFeedId);
    setWatchModeByFeedId((prev) => ({ ...prev, [targetFeedId]: false }));
    cancelFollowTail(targetFeedId);
    const searchTarget = replyNavigation?.searchTarget;
    const resolvedContext: InboxItemContextRsp | undefined = searchTarget
      ? {
          message: searchTarget,
          sigintInboxItemIds: [searchTarget[0]],
          groupMasterKeys: [],
          sinceTs: null,
          tillTs: null,
        }
      : undefined;
    void linkedMessageControllerRef.current?.navigate(targetMessageUid, resolvedContext);
    setSearchNavigationFeedId(
      searchTarget && !feed?.items.some(([id]) => id === searchTarget[0]) ? targetFeedId : null,
    );
    return () => linkedMessageControllerRef.current?.cancel();
  }, [targetMessageUid, targetFeedId, replyNavigation, setWatchModeByFeedId, cancelFollowTail]);

  useEffect(() => {
    if (!linkedNavigationPendingRef.current) return;
    const targetFeed = messageFeeds.find((feed) => feed.id === targetFeedId);
    if (!targetFeed || stableStringify(targetFeed.filter) !== targetFilterSignatureRef.current) {
      linkedMessageControllerRef.current?.cancel();
      return;
    }
    const pending = pendingLinkedMessageRef.current;
    if (!pending) return;
    if (error && errorNotificationVersion !== pending.errorVersion) {
      pendingLinkedMessageRef.current = null;
      pending.reject(new Error(error));
      return;
    }
    if (targetFeed.loading) {
      pending.sawLoading = true;
      return;
    }
    if (!pending.sawLoading) return;
    pendingLinkedMessageRef.current = null;
    pending.resolve({ feedId: pending.feedId, targetIds: pending.targetIds });
  }, [messageFeeds, targetFeedId, error, errorNotificationVersion]);

  const navigateInFeed = useCallback(
    (
      feedId: string,
      reference: string,
      behavior: ScrollBehavior = 'smooth',
      searchTarget?: MessageItem,
    ) => {
      setLinkedMessageFocus(null);
      setReplyNavigation({ feedId, reference, behavior, searchTarget });
    },
    [],
  );
  const cancelSearchNavigation = useCallback(() => {
    if (!replyNavigationRef.current?.searchTarget) return;
    linkedMessageControllerRef.current?.cancel();
    setSearchNavigationFeedId(null);
  }, []);
  const dutySearch = useDutySearch({
    messageFeeds,
    enabled: feeds.enableDutySearch,
    closeOnSelect: narrowScreen,
    buildReqForFeed: feeds.buildReqForFeed,
    pollIntervalMs: feeds.pollIntervalMs,
    navigate: (feedId, reference, item) => navigateInFeed(feedId, reference, 'auto', item),
    navigatingFeedId: searchNavigationFeedId,
    cancelNavigation: cancelSearchNavigation,
    activateFeed: setActiveFeedId,
    onError: (message, retry) =>
      notify({
        severity: 'error',
        message: (
          <>
            {message}
            <PowerButton size="small" onClick={retry}>
              Повторити
            </PowerButton>
          </>
        ),
      }),
  });
  const navigateReply = useCallback<ReplyNavigation>(
    (message, source) => {
      const feedId = source.closest<HTMLElement>('[data-duty-feed-id]')?.dataset.dutyFeedId;
      if (!feedId) return;
      const reference = new URL(message.href, window.location.origin).searchParams.get('m');
      if (reference) navigateInFeed(feedId, reference);
    },
    [navigateInFeed],
  );
  const openReplyComposer = useCallback(
    (target: ReplyTarget) => {
      const feedId =
        target.focus?.closest<HTMLElement>('[data-duty-feed-id]')?.dataset.dutyFeedId ?? null;
      requestEditorIntent(
        `reply:${target.id}`,
        feedId,
        () => {
          cancelReportEditLoad();
          setCreateMessageOpen(false);
          setEditTarget(null);
          setEditAsReport(false);
          setReportSource(null);
          setReplyTarget(target);
        },
        target.focus ?? undefined,
        target.id,
      );
    },
    [requestEditorIntent, cancelReportEditLoad],
  );

  const editorHighlightedMessageId = createMessageOpen ? null : editorSourceMessageId;
  const selectGroupScope = useCallback(
    (feedId: string, scope: GroupScope) => {
      setGroupScope(feedId, scope.kind === 'group' ? scope.masterKey : null);
    },
    [setGroupScope],
  );
  const { buildFeedColumnModel, dismissUnreadBoundary } = useDutyFeedColumnModel({
    feeds: {
      ...feeds,
      handleArrowClick: (feedId) => {
        dutySearch.clearSelection(feedId);
        return feeds.handleArrowClick(feedId);
      },
    },
    searchColumnFor: dutySearch.columnFor,
    editorSourceFeedId,
    editorHighlightedMessageId,
    linkedMessageFocus,
    narrowScreen,
    authUserName,
    currentUser,
    canUseMessageDevices: cyberEchoEnabled,
    tagsLayout,
    hideBotTags,
    hideNetworks: hideNetworks || !networkVisibilityReady,
    dutySelectedGroupsEnabled,
    collapseMediaPreviews,
    mediaSummaryEnabled,
    messageTextPreviewLines,
    importantOnlyMyOrganism,
    openReportEditor,
    openMessageEditor,
    openReportComposer,
    selectGroupScope,
  });

  const activeFeedIdSafe = messageFeeds.some((feed) => feed.id === activeFeedId)
    ? activeFeedId
    : (messageFeeds[0]?.id ?? null);
  const previousActiveFeedIdForFlushRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeFeedIdSafe) return;
    // Desktop/narrow active-only: remounting a column should surface buffered newer pages.
    if (previousActiveFeedIdForFlushRef.current === activeFeedIdSafe) return;
    previousActiveFeedIdForFlushRef.current = activeFeedIdSafe;
    flushPendingNewerMessages(activeFeedIdSafe, { urgent: true });
  }, [activeFeedIdSafe, flushPendingNewerMessages]);
  const [hasCompletedInitialLoad, setHasCompletedInitialLoad] = useState(false);
  const openCreateMessageComposer = useCallback(
    (feedId: string, focusTarget?: HTMLElement) => {
      const sourceFeed = messageFeeds.find((feed) => feed.id === feedId);
      const scope = groupFilterScope(sourceFeed?.filter.groupsSelected ?? []);
      const scopeKey = scope.kind === 'group' ? scope.masterKey : 'all';
      createMessageFabRef.current = focusTarget ?? null;
      requestEditorIntent(
        `create-message:${feedId}:${scopeKey}`,
        feedId,
        () => {
          cancelReportEditLoad();
          setEditTarget(null);
          setEditAsReport(false);
          setReportSource(null);
          setCreateMessageGroupMasterKey(scope.kind === 'group' ? scope.masterKey : null);
          setCreateMessageOpen(true);
        },
        focusTarget,
      );
    },
    [cancelReportEditLoad, messageFeeds, requestEditorIntent],
  );
  const closeMessageEditor = useCallback(() => {
    cancelReportEditLoad();
    setReplyTarget(null);
    setCreateMessageOpen(false);
    setEditTarget(null);
    setEditAsReport(false);
    setReportSource(null);
    setEditorSourceMessageId(null);
  }, [cancelReportEditLoad]);
  const editorIntentKey = replyTarget
    ? `reply:${replyTarget.id}`
    : createMessageOpen
      ? `create-message:${editorSourceFeedId ?? 'unknown'}:${createMessageGroupMasterKey ?? 'all'}`
      : reportSource
        ? `create-report:${reportSource.id}`
        : editTarget
          ? `${editAsReport ? 'edit-report' : 'edit-message'}:${editTarget.id}`
          : editTargetLoadState.status !== 'idle'
            ? `edit-report:${editTargetLoadState.reportId}`
            : null;
  const editorOpen = editorIntentKey !== null;
  const editorPresentation = useManageMessageEditorPresentation();
  const reduceEditorMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const minimalReport = useDutyMinimalReportEditor({
    enabled: minimalReportWindowEnabled && editorPresentation === 'embedded',
    reportIntent: reportSource !== null || editAsReport,
    editorIntentKey,
    sourceFeedId: editorSourceFeedId,
    feedIdsKey: messageFeeds.map((feed) => feed.id).join(),
  });
  const editorEmbeddedOpen =
    editorOpen && editorPresentation === 'embedded' && !minimalReport.active;
  const previousCanWriteRef = useRef<boolean | null>(null);

  useEffect(() => {
    if (editorOpen || editorSourceFeedId == null) return;
    return focusAfterEditorSurfacesClose(() => {
      const sourceColumn = findDutyFeedColumn(editorSourceFeedId);
      const createMessageButton =
        sourceColumn?.querySelector<HTMLElement>('[aria-label="Додати повідомлення"]') ?? null;
      createMessageFabRef.current = createMessageButton;
      return document.activeElement === document.body ? createMessageButton : null;
    });
  }, [editorOpen, editorSourceFeedId]);

  useEffect(() => {
    if (deviceAccess.status === 'loading') return;
    const canWrite = canWriteMessages(currentUser?.roles);
    if (previousCanWriteRef.current === true && !canWrite && editorOpen) {
      cancelReportEditLoad();
      if (editorRef.current) editorRef.current.closeWithoutConfirmation();
      else closeMessageEditor();
      notify({
        message: 'Доступ до створення та редагування повідомлень втрачено.',
        severity: 'error',
      });
    }
    previousCanWriteRef.current = canWrite;
  }, [
    cancelReportEditLoad,
    closeMessageEditor,
    currentUser?.roles,
    deviceAccess.status,
    editorOpen,
    notify,
  ]);

  useEffect(() => () => cancelReportEditLoad(), [cancelReportEditLoad]);
  const handleCreatedMessage = useCallback(() => {
    if (createMessageOpen && editorSourceFeedId) dismissUnreadBoundary(editorSourceFeedId);
    // Do not reloadFeeds(): that re-pins the scroller to the bottom.
    reloadEmptyFeeds();
    notify({
      message: reportSource
        ? 'Розвіддонесення успішно створено.'
        : 'Повідомлення успішно створено.',
      severity: 'success',
    });
  }, [
    createMessageOpen,
    dismissUnreadBoundary,
    editorSourceFeedId,
    notify,
    reloadEmptyFeeds,
    reportSource,
  ]);

  useEffect(() => {
    if (
      !hasCompletedInitialLoad &&
      messageFeeds.length > 0 &&
      messageFeeds.every((feed) => !feed.loading)
    ) {
      setHasCompletedInitialLoad(true);
    }
  }, [hasCompletedInitialLoad, messageFeeds]);

  useEffect(() => {
    if (
      messageFeeds.length === previousFeedCountRef.current &&
      messageFeeds.some((feed) => feed.id === activeFeedId)
    )
      return;
    if (messageFeeds.length === 0) {
      if (activeFeedId !== null) setActiveFeedId(null);
      previousFeedCountRef.current = 0;
      return;
    }
    setActiveFeedId((current) => {
      const currentExists = isPresent(current) && messageFeeds.some((feed) => feed.id === current);
      if (messageFeeds.length > previousFeedCountRef.current) {
        if (targetMessageUid && previousFeedCountRef.current === 0) {
          return messageFeeds[0].id;
        }
        return messageFeeds[messageFeeds.length - 1].id;
      }
      if (currentExists) return current;
      return messageFeeds[0].id;
    });
    previousFeedCountRef.current = messageFeeds.length;
  }, [activeFeedId, messageFeeds, targetMessageUid]);

  const dutyTabUnreadTotal = useMemo(
    () =>
      messageFeeds.reduce(
        (total, feed) =>
          total +
          feedIndicatorUnreadCount(feed, confirmedTailPreviewByFeedId[feed.id], {
            includeBeyondTailResidual: nearBottomByFeedIdRef.current[feed.id] !== true,
          }),
        0,
      ),
    [messageFeeds, confirmedTailPreviewByFeedId, nearBottomByFeedIdRef],
  );
  const anyFeedInitialLoading = messageFeeds.some(
    (feed) => feed.loading && feed.items.length === 0,
  );
  const isInitialLoading = !hasCompletedInitialLoad && anyFeedInitialLoading;
  useEffect(() => startDutyNeoDocumentTitleTracking(), []);
  useEffect(() => {
    setDutyNeoDocumentTitleUnreadCount(dutyTabUnreadTotal);
  }, [dutyTabUnreadTotal]);

  const content = (
    <RadioFeaturesProvider allowed={radioFeaturesAllowed}>
      <Box
        className={`w-full min-h-0${largeMediaPreviews && !collapseMediaPreviews ? ' message-card-previews-large' : ''}`}
        data-message-card-text-size={largeMessageCardText ? 'large' : 'compact'}
        data-duty-editor-layout
        style={{
          display: editorPresentation === 'embedded' ? 'grid' : 'flex',
          gridTemplateColumns:
            editorPresentation === 'embedded'
              ? dutyEditorLayoutColumns(editorEmbeddedOpen)
              : undefined,
          columnGap:
            editorPresentation === 'embedded' ? (editorEmbeddedOpen ? '8px' : '0px') : undefined,
          transition:
            editorPresentation === 'embedded' && !reduceEditorMotion
              ? `grid-template-columns ${MANAGE_MESSAGE_EDITOR_TRANSITION_MS}ms ${MANAGE_MESSAGE_EDITOR_TRANSITION_EASING}, column-gap ${MANAGE_MESSAGE_EDITOR_TRANSITION_MS}ms ${MANAGE_MESSAGE_EDITOR_TRANSITION_EASING}`
              : 'none',
        }}
        sx={{
          zoom: narrowScreen ? DUTY_MOBILE_ROOT_ZOOM : 1,
          height: narrowScreen
            ? `calc((${DUTY_VIEWPORT_HEIGHT}) / ${DUTY_MOBILE_ROOT_ZOOM})`
            : DUTY_VIEWPORT_HEIGHT,
          '@supports (height: 100dvh)': {
            height: narrowScreen
              ? `calc((${DUTY_VIEWPORT_HEIGHT_DVH}) / ${DUTY_MOBILE_ROOT_ZOOM})`
              : DUTY_VIEWPORT_HEIGHT_DVH,
          },
          minHeight: 0,
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <Box className="flex min-w-0 min-h-0 flex-1 flex-col">
          <Box className="flex items-center justify-between flex-wrap gap-2 mb-2 shrink-0" />

          <PointBlacklistPaletteNamesCacheProvider>
            <MessageDeviceAccessProvider allowed={cyberEchoEnabled}>
              <AudioTranscriptionPreferencesProvider
                collapsedByDefault={audioTranscriptionCollapsed}
                enabled={audioTranscriptionEnabled}
              >
                <DutyExcludeMenuContext.Provider value={dutyExcludeMenuEnabled ?? true}>
                  <RerDutyNeoWorkspace
                    activeFeedId={activeFeedIdSafe}
                    buildFeedColumnModel={buildFeedColumnModel}
                    searchFeedId={dutySearch.activeFeedId}
                    columnRefsRef={columnRefsRef}
                    createMessageFeed={createMessageFeed}
                    openCreateMessageComposer={openCreateMessageComposer}
                    isInitialLoading={isInitialLoading}
                    messageFeeds={messageFeeds}
                    narrowScreen={narrowScreen}
                    onSelectFeed={(next) => {
                      setActiveFeedId(next);
                      if (
                        !editorEmbeddedOpen &&
                        dutySearch.activeFeedId &&
                        next !== dutySearch.activeFeedId
                      )
                        dutySearch.close();
                    }}
                    editorOpen={editorOpen}
                    editorEmbeddedOpen={editorEmbeddedOpen}
                  />
                </DutyExcludeMenuContext.Provider>
              </AudioTranscriptionPreferencesProvider>
            </MessageDeviceAccessProvider>
          </PointBlacklistPaletteNamesCacheProvider>

          <DeleteConfirmDialog
            open={isPresent(deleteConfirmId)}
            onClose={() => {
              setDeleteConfirmId(null);
              setDeleteConfirmFeedId(null);
            }}
            onConfirm={handleDeleteConfirm}
          />
        </Box>

        <Box
          data-duty-editor-dock={editorEmbeddedOpen ? 'true' : undefined}
          sx={{
            display: editorPresentation === 'embedded' ? 'flex' : 'contents',
            position: editorPresentation === 'embedded' ? 'relative' : undefined,
            minWidth: 0,
            minHeight: 0,
            overflow: editorPresentation === 'embedded' ? 'hidden' : undefined,
            '&::before': editorEmbeddedOpen
              ? {
                  content: '""',
                  position: 'absolute',
                  inset: '0 auto 0 0',
                  width: '1px',
                  backgroundColor: 'divider',
                  pointerEvents: 'none',
                  zIndex: 1,
                }
              : undefined,
          }}
        >
          <ReplyMessageEditor
            replyTarget={replyTarget}
            timeBasis="creation"
            ref={editorRef}
            hideNetworks={hideNetworks || !networkVisibilityReady}
            open={editorOpen}
            intentKey={editorIntentKey ?? 'closed'}
            initialGroupMasterKey={
              replyTarget?.message.groupMasterKey ??
              (createMessageOpen ? createMessageGroupMasterKey : null)
            }
            presentation={editorPresentation}
            minimalReport={
              minimalReport.active
                ? { host: minimalReport.host, onExpand: minimalReport.expand }
                : null
            }
            adaptiveEmbeddedForm
            fillEmbeddedSurface
            transparentEmbeddedSurface
            initialFocusTarget={editorInitialFocusTargetRef.current}
            focusFallbackRef={createMessageFabRef}
            cyberEchoEnabled={cyberEchoEnabled}
            currentUser={currentUser}
            editTarget={editTarget}
            editAsReport={editAsReport}
            editTargetLoadState={editTargetLoadState}
            onRetryEditTargetLoad={() => {
              if (editTargetLoadState.status !== 'idle')
                startReportEditor(editTargetLoadState.reportId);
            }}
            reportSource={reportSource}
            onClose={closeMessageEditor}
            onSubmitEdit={
              editTarget && !editAsReport
                ? async (messageId, message) => {
                    handleEditedMessage(messageId, message);
                  }
                : undefined
            }
            onEditSuccess={() => {
              if (editAsReport) {
                reloadFeeds();
              } else {
                reloadEditedFeeds();
              }
            }}
            onDeleteSuccess={() => {
              reloadFeeds();
              notify({ message: 'Розвіддонесення успішно видалено.', severity: 'success' });
            }}
            onCreated={handleCreatedMessage}
          />
        </Box>
      </Box>
    </RadioFeaturesProvider>
  );
  return (
    <MessageWriteAccessContext.Provider value={canWriteMessages(currentUser?.roles)}>
      <MessageDeleteAccessContext.Provider value={hasRole(currentUser?.roles, 'DeleteMsg')}>
        <MessageRepliesProvider
          screen="Duty"
          onReply={openReplyComposer}
          onNavigate={navigateReply}
          filterRequests={Object.fromEntries(
            messageFeeds.map((feed) => [feed.id, feeds.buildReqForFeed(feed, {})]),
          )}
          currentUser={currentUser}
        >
          <MessageCardQuickActionContext.Provider value={messageCardQuickAction}>
            {content}
          </MessageCardQuickActionContext.Provider>
        </MessageRepliesProvider>
      </MessageDeleteAccessContext.Provider>
    </MessageWriteAccessContext.Provider>
  );
}
