import { useCallback } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import { fetchInboxCount } from '../../services/api/inbox';
import { buildInboxReq } from './utils';
import type { MessageFeedState } from './utils';

type Params = {
  messageFeeds: MessageFeedState[];
  buildReqForFeed: (
    feed: MessageFeedState,
    opts: Omit<
      Parameters<typeof buildInboxReq>[0],
      | 'filter'
      | 'expandedFreqsSelected'
      | 'expandedFreqsDenied'
      | 'highlightSignals'
      | 'reportTagsOnlyThisUnit'
    >,
  ) => ReturnType<typeof buildInboxReq>;
  columnRefsRef: MutableRefObject<Record<string, { scrollToEnd: () => void } | null>>;
  showArrowResult: (feedId: string, message: string) => void;
  setWatchModeByFeedId: Dispatch<SetStateAction<Record<string, boolean>>>;
  setLoadingNewerFeedId: Dispatch<SetStateAction<string | null>>;
  loadFeedInitialMessages: (feedId: string) => Promise<void>;
  loadFeedNewerMessages: (
    feedId: string,
    opts?: { nolimit?: boolean; scrollToEndAfterLoad?: boolean; markAllReadAfterAppend?: boolean },
  ) => Promise<void>;
  dutyDisableAutoScroll: boolean;
  setMessageFeeds: Dispatch<SetStateAction<MessageFeedState[]>>;
};

export function useRerDutyFeedInteractionActions(params: Params) {
  const {
    messageFeeds,
    buildReqForFeed,
    columnRefsRef,
    showArrowResult,
    setWatchModeByFeedId,
    setLoadingNewerFeedId,
    loadFeedInitialMessages,
    loadFeedNewerMessages,
    dutyDisableAutoScroll,
    setMessageFeeds,
  } = params;

  const handleArrowClick = useCallback(
    async (feedId: string) => {
      const feed = messageFeeds.find((x) => x.id === feedId);
      if (!feed) return;
      if (!dutyDisableAutoScroll) {
        setWatchModeByFeedId((prev) => ({ ...prev, [feedId]: true }));
      }
      const refs = columnRefsRef.current;
      const scrollToEnd = () => {
        requestAnimationFrame(() => requestAnimationFrame(() => refs[feedId]?.scrollToEnd()));
      };
      scrollToEnd();
      setLoadingNewerFeedId(feedId);
      try {
        if (feed.items.length > 0) {
          const lastItem = feed.items[feed.items.length - 1];
          const { quantity } = await fetchInboxCount(
            buildReqForFeed(feed, { sinceIdNoninclusive: lastItem[0], nolimit: true }),
          );
          if (quantity === 0) {
            showArrowResult(feedId, 'Немає нових повідомлень');
            return;
          }
          setMessageFeeds((prev) =>
            prev.map((f) =>
              f.id === feedId ? { ...f, unreadCount: Math.max(f.unreadCount, quantity) } : f,
            ),
          );
          await loadFeedNewerMessages(feedId, {
            nolimit: true,
            scrollToEndAfterLoad: true,
          });
        } else if (!feed.loading) {
          await loadFeedInitialMessages(feedId);
        }
        showArrowResult(feedId, 'Завантажено нові повідомлення');
      } catch {
        showArrowResult(feedId, 'Немає нових повідомлень');
      } finally {
        setLoadingNewerFeedId((prev) => (prev === feedId ? null : prev));
      }
    },
    [
      messageFeeds,
      loadFeedNewerMessages,
      loadFeedInitialMessages,
      buildReqForFeed,
      showArrowResult,
      columnRefsRef,
      setWatchModeByFeedId,
      setLoadingNewerFeedId,
      setMessageFeeds,
      dutyDisableAutoScroll,
    ],
  );

  const handleVisibleMessageIds = useCallback(
    (feedId: string) => (ids: number[], opts?: { atBottom?: boolean }) => {
      if (ids.length === 0) return;
      setMessageFeeds((prev) =>
        prev.map((f) => {
          if (f.id !== feedId) return f;
          const newlyReadIds = ids.filter((id) => !f.readIds.has(id));
          if (newlyReadIds.length === 0 && !opts?.atBottom) return f;
          const nextReadIds = new Set([...f.readIds, ...newlyReadIds]);
          return {
            ...f,
            readIds: nextReadIds,
            unreadCount: opts?.atBottom ? 0 : Math.max(0, f.unreadCount - newlyReadIds.length),
          };
        }),
      );
    },
    [setMessageFeeds],
  );

  return {
    handleArrowClick,
    handleVisibleMessageIds,
  };
}
