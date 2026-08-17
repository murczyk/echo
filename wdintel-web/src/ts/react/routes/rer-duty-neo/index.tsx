import { Box, useMediaQuery, useTheme } from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isPresent } from '../../utils/misc';

import { CommentDialog, DeleteConfirmDialog } from './dialogs';
import {
  setDutyNeoDocumentTitleUnreadCount,
  startDutyNeoDocumentTitleTracking,
} from './notifications';
import {
  DEFAULT_DUTY_TAGS_LAYOUT,
  feedIndicatorUnreadCount,
  feedNeedsUnreadPrefetch,
  excludeMessageEntityFromFilters,
  type MessageFeedState,
  type TagsLayoutVariant,
} from './utils';
import { useRerDutyFeeds } from './useRerDutyFeeds';
import { USER_SETTINGS_UPDATED_EVENT, fetchUserSettings } from '../../services/api/user-settings';
import { PowerAlert } from '../../components/PowerAlert';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { RerDutyNeoWorkspace } from './RerDutyNeoWorkspace';
import type { FeedColumnModel } from './types';
import { fetchCurrentUser } from '../../services/api/user';
import { currentSystemSettings } from '../../services/api/system-settings';
import type { InboxMessage, User } from '../../../../Bindings';
import { ManageMessageDrawer } from '../shared/manage-message/ManageMessageDrawer';
import { AudioTranscriptionPreferencesProvider } from '../shared/message-card/MessageCardAudioTranscription';
import { PointBlacklistPaletteNamesCacheProvider } from '../shared/message-card/PointBlacklistPaletteNamesCache';

export type RerDutyNeoPageProps = {
  /** Auth user display name from the host page (avoids duplicate /api/user request). */
  authUserName?: string | null;
};

/** Below `sm`: scales subtree ~12.5%; height is divided so the zoomed box still fits the viewport. */
const DUTY_MOBILE_ROOT_ZOOM = 1.125;
const DUTY_VIEWPORT_HEIGHT = 'calc(100vh - var(--app-shell-total-offset, 0px))';
const DUTY_VIEWPORT_HEIGHT_DVH = 'calc(100dvh - var(--app-shell-total-offset, 0px))';

function dutyFeedColumnMaxWidth(feedCount: number, narrow: boolean): string {
  if (narrow) return '100%';
  if (feedCount <= 1) return '960px';
  return '100%';
}

