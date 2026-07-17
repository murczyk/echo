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
    opts?: { nolimit?: boolean; scrollToEndAfterLoad?: boolean; markAllReadAfterAppend?: boolean },
  ) => Promise<void>;
  requestValidatedInboxCount: (feedId: string) => Promise<{
    feedId: string;
    quantity: number;
    cursorId: number | null;
    hasItems: boolean;
  } | null>;
  dutyDisableAutoScroll: boolean;
  setMessageFeeds: Dispatch<SetStateAction<MessageFeedState[]>>;
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
  } = params;

  const busyArrowMessage = 'Оновлення триває, спробуйте ще раз';
  const failureArrowMessage = 'Не вдалося перевірити нові повідомлення';

  const handleArrowClick = useCallback(
    async (feedId: string) => {
      const feed = messageFeeds.find((x) => x.id === feedId);
      if (!feed) return;
      if (!dutyDisableAutoScroll) {
        setWatchModeByFeedId((prev) => ({ ...prev, [feedId]: true }));
      }
      try {
        if (feed.items.length > 0) {
          const result = await requestValidatedInboxCount(feedId);
          if (!result) {
            columnRefsRef.current[feedId]?.scrollToEnd('auto');
            showArrowResult(feedId, busyArrowMessage);
            return;
          }
          const { quantity } = result;
          if (quantity === 0) {
            columnRefsRef.current[feedId]?.scrollToEnd('auto');
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
          });
          showArrowResult(feedId, 'Завантажено нові повідомлення');
        } else if (!feed.loading) {
          await loadFeedInitialMessages(feedId);
          showArrowResult(feedId, 'Завантажено нові повідомлення');
        }
      } catch {
        columnRefsRef.current[feedId]?.scrollToEnd('auto');
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
          const isAtBottom = opts?.atBottom ?? false;

          const newlyReadIds: number[] = [];
          for (const [id] of f.items) {
            if (!f.readIds.has(id)) {
              newlyReadIds.push(id);
            }
            if (id === lastVisibleId) {
              break;
            }
          }

          if (newlyReadIds.length === 0 && !isAtBottom) return f;
          if (newlyReadIds.length === 0 && isAtBottom && f.unreadCount === 0) return f;

          changed = true;
          const nextReadIds = new Set(f.readIds);
          newlyReadIds.forEach((id) => nextReadIds.add(id));
          return {
            ...f,
            readIds: nextReadIds,
            unreadCount: isAtBottom ? 0 : Math.max(0, f.unreadCount - newlyReadIds.length),
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
