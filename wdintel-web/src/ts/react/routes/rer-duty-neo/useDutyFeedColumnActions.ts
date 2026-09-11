import { useEffect, useRef } from 'react';
import type { InboxMessage } from '../../../../Bindings';
import type { FeedColumnModel } from './types';
import type { useRerDutyFeeds } from './useRerDutyFeeds';
import {
  excludeMessageEntityFromFilters,
  feedIndicatorUnreadCount,
  type MessageFeedState,
} from './utils';

export type RerDutyFeedsBundle = ReturnType<typeof useRerDutyFeeds>;

export type DutyFeedColumnActionsDeps = {
  feeds: RerDutyFeedsBundle;
  openReportEditor: (reportId: number) => void;
  openMessageEditor: (target: { id: number; message: InboxMessage }) => void;
  openReportComposer: (source: { id: number; message: InboxMessage }) => void;
};

/**
 * Per-feed action identities must stay stable across renders so the memoized
 * FeedColumnContent can bail out when only *other* feeds change. Fresh arrow
 * props would defeat its comparator and re-render every column on any update.
 */
export function useDutyFeedColumnActions(
  deps: DutyFeedColumnActionsDeps,
): (feed: MessageFeedState) => FeedColumnModel['actions'] {
  const implsRef = useRef<Record<string, FeedColumnModel['actions']>>({});
  const stableRef = useRef<Record<string, FeedColumnModel['actions']>>({});
  const { messageFeeds } = deps.feeds;

  useEffect(() => {
    const liveIds = new Set(messageFeeds.map((feed) => feed.id));
    for (const feedId of Object.keys(stableRef.current)) {
      if (liveIds.has(feedId)) continue;
      delete stableRef.current[feedId];
      delete implsRef.current[feedId];
    }
  }, [messageFeeds]);

  return (feed: MessageFeedState): FeedColumnModel['actions'] => {
    const {
      loadFeedOlderMessages,
      loadFeedNewerMessages,
      flushPendingNewerMessages,
      removeMessageFeed,
      handleMessageBookmark,
      handleMessageImportant,
      handleMessageCopy,
      applyFilter,
      handleToggleTag,
      cancelFollowTail,
      ensureFollowTail,
      setWatchModeByFeedId,
      tailAvailabilityByFeedId,
      confirmedTailPreviewByFeedId,
      dutyDisableAutoScroll,
      nearBottomByFeedIdRef,
      atBottomByFeedIdRef,
      physicallyAtBottomByFeedIdRef,
      handleArrowClick,
      handleVisibleMessageIds,
    } = deps.feeds;
    const feedId = feed.id;
    // Refresh the latest closures (capturing current feed/state) every render.
    implsRef.current[feedId] = {
      onLoadOlder: () => loadFeedOlderMessages(feedId),
      onLoadNewer: () =>
        loadFeedNewerMessages(feedId, { skipIfNewestExhausted: true, showLoading: false }),
      onFlushPendingNewer: ({ physicallyAtBottom, visibleAnchorIds }) =>
        flushPendingNewerMessages(feedId, {
          urgent: true,
          allowWindowTrim: physicallyAtBottom,
          protectedItemIds: visibleAnchorIds,
        }),
      onRemoveColumn: () => removeMessageFeed(feedId),
      onMessageBookmark: (msgId, currentlyBookmarked) =>
        handleMessageBookmark(feedId, msgId, currentlyBookmarked),
      onMessageImportant: (msgId, currentlyImportant) =>
        handleMessageImportant(feedId, msgId, currentlyImportant),
      onMessageCopy: handleMessageCopy,
      onMessageCreateReport: (messageId, message) => {
        deps.openReportComposer({ id: messageId, message });
      },
      onMessageEditReport: (reportId) => {
        deps.openReportEditor(reportId);
      },
      onMessageExcludeEntity: (entity, value) =>
        applyFilter(feedId, excludeMessageEntityFromFilters(feed.filter, entity, value)),
      onMessageToggleTag: (msgId, tagId) => handleToggleTag(feedId, msgId, tagId),
      onMessageEdit: (messageId, message) => {
        deps.openMessageEditor({ id: messageId, message });
      },
      onScrollToTop: () => {
        cancelFollowTail(feedId);
        setWatchModeByFeedId((prev) => ({ ...prev, [feedId]: false }));
      },
      onReachedBottom: ({ hasSeenNotAtBottom }) => {
        if (dutyDisableAutoScroll) {
          cancelFollowTail(feedId);
          return false;
        }
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
          // Returning to the physical tail is an intentional user action. Resume the
          // ON-mode follow generation only after the buffered page is made visible.
          flushPendingNewerMessages(feedId, { urgent: true });
          const followGeneration = ensureFollowTail(feedId);
          setWatchModeByFeedId((prev) => ({ ...prev, [feedId]: true }));
          void loadFeedNewerMessages(feedId, {
            skipIfNewestExhausted: true,
            showLoading: false,
            scrollToEndAfterLoad: true,
            followGeneration,
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
    const existing = stableRef.current[feedId];
    if (existing) return existing;
    const latest = () => implsRef.current[feedId];
    const stable: FeedColumnModel['actions'] = {
      onLoadOlder: () => latest().onLoadOlder(),
      onLoadNewer: () => latest().onLoadNewer?.(),
      onFlushPendingNewer: (context) => latest().onFlushPendingNewer?.(context),
      onRemoveColumn: () => latest().onRemoveColumn(),
      onMessageBookmark: (msgId, currentlyBookmarked) =>
        latest().onMessageBookmark(msgId, currentlyBookmarked),
      onMessageImportant: (msgId, currentlyImportant) =>
        latest().onMessageImportant(msgId, currentlyImportant),
      onMessageCopy: (text, feedbackId) => latest().onMessageCopy(text, feedbackId),
      onMessageCreateReport: (msgId, message) => latest().onMessageCreateReport(msgId, message),
      onMessageEditReport: (reportId) => latest().onMessageEditReport(reportId),
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
    stableRef.current[feedId] = stable;
    return stable;
  };
}