export function RerDutyNeoPage({
  authUserName: authUserNameProp = null,
}: RerDutyNeoPageProps = {}) {
  const theme = useTheme();
  const narrowScreen = useMediaQuery(theme.breakpoints.down(1024));
  const authUserName = authUserNameProp ?? null;
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [cyberEchoEnabled, setCyberEchoEnabled] = useState(false);
  const [activeFeedId, setActiveFeedId] = useState<string | null>(null);
  const [createMessageOpen, setCreateMessageOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<{ id: number; message: InboxMessage } | null>(null);
  const { notify } = usePowerSnackbar();
  const previousFeedCountRef = useRef(0);
  const [tagsLayout, setTagsLayout] = useState<TagsLayoutVariant>(DEFAULT_DUTY_TAGS_LAYOUT);
  const [audioTranscriptionCollapsed, setAudioTranscriptionCollapsed] = useState(false);
  const [audioTranscriptionEnabled, setAudioTranscriptionEnabled] = useState(false);
  const [collapseMediaPreviews, setCollapseMediaPreviews] = useState(true);
  useEffect(() => {
    let cancelled = false;
    const loadLayout = async () => {
      try {
        const prefs = await fetchUserSettings();
        if (cancelled) return;
        setTagsLayout(prefs.tagsLayout);
        setAudioTranscriptionCollapsed(prefs.dutyAudioTranscriptionCollapsed ?? false);
        setCollapseMediaPreviews(prefs.dutyCollapseMediaPreviews ?? true);
      } catch {
        if (cancelled) return;
        setTagsLayout(DEFAULT_DUTY_TAGS_LAYOUT);
        setAudioTranscriptionCollapsed(false);
        setCollapseMediaPreviews(true);
      }
    };
    loadLayout();
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    const onSettingsUpdated = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          tagsLayout?: TagsLayoutVariant;
          dutyAudioTranscriptionCollapsed?: boolean;
          dutyCollapseMediaPreviews?: boolean;
        }>
      ).detail;
      if (detail?.tagsLayout) {
        setTagsLayout(detail.tagsLayout);
      }
      if (typeof detail?.dutyAudioTranscriptionCollapsed === 'boolean') {
        setAudioTranscriptionCollapsed(detail.dutyAudioTranscriptionCollapsed);
      }
      if (typeof detail?.dutyCollapseMediaPreviews === 'boolean') {
        setCollapseMediaPreviews(detail.dutyCollapseMediaPreviews);
      }
    };

    window.addEventListener(USER_SETTINGS_UPDATED_EVENT, onSettingsUpdated as EventListener);
    return () => {
      window.removeEventListener(USER_SETTINGS_UPDATED_EVENT, onSettingsUpdated as EventListener);
    };
  }, []);
  useEffect(() => {
    const abortController = new AbortController();

    void currentSystemSettings()
      .then((settings) => {
        if (abortController.signal.aborted) return;
        setCyberEchoEnabled(settings.devicesSectionEnabled);
        setAudioTranscriptionEnabled(settings.enableAudioTranscription ?? false);
      })
      .catch(() => {
        if (abortController.signal.aborted) return;
        setCyberEchoEnabled(false);
        setAudioTranscriptionEnabled(false);
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
      .catch(() => {
        if (abortController.signal.aborted) return;
        setCurrentUser(null);
      });

    return () => {
      abortController.abort();
    };
  }, []);
  // Per-feed action identities must stay stable across renders so the memoized
  // FeedColumnContent can bail out when only *other* feeds change. Fresh arrow
  // props would defeat its comparator and re-render every column on any update.
  const feedActionImplsRef = useRef<Record<string, FeedColumnModel['actions']>>({});
  const feedStableActionsRef = useRef<Record<string, FeedColumnModel['actions']>>({});
  const getStableFeedActions = (feed: MessageFeedState): FeedColumnModel['actions'] => {
    const feedId = feed.id;
    // Refresh the latest closures (capturing current feed/state) every render.
    feedActionImplsRef.current[feedId] = {
      onLoadOlder: () => loadFeedOlderMessages(feedId),
      onLoadNewer: () =>
        loadFeedNewerMessages(feedId, { skipIfNewestExhausted: true, showLoading: false }),
      onFlushPendingNewer: () => flushPendingNewerMessages(feedId, { urgent: true }),
      onRemoveColumn: () => removeMessageFeed(feedId),
      onMessageBookmark: (msgId, currentlyBookmarked) =>
        handleMessageBookmark(feedId, msgId, currentlyBookmarked),
      onMessageImportant: (msgId, currentlyImportant) =>
        handleMessageImportant(feedId, msgId, currentlyImportant),
      onMessageAddFrequencyToFilter: (_feedId, freq) => addFrequencyToFilter(feedId, freq),
      onMessageCopy: handleMessageCopy,
      onMessageComment: (msgId, currentComment) => openCommentDialog(msgId, feedId, currentComment),
      onMessageExcludeEntity: (entity, value) =>
        applyFilter(feedId, excludeMessageEntityFromFilters(feed.filter, entity, value)),
      onMessageToggleTag: (msgId, tagId) => handleToggleTag(feedId, msgId, tagId),
      onMessageEdit: (messageId, message) => {
        setCreateMessageOpen(false);
        setEditTarget({ id: messageId, message });
      },
      onScrollToTop: () => {
        cancelFollowTail(feedId);
        setWatchModeByFeedId((prev) => ({ ...prev, [feedId]: false }));
      },
      onReachedBottom: ({ hasSeenNotAtBottom }) => {
        const tailAvailability = tailAvailabilityByFeedId[feedId] ?? 'unknown';
        const hasPendingTail =
          feedIndicatorUnreadCount(feed, confirmedTailPreviewByFeedId[feedId], {
            // Residual poll stock must not block watch-mode catch-up at the bottom.
            includeBeyondTailResidual: false,
          }) > 0 ||
          (feed.pendingNewerItems?.length ?? 0) > 0 ||
          tailAvailability === 'available' ||
          tailAvailability === 'checking' ||
          tailAvailability === 'loading';
        const preservePendingTail = hasSeenNotAtBottom && hasPendingTail;
        if (preservePendingTail) {
          cancelFollowTail(feedId);
          setWatchModeByFeedId((prev) => ({ ...prev, [feedId]: false }));
          // Flush buffered pages into the window, then keep fetching without auto-follow.
          flushPendingNewerMessages(feedId, { urgent: true });
          void loadFeedNewerMessages(feedId, {
            skipIfNewestExhausted: true,
            showLoading: false,
          });
        } else {
          flushPendingNewerMessages(feedId, { markAllRead: true, urgent: true });
          ensureFollowTail(feedId);
          if (!dutyDisableAutoScroll) {
            setWatchModeByFeedId((prev) => ({ ...prev, [feedId]: true }));
          }
        }
        if (feed.items.length > 0) {
          handleVisibleMessageIds(feedId)(feed.items[feed.items.length - 1][0], {
            atBottom: true,
          });
        }
        return !preservePendingTail;
      },
      onLeftBottom: () => {
        cancelFollowTail(feedId);
        setWatchModeByFeedId((prev) => ({ ...prev, [feedId]: false }));
      },
      onNearBottomChange: (near) => {
        nearBottomByFeedIdRef.current = {
          ...nearBottomByFeedIdRef.current,
          [feedId]: near,
        };
      },
      onAtBottomChange: (atBottom) => {
        atBottomByFeedIdRef.current = {
          ...atBottomByFeedIdRef.current,
          [feedId]: atBottom,
        };
      },
      onPhysicalBottomChange: (atBottom) => {
        physicallyAtBottomByFeedIdRef.current = {
          ...physicallyAtBottomByFeedIdRef.current,
          [feedId]: atBottom,
        };
      },
      onArrowClick: () => handleArrowClick(feedId),
      onVisibleMessageIds: handleVisibleMessageIds(feedId),
    };
    // Create the stable wrapper set once per feed; it delegates to the latest impls.
    const existing = feedStableActionsRef.current[feedId];
    if (existing) return existing;
    const latest = () => feedActionImplsRef.current[feedId];
    const stable: FeedColumnModel['actions'] = {
      onLoadOlder: () => latest().onLoadOlder(),
      onLoadNewer: () => latest().onLoadNewer?.(),
      onFlushPendingNewer: () => latest().onFlushPendingNewer?.(),
      onRemoveColumn: () => latest().onRemoveColumn(),
      onMessageBookmark: (msgId, currentlyBookmarked) =>
        latest().onMessageBookmark(msgId, currentlyBookmarked),
      onMessageImportant: (msgId, currentlyImportant) =>
        latest().onMessageImportant(msgId, currentlyImportant),
      onMessageAddFrequencyToFilter: (fId, freq) =>
        latest().onMessageAddFrequencyToFilter(fId, freq),
      onMessageCopy: (text, feedbackId) => latest().onMessageCopy(text, feedbackId),
      onMessageComment: (msgId, currentComment) => latest().onMessageComment(msgId, currentComment),
      onMessageExcludeEntity: (entity, value) => latest().onMessageExcludeEntity(entity, value),
      onMessageToggleTag: (msgId, tagId) => latest().onMessageToggleTag(msgId, tagId),
      onMessageEdit: (messageId, message) => latest().onMessageEdit(messageId, message),
      onScrollToTop: () => latest().onScrollToTop?.(),
      onReachedBottom: (context) => latest().onReachedBottom?.(context),
      onLeftBottom: () => latest().onLeftBottom?.(),
      onNearBottomChange: (near) => latest().onNearBottomChange?.(near),
      onAtBottomChange: (atBottom) => latest().onAtBottomChange?.(atBottom),
      onPhysicalBottomChange: (atBottom) => latest().onPhysicalBottomChange?.(atBottom),
      onArrowClick: () => latest().onArrowClick?.(),
      onVisibleMessageIds: (lastVisibleId, opts) =>
        latest().onVisibleMessageIds?.(lastVisibleId, opts),
    };
    feedStableActionsRef.current[feedId] = stable;
    return stable;
  };
  const buildFeedColumnModel = (feed: MessageFeedState) => ({
    feed,
    view: {
      narrowScreen,
      feedCount: messageFeeds.length,
      canRemove: messageFeeds.length > 1,
      maxWidth: dutyFeedColumnMaxWidth(messageFeeds.length, narrowScreen),
      isWatchMode: !dutyDisableAutoScroll && (watchModeByFeedId[feed.id] ?? true),
      loadingNewer: loadingNewerFeedIds.has(feed.id),
      arrowResultMessage: arrowResultByFeedId[feed.id] ?? null,
      bottomUnreadCount: feedIndicatorUnreadCount(feed, confirmedTailPreviewByFeedId[feed.id], {
        // Near-bottom: keep matching tail preview (real beyond-tail pending); only drop residual stock.
        includeBeyondTailResidual: nearBottomByFeedIdRef.current[feed.id] !== true,
      }),
      physicallyAtBottom:
        feed.items.length === 0 ? true : (physicallyAtBottomByFeedIdRef.current[feed.id] ?? false),
      tailAvailability: tailAvailabilityByFeedId[feed.id] ?? 'unknown',
      unreadPrefetchNeeded: feedNeedsUnreadPrefetch(feed),
      pendingNewerFlushNeeded: (feed.pendingNewerItems?.length ?? 0) > 0,
    },
    filterPanel: {
      feedId: feed.id,
      filterState: {
        groupsSelected: feed.filter.groupsSelected ?? [],
        deniedGroups: feed.filter.groupsDenied ?? [],
        sendersSelected: feed.filter.sendersSelected ?? [],
        deniedSenders: feed.filter.deniedSenders ?? [],
        freqsSelected: feed.filter.freqsSelected ?? [],
        freqsDenied: feed.filter.freqsDenied ?? [],
        postsSelected: feed.filter.postsSelected ?? [],
        postsDenied: feed.filter.postsDenied ?? [],
        unitsSelected: feed.filter.unitsSelected ?? [],
        unitsDenied: feed.filter.unitsDenied ?? [],
      },
      sources: {
        groupsList,
        groupInfos,
        profiles,
        senderOptions,
        freqs,
        postsList,
        unitsList: Object.values(unitsMap),
      },
      toggles: {
        adjacentFreqsRange: feed.adjacentFreqsRange,
        highlightSignalsEnabled: feed.highlightSignalsEnabled,
        onlyMyUnitTagsEnabled: feed.onlyMyUnitTagsEnabled,
        unitsExactMatchOnly: feed.filter.unitsExactMatchOnly ?? undefined,
        reloadFreqsLoading,
        groupCatalogLoading,
        groupCatalogError,
      },
      savedFilters: {
        savedFilters,
        selectedSavedId: selectedSavedIdByFeedId[feed.id] ?? null,
        saveFilterName: saveFilterNameByFeedId[feed.id] ?? '',
      },
      actions: {
        onGroupsChange: (v: string[]) =>
          applyFilter(feed.id, { ...feed.filter, groupsSelected: v.length ? v : null }),
        onDeniedGroupsChange: (v: string[]) =>
          applyFilter(feed.id, { ...feed.filter, groupsDenied: v.length ? v : null }),
        onSendersChange: (v: string[]) =>
          applyFilter(feed.id, { ...feed.filter, sendersSelected: v.length ? v : null }),
        onDeniedSendersChange: (v: string[]) =>
          applyFilter(feed.id, { ...feed.filter, deniedSenders: v.length ? v : null }),
        onFreqsChange: (v: string[]) =>
          applyFilter(feed.id, { ...feed.filter, freqsSelected: v.length ? v : null }),
        onFreqsDeniedChange: (v: string[]) =>
          applyFilter(feed.id, { ...feed.filter, freqsDenied: v.length ? v : null }),
        onPostsChange: (v: string[]) =>
          applyFilter(feed.id, { ...feed.filter, postsSelected: v.length ? v : null }),
        onPostsDeniedChange: (v: string[]) =>
          applyFilter(feed.id, { ...feed.filter, postsDenied: v.length ? v : null }),
        onUnitsChange: (v: string[]) =>
          applyFilter(feed.id, { ...feed.filter, unitsSelected: v.length ? v : null }),
        onUnitsDeniedChange: (v: string[]) =>
          applyFilter(feed.id, { ...feed.filter, unitsDenied: v.length ? v : null }),
        onUnitsExactMatchOnlyChange: (v: boolean) =>
          applyFilter(feed.id, { ...feed.filter, unitsExactMatchOnly: v }),
        onAdjacentFreqsRangeChange: (v: number) =>
          setMessageFeeds((prev) =>
            prev.map((f) => (f.id === feed.id ? { ...f, adjacentFreqsRange: v } : f)),
          ),
        onHighlightSignalsChange: (v: boolean) => {
          setMessageFeeds((prev) =>
            prev.map((f) => (f.id === feed.id ? { ...f, highlightSignalsEnabled: v } : f)),
          );
          loadFeedInitialMessages(feed.id, { highlightSignalsEnabled: v });
        },
        onOnlyMyUnitTagsChange: (v: boolean) => {
          setMessageFeeds((prev) =>
            prev.map((f) => (f.id === feed.id ? { ...f, onlyMyUnitTagsEnabled: v } : f)),
          );
        },
        onReloadFreqs: reloadLatestFrequencies,
        onReloadGroupCatalog: reloadGroupCatalog,
        onSavedFilterSelect: (id) =>
          setSelectedSavedIdByFeedId((prev) => ({ ...prev, [feed.id]: id === '' ? null : id })),
        onSaveFilterNameChange: (value) =>
          setSaveFilterNameByFeedId((prev) => ({ ...prev, [feed.id]: value })),
        onSaveFilter: handleSaveFilter,
        onUpdateSelectedSavedFilter: handleUpdateSelectedSavedFilter,
        onRenameSelectedSavedFilter: handleRenameSelectedSavedFilter,
        onDeleteSelectedSavedFilter: handleDeleteSelectedSavedFilter,
        onApplySavedFilter: (saved) => handleApplySavedFilter(feed.id, saved),
      },
    },
    keywordsPanel: {
      keywordSets,
      onFilterChange: applyFilter,
      onKeywordSetsReload: reloadKeywordSets,
    },
    messageCard: {
      authUserName,
      tagContributionsOrganismId: feed.onlyMyUnitTagsEnabled
        ? (currentUser?.organismId ?? undefined)
        : undefined,
      copiedFeedbackId,
      networkDisplayMap,
      networkMap,
      unitsMap,
      callsignInfoMap,
      groupInfos,
      profiles,
      featureStrictNetworks,
      tagsLayout,
      collapseMediaPreviews,
      tagsMap,
      tagsOrder,
      botTagAction,
      onCancelBotTagAction,
      onMarkBotTagWrong,
      onOpenPointsOnMap: handleOpenPointsOnMap,
      onAddPointHighlightBlacklist,
    },
    actions: getStableFeedActions(feed),
  });
  const {
    messageFeeds,
    error,
    clearDutyError,
    columnRefsRef,
    nearBottomByFeedIdRef,
    atBottomByFeedIdRef,
    physicallyAtBottomByFeedIdRef,
    tailAvailabilityByFeedId,
    confirmedTailPreviewByFeedId,
    beginFollowTail,
    ensureFollowTail,
    cancelFollowTail,
    dutyDisableAutoScroll,
    createMessageFeed,
    removeMessageFeed,
    loadFeedInitialMessages,
    reloadEmptyFeeds,
    reloadFeeds,
    reloadEditedFeeds,
    loadFeedOlderMessages,
    loadFeedNewerMessages,
    flushPendingNewerMessages,
    handleSaveFilter,
    handleApplySavedFilter,
    handleUpdateSelectedSavedFilter,
    handleRenameSelectedSavedFilter,
    handleDeleteSelectedSavedFilter,
    handleMessageBookmark,
    handleMessageImportant,
    handleOpenPointsOnMap,
    onAddPointHighlightBlacklist,
    addFrequencyToFilter,
    handleMessageCopy,
    handleEditedMessage,
    handleDeleteConfirm,
    setDeleteConfirmId,
    setDeleteConfirmFeedId,
    openCommentDialog,
    commentMessagePreview,
    handleCommentSave,
    handleToggleTag,
    botTagAction,
    onCancelBotTagAction,
    onMarkBotTagWrong,
    handleArrowClick,
    handleVisibleMessageIds,
    commentMessageId,
    commentText,
    setCommentText,
    setCommentMessageId,
    setCommentFeedId,
    deleteConfirmId,
    deleteConfirmFeedId,
    profiles,
    senderOptions,
    freqs,
    postsList,
    groupsList,
    groupInfos,
    tagsMap,
    tagsOrder,
    savedFilters,
    selectedSavedIdByFeedId,
    setSelectedSavedIdByFeedId,
    saveFilterNameByFeedId,
    setSaveFilterNameByFeedId,
    reloadFreqsLoading,
    reloadLatestFrequencies,
    groupCatalogLoading,
    groupCatalogError,
    reloadGroupCatalog,
    networkDisplayMap,
    networkMap,
    unitsMap,
    callsignInfoMap,
    featureStrictNetworks,
    watchModeByFeedId,
    setWatchModeByFeedId,
    loadingNewerFeedIds,
    arrowResultByFeedId,
    copiedFeedbackId,
    setMessageFeeds,
    keywordSets,
    reloadKeywordSets,
    applyFilter,
  } = useRerDutyFeeds(authUserName, currentUser?.organismId ?? null);
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
  useEffect(() => {
    const liveIds = new Set(messageFeeds.map((feed) => feed.id));
    for (const feedId of Object.keys(feedStableActionsRef.current)) {
      if (liveIds.has(feedId)) continue;
      delete feedStableActionsRef.current[feedId];
      delete feedActionImplsRef.current[feedId];
    }
  }, [messageFeeds]);
  const [hasCompletedInitialLoad, setHasCompletedInitialLoad] = useState(false);
  const openCreateMessageComposer = useCallback(() => {
    setEditTarget(null);
    setCreateMessageOpen(true);
  }, []);
  const closeMessageEditor = useCallback(() => {
    setCreateMessageOpen(false);
    setEditTarget(null);
  }, []);
  const handleCreatedMessage = useCallback(() => {
    setCreateMessageOpen(false);
    reloadEmptyFeeds();
    notify({ message: 'Повідомлення успішно створено.', severity: 'success' });
  }, [notify, reloadEmptyFeeds]);

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
    if (messageFeeds.length === 0) {
      setActiveFeedId(null);
      previousFeedCountRef.current = 0;
      return;
    }
    setActiveFeedId((current) => {
      const currentExists = isPresent(current) && messageFeeds.some((feed) => feed.id === current);
      if (messageFeeds.length > previousFeedCountRef.current) {
        return messageFeeds[messageFeeds.length - 1].id;
      }
      if (currentExists) return current;
      return messageFeeds[0].id;
    });
    previousFeedCountRef.current = messageFeeds.length;
  }, [messageFeeds]);

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
  const anyFeedReloading = messageFeeds.some((feed) => feed.loading && feed.items.length > 0);
  const isInitialLoading = !hasCompletedInitialLoad && anyFeedInitialLoading;
  const showLoadingBackdrop = hasCompletedInitialLoad && anyFeedReloading;
  useEffect(() => startDutyNeoDocumentTitleTracking(), []);
  useEffect(() => {
    setDutyNeoDocumentTitleUnreadCount(dutyTabUnreadTotal);
  }, [dutyTabUnreadTotal]);

  return (
    <Box
      className="flex flex-col w-full min-h-0"
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
      <Box className="flex items-center justify-between flex-wrap gap-2 mb-2 shrink-0" />

      {error ? (
        <PowerAlert
          severity="error"
          className="mb-2 shrink-0"
          onClose={() => clearDutyError()}
          role="alert"
          autoHideDuration={10000}
        >
          {error}
        </PowerAlert>
      ) : null}

      <PointBlacklistPaletteNamesCacheProvider>
        <AudioTranscriptionPreferencesProvider
          collapsedByDefault={audioTranscriptionCollapsed}
          enabled={audioTranscriptionEnabled}
        >
          <RerDutyNeoWorkspace
            activeFeedId={activeFeedIdSafe}
            buildFeedColumnModel={buildFeedColumnModel}
            columnRefsRef={columnRefsRef}
            createMessageFeed={createMessageFeed}
            openCreateMessageComposer={openCreateMessageComposer}
            isInitialLoading={isInitialLoading}
            messageFeeds={messageFeeds}
            narrowScreen={narrowScreen}
            onSelectFeed={setActiveFeedId}
            showLoadingBackdrop={showLoadingBackdrop}
          />
        </AudioTranscriptionPreferencesProvider>
      </PointBlacklistPaletteNamesCacheProvider>

      <ManageMessageDrawer
        open={createMessageOpen || isPresent(editTarget)}
        cyberEchoEnabled={cyberEchoEnabled}
        currentUser={currentUser}
        editTarget={editTarget}
        onClose={closeMessageEditor}
        onSubmitEdit={async (messageId, message) => {
          handleEditedMessage(messageId, message);
        }}
        onEditSuccess={() => reloadEditedFeeds()}
        onCreated={handleCreatedMessage}
      />

      <CommentDialog
        open={isPresent(commentMessageId)}
        messagePreview={commentMessagePreview}
        commentText={commentText}
        onCommentTextChange={setCommentText}
        onClose={() => {
          setCommentMessageId(null);
          setCommentFeedId(null);
        }}
        onSave={handleCommentSave}
      />

      <DeleteConfirmDialog
        open={isPresent(deleteConfirmId)}
        onClose={() => {
          setDeleteConfirmId(null);
          setDeleteConfirmFeedId(null);
        }}
        onConfirm={handleDeleteConfirm}
      />
    </Box>
  );
}
