import { useCallback } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import { compareMessageTuple, type MessageFeedState } from './utils';
import { getDutyFollowScrollBehavior } from './duty-follow-scroll';

type Params = {
  messageFeeds: MessageFeedState[];
  showArrowResult: (feedId: string, message: string) => void;
  columnRefsRef: MutableRefObject<
    Record<
      string,
      {
        scrollToEnd: (behavior?: ScrollBehavior, options?: { wakeIdleOffload?: boolean }) => void;
      } | null
    >
  >;
  setWatchModeByFeedId: Dispatch<SetStateAction<Record<string, boolean>>>;
  setLoadingNewerFeedIds: Dispatch<SetStateAction<Set<string>>>;
  loadFeedInitialMessages: (feedId: string) => Promise<void>;
  loadFeedNewerMessages: (
    feedId: string,
    opts?: {
      nolimit?: boolean;
      scrollToEndAfterLoad?: boolean;
      markAllReadAfterAppend?: boolean;
      showLoading?: boolean;
      followGeneration?: number;
    },
  ) => Promise<{ ok: boolean; addedCount: number }>;
  flushPendingNewerMessages: (
    feedId: string,
    opts?: { markAllRead?: boolean; urgent?: boolean },
  ) => void;
  requestValidatedInboxCount: (feedId: string) => Promise<{
    feedId: string;
    quantity: number;
    cursorId: number | null;
    hasItems: boolean;
  } | null>;
  catchUpFeedUnreadToTail: (feedId: string) => void;
  dutyDisableAutoScroll: boolean;
  setMessageFeeds: Dispatch<SetStateAction<MessageFeedState[]>>;
  beginFollowTail?: (feedId: string) => number;
};

export function useRerDutyFeedInteractionActions(params: Params) {
  const {
    messageFeeds,
    showArrowResult,
    columnRefsRef,
    setWatchModeByFeedId,
    setLoadingNewerFeedIds,
    loadFeedInitialMessages,
    loadFeedNewerMessages,
    flushPendingNewerMessages,
    requestValidatedInboxCount,
    catchUpFeedUnreadToTail,
    dutyDisableAutoScroll,
    setMessageFeeds,
    beginFollowTail,
  } = params;

  const busyArrowMessage = 'Оновлення триває, спробуйте ще раз';
  const failureArrowMessage = 'Не вдалося перевірити нові повідомлення';

  const handleArrowClick = useCallback(
    async (feedId: string) => {
      const feed = messageFeeds.find((x) => x.id === feedId);
      if (!feed) return;
      const followGeneration = beginFollowTail?.(feedId) ?? -1;
      flushPendingNewerMessages(feedId, { urgent: true });
      if (feed.items.length > 0) {
        columnRefsRef.current[feedId]?.scrollToEnd(getDutyFollowScrollBehavior(), {
          wakeIdleOffload: true,
        });
      }
      if (!dutyDisableAutoScroll) {
        setWatchModeByFeedId((prev) => ({ ...prev, [feedId]: true }));
      }
      setLoadingNewerFeedIds((prev) => new Set(prev).add(feedId));
      try {
        if (feed.items.length > 0) {
          const result = await requestValidatedInboxCount(feedId);
          if (!result) {
            showArrowResult(feedId, busyArrowMessage);
            return;
          }
          const { quantity } = result;
          if (quantity === 0) {
            catchUpFeedUnreadToTail(feedId);
            showArrowResult(feedId, 'Немає нових повідомлень');
            return;
          }
          setLoadingNewerFeedIds((prev) => {
            const next = new Set(prev);
            next.add(feedId);
            return next;
          });
          const newerResult = await loadFeedNewerMessages(feedId, {
            nolimit: true,
            scrollToEndAfterLoad: true,
            showLoading: true,
            followGeneration,
          });
          if (!newerResult.ok) {
            showArrowResult(feedId, failureArrowMessage);
            return;
          }
          catchUpFeedUnreadToTail(feedId);
          showArrowResult(feedId, 'Завантажено нові повідомлення');
        } else if (!feed.loading) {
          await loadFeedInitialMessages(feedId);
          catchUpFeedUnreadToTail(feedId);
          showArrowResult(feedId, 'Завантажено нові повідомлення');
        }
      } catch {
        showArrowResult(feedId, failureArrowMessage);
      } finally {
        setLoadingNewerFeedIds((prev) => {
          if (!prev.has(feedId)) return prev;
          const next = new Set(prev);
          next.delete(feedId);
          return next;
        });
      }
    },
    [
      messageFeeds,
      loadFeedNewerMessages,
      loadFeedInitialMessages,
      flushPendingNewerMessages,
      showArrowResult,
      columnRefsRef,
      setWatchModeByFeedId,
      setLoadingNewerFeedIds,
      catchUpFeedUnreadToTail,
      requestValidatedInboxCount,
      dutyDisableAutoScroll,
      beginFollowTail,
    ],
  );

  const handleVisibleMessageIds = useCallback(
    (feedId: string) => (lastVisibleId: number, opts?: { atBottom?: boolean }) => {
      setMessageFeeds((prev) => {
        let changed = false;
        const next = prev.map((f) => {
          if (f.id !== feedId) return f;

          const newlyReadIds: number[] = [];
          let lastVisibleTimestamp: number | null | undefined;
          for (const [id, message] of f.items) {
            if (!f.readIds.has(id)) {
              newlyReadIds.push(id);
            }
            if (id === lastVisibleId) {
              lastVisibleTimestamp = message.timestamp;
              break;
            }
          }

          let windowedUnreadItems = f.windowedUnreadItems ?? new Map<number, number>();
          let clearedWindowedCount = 0;
          if (opts?.atBottom === true && windowedUnreadItems.size > 0) {
            const boundary = { id: lastVisibleId, timestamp: lastVisibleTimestamp ?? null };
            const nextWindowed = new Map<number, number>();
            for (const [id, timestamp] of windowedUnreadItems) {
              if (compareMessageTuple({ id, timestamp }, boundary) <= 0) {
                clearedWindowedCount += 1;
              } else {
                nextWindowed.set(id, timestamp);
              }
            }
            if (clearedWindowedCount > 0) {
              windowedUnreadItems = nextWindowed;
            }
          } else if (newlyReadIds.length > 0) {
            windowedUnreadItems = new Map(windowedUnreadItems);
            newlyReadIds.forEach((id) => windowedUnreadItems.delete(id));
          }

          if (newlyReadIds.length === 0 && clearedWindowedCount === 0) return f;

          changed = true;
          const nextReadIds = new Set(f.readIds);
          newlyReadIds.forEach((id) => nextReadIds.add(id));
          return {
            ...f,
            readIds: nextReadIds,
            windowedUnreadItems,
            unreadCount: Math.max(0, f.unreadCount - newlyReadIds.length - clearedWindowedCount),
          };
        });
        return changed ? next : prev;
      });
    },
    [setMessageFeeds],
  );

  return {
    handleArrowClick,
    handleVisibleMessageIds,
  };
}
