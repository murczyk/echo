import { Box, useMediaQuery, useTheme } from '@mui/material';
import { useEffect, useMemo, useRef, useState } from 'react';
import { isPresent } from '../../utils/misc';

import { CommentDialog, DeleteConfirmDialog } from './dialogs';
import {
  setDutyNeoDocumentTitleUnreadCount,
  startDutyNeoDocumentTitleTracking,
} from './notifications';
import {
  DEFAULT_DUTY_TAGS_LAYOUT,
  feedUnreadDisplayCount,
  feedsUnreadDisplayTotal,
  excludeMessageEntityFromFilters,
  type MessageEntityFilterKind,
  type MessageFeedState,
  type TagsLayoutVariant,
} from './utils';
import { useRerDutyFeeds } from './useRerDutyFeeds';
import { USER_SETTINGS_UPDATED_EVENT, fetchUserSettings } from '../../services/api/user-settings';
import { PowerAlert } from '../../components/PowerAlert';
import { RerDutyNeoWorkspace } from './RerDutyNeoWorkspace';

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
  const [activeFeedId, setActiveFeedId] = useState<string | null>(null);
  const previousFeedCountRef = useRef(0);
  const [tagsLayout, setTagsLayout] = useState<TagsLayoutVariant>(DEFAULT_DUTY_TAGS_LAYOUT);
  useEffect(() => {
    let cancelled = false;
    const loadLayout = async () => {
      try {
        const prefs = await fetchUserSettings();
        if (cancelled) return;
        setTagsLayout(prefs.tagsLayout);
      } catch {
        if (cancelled) return;
        setTagsLayout(DEFAULT_DUTY_TAGS_LAYOUT);
      }
    };
    loadLayout();
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    const onSettingsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ tagsLayout?: TagsLayoutVariant }>).detail;
      if (!detail?.tagsLayout) return;
      setTagsLayout(detail.tagsLayout);
    };

    window.addEventListener(USER_SETTINGS_UPDATED_EVENT, onSettingsUpdated as EventListener);
    return () => {
      window.removeEventListener(USER_SETTINGS_UPDATED_EVENT, onSettingsUpdated as EventListener);
    };
  }, []);
  const buildFeedColumnModel = (feed: MessageFeedState) => ({
    feed,
    view: {
      narrowScreen,
      feedCount: messageFeeds.length,
      canRemove: messageFeeds.length > 1,
      maxWidth: dutyFeedColumnMaxWidth(messageFeeds.length, narrowScreen),
      isWatchMode: !dutyDisableAutoScroll && (watchModeByFeedId[feed.id] ?? false),
      loadingNewer: loadingNewerFeedId === feed.id,
      arrowResultMessage: arrowResultByFeedId[feed.id] ?? null,
      unreadCount: feedUnreadDisplayCount(feed),
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
          loadFeedInitialMessages(feed.id, { onlyMyUnitTagsEnabled: v });
        },
        onReloadFreqs: reloadLatestFrequencies,
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
      copiedFeedbackId,
      networkDisplayMap,
      networkMap,
      unitsMap,
      callsignInfoMap,
      groupInfos,
      profiles,
      featureStrictNetworks,
      tagsLayout,
      tagsMap,
      tagsOrder,
      botTagAction,
      onCancelBotTagAction,
      onMarkBotTagWrong,
      onOpenPointsOnMap: handleOpenPointsOnMap,
      onOpenMapSearch: handleOpenMapSearch,
    },
    actions: {
      onLoadOlder: () => loadFeedOlderMessages(feed.id),
      onRemoveColumn: () => removeMessageFeed(feed.id),
      onMessageBookmark: (msgId, currentlyBookmarked) =>
        handleMessageBookmark(feed.id, msgId, currentlyBookmarked),
      onMessageImportant: (msgId, currentlyImportant) =>
        handleMessageImportant(feed.id, msgId, currentlyImportant),
      onMessageAddFrequencyToFilter: (_feedId, freq) => addFrequencyToFilter(feed.id, freq),
      onMessageCopy: handleMessageCopy,
      onMessageComment: (msgId, currentComment) =>
        openCommentDialog(msgId, feed.id, currentComment),
      onMessageExcludeEntity: (entity: MessageEntityFilterKind, value: string) =>
        applyFilter(feed.id, excludeMessageEntityFromFilters(feed.filter, entity, value)),
      onMessageToggleTag: (msgId, tagId) => handleToggleTag(feed.id, msgId, tagId),
      onScrollToTop: () => setWatchModeByFeedId((prev) => ({ ...prev, [feed.id]: false })),
      onReachedBottom: () => {
        if (!dutyDisableAutoScroll) {
          setWatchModeByFeedId((prev) => ({ ...prev, [feed.id]: true }));
        }
        if (feed.items.length > 0) {
          handleVisibleMessageIds(feed.id)(
            feed.items.map(([id]) => id),
            { atBottom: true },
          );
        }
      },
      onLeftBottom: () => setWatchModeByFeedId((prev) => ({ ...prev, [feed.id]: false })),
      onNearBottomChange: (near) => {
        nearBottomByFeedIdRef.current = {
          ...nearBottomByFeedIdRef.current,
          [feed.id]: near,
        };
      },
      onAtBottomChange: (atBottom) => {
        atBottomByFeedIdRef.current = {
          ...atBottomByFeedIdRef.current,
          [feed.id]: atBottom,
        };
      },
      onArrowClick: () => handleArrowClick(feed.id),
      onVisibleMessageIds: handleVisibleMessageIds(feed.id),
    },
  });
  const {
    messageFeeds,
    error,
    clearDutyError,
    columnRefsRef,
    nearBottomByFeedIdRef,
    atBottomByFeedIdRef,
    dutyDisableAutoScroll,
    createMessageFeed,
    removeMessageFeed,
    loadFeedInitialMessages,
    loadFeedOlderMessages,
    handleSaveFilter,
    handleApplySavedFilter,
    handleUpdateSelectedSavedFilter,
    handleRenameSelectedSavedFilter,
    handleDeleteSelectedSavedFilter,
    handleMessageBookmark,
    handleMessageImportant,
    handleOpenPointsOnMap,
    handleOpenMapSearch,
    addFrequencyToFilter,
    handleMessageCopy,
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
    networkDisplayMap,
    networkMap,
    unitsMap,
    callsignInfoMap,
    featureStrictNetworks,
    watchModeByFeedId,
    setWatchModeByFeedId,
    loadingNewerFeedId,
    arrowResultByFeedId,
    copiedFeedbackId,
    setMessageFeeds,
    keywordSets,
    reloadKeywordSets,
    applyFilter,
  } = useRerDutyFeeds(authUserName);
  const activeFeedIdSafe = messageFeeds.some((feed) => feed.id === activeFeedId)
    ? activeFeedId
    : (messageFeeds[0]?.id ?? null);
  const [hasCompletedInitialLoad, setHasCompletedInitialLoad] = useState(false);

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

  const dutyTabUnreadTotal = useMemo(() => feedsUnreadDisplayTotal(messageFeeds), [messageFeeds]);
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

      <RerDutyNeoWorkspace
        activeFeedId={activeFeedIdSafe}
        buildFeedColumnModel={buildFeedColumnModel}
        columnRefsRef={columnRefsRef}
        createMessageFeed={createMessageFeed}
        isInitialLoading={isInitialLoading}
        messageFeeds={messageFeeds}
        narrowScreen={narrowScreen}
        onRemoveActiveFeed={
          isPresent(activeFeedIdSafe) && messageFeeds.length > 1
            ? () => removeMessageFeed(activeFeedIdSafe)
            : undefined
        }
        onSelectFeed={setActiveFeedId}
        showLoadingBackdrop={showLoadingBackdrop}
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
