import { useCallback } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { MessageFeedState } from './utils';

type Params = {
  messageFeeds: MessageFeedState[];
  showArrowResult: (feedId: string, message: string) => void;
  columnRefsRef: MutableRefObject<
    Record<string, { scrollToEnd: (behavior?: ScrollBehavior) => void } | null>
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
  ) => Promise<void>;
  requestValidatedInboxCount: (feedId: string) => Promise<{
    feedId: string;
    quantity: number;
    cursorId: number | null;
    hasItems: boolean;
  } | null>;
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
    requestValidatedInboxCount,
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
      if (feed.items.length > 0) {
        const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        columnRefsRef.current[feedId]?.scrollToEnd(reducedMotion ? 'auto' : 'smooth');
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
            showArrowResult(feedId, 'Немає нових повідомлень');
            return;
          }
          setMessageFeeds((prev) =>
            prev.map((f) =>
              f.id === feedId ? { ...f, unreadCount: Math.max(f.unreadCount, quantity) } : f,
            ),
          );
          setLoadingNewerFeedIds((prev) => {
            const next = new Set(prev);
            next.add(feedId);
            return next;
          });
          await loadFeedNewerMessages(feedId, {
            nolimit: true,
            scrollToEndAfterLoad: true,
            showLoading: true,
            followGeneration,
          });
          showArrowResult(feedId, 'Завантажено нові повідомлення');
        } else if (!feed.loading) {
          await loadFeedInitialMessages(feedId);
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
      showArrowResult,
      columnRefsRef,
      setWatchModeByFeedId,
      setLoadingNewerFeedIds,
      setMessageFeeds,
      requestValidatedInboxCount,
      dutyDisableAutoScroll,
    ],
  );

  const handleVisibleMessageIds = useCallback(
    (feedId: string) => (lastVisibleId: number, opts?: { atBottom?: boolean }) => {
      setMessageFeeds((prev) => {
        let changed = false;
        const next = prev.map((f) => {
          if (f.id !== feedId) return f;

          const newlyReadIds: number[] = [];
          for (const [id] of f.items) {
            if (!f.readIds.has(id)) {
              newlyReadIds.push(id);
            }
            if (id === lastVisibleId) {
              break;
            }
          }

          if (newlyReadIds.length === 0) return f;

          changed = true;
          const nextReadIds = new Set(f.readIds);
          newlyReadIds.forEach((id) => nextReadIds.add(id));
          const windowedUnreadIds = new Set(f.windowedUnreadIds ?? []);
          newlyReadIds.forEach((id) => windowedUnreadIds.delete(id));
          return {
            ...f,
            readIds: nextReadIds,
            windowedUnreadIds,
            unreadCount: Math.max(0, f.unreadCount - newlyReadIds.length),
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
