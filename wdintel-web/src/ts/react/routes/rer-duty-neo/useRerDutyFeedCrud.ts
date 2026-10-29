import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { RerDutyQueryStateWf as RerDutyFeedFilterState } from '../../../../Bindings';
import { emptyFilter, filtersEqual, generateMessageFeedId, MAX_MESSAGE_FEEDS } from './utils';
import type { MessageFeedState } from './utils';

export function useRerDutyFeedCrud(
  messageFeeds: MessageFeedState[],
  setMessageFeeds: Dispatch<SetStateAction<MessageFeedState[]>>,
  persistStateToUrl: (next: MessageFeedState[]) => void,
  markFeedReloadRequested: (feedId: string, preserveUnread?: boolean) => void,
  onFeedRemoved?: (feedId: string) => void,
) {
  const applyFilter = useCallback(
    (
      feedId: string,
      f: RerDutyFeedFilterState,
      forceReload = false,
      options: { preserveUnread?: boolean } = {},
    ) => {
      const currentFeed = messageFeeds.find((feed) => feed.id === feedId);
      if (!currentFeed) return;
      if (!forceReload && filtersEqual(currentFeed.filter, f)) {
        persistStateToUrl(messageFeeds);
        return;
      }
      const preserveUnread = options.preserveUnread && filtersEqual(currentFeed.filter, f);
      markFeedReloadRequested(feedId, preserveUnread);
      setMessageFeeds((prev) => {
        const w = prev.find((feed) => feed.id === feedId);
        if (!w || (!forceReload && filtersEqual(w.filter, f))) return prev;
        const filterChanged = !filtersEqual(w.filter, f);
        const next = prev.map((feed) =>
          feed.id === feedId
            ? {
                ...feed,
                ...(filterChanged
                  ? {
                      items: [],
                      readIds: new Set<number>(),
                      unreadCount: 0,
                      unresolvedUnreadIds: new Set<number>(),
                      unresolvedUnreadCount: 0,
                      evictedNewerTailId: null,
                      historicalReadThrough: null,
                    }
                  : {}),
                filter: f,
                loading: true,
                loadingOlder: false,
                hasReachedStart: false,
                windowedUnreadItems: preserveUnread
                  ? feed.windowedUnreadItems
                  : new Map<number, number>(),
                adjacentFreqsRange: feed.adjacentFreqsRange,
                highlightSignalsEnabled: feed.highlightSignalsEnabled,
                onlyMyUnitTagsEnabled: feed.onlyMyUnitTagsEnabled,
                pendingNewerItems: preserveUnread ? feed.pendingNewerItems : [],
              }
            : feed,
        );
        persistStateToUrl(next);
        return next;
      });
    },
    [markFeedReloadRequested, messageFeeds, persistStateToUrl, setMessageFeeds],
  );

  const toggleGroup = useCallback(
    (feedId: string, key: string) => {
      const w = messageFeeds.find((x) => x.id === feedId);
      if (!w) return;
      const current = w.filter.groupsSelected ?? [];
      const next = current.includes(key) ? current.filter((x) => x !== key) : [...current, key];
      const f = { ...w.filter, groupsSelected: next.length ? next : null };
      applyFilter(feedId, f);
    },
    [messageFeeds, applyFilter],
  );

  const selectAllGroups = useCallback(
    (feedId: string) => {
      const w = messageFeeds.find((x) => x.id === feedId);
      if (!w) return;
      const f = { ...w.filter, groupsSelected: null };
      applyFilter(feedId, f);
    },
    [messageFeeds, applyFilter],
  );

  const setGroupScope = useCallback(
    (feedId: string, groupMasterKey: string | null) => {
      const feed = messageFeeds.find((candidate) => candidate.id === feedId);
      if (!feed) return;
      applyFilter(feedId, {
        ...feed.filter,
        groupsSelected: groupMasterKey ? [groupMasterKey] : null,
        groupsDenied: null,
      });
    },
    [applyFilter, messageFeeds],
  );

  const createMessageFeed = useCallback(() => {
    const id = generateMessageFeedId();
    const newFeed: MessageFeedState = {
      id,
      filter: emptyFilter(),
      groupScopeMasterKey: null,
      items: [],
      loading: true,
      loadingOlder: false,
      hasReachedStart: false,
      referenceTimeMs: null,
      readIds: new Set<number>(),
      windowedUnreadItems: new Map<number, number>(),
      unreadCount: 0,
      adjacentFreqsRange: 0,
      highlightSignalsEnabled: false,
      onlyMyUnitTagsEnabled: false,
    };
    setMessageFeeds((prev) => {
      if (prev.length >= MAX_MESSAGE_FEEDS || prev.some((w) => w.id === id)) return prev;
      const next = [...prev, newFeed];
      persistStateToUrl(next);
      return next;
    });
  }, [persistStateToUrl, setMessageFeeds]);

  const removeMessageFeed = useCallback(
    (feedId: string) => {
      if (messageFeeds.length <= 1) return;
      if (!messageFeeds.some((w) => w.id === feedId)) return;
      setMessageFeeds((prev) => {
        const next = prev.filter((w) => w.id !== feedId);
        persistStateToUrl(next);
        return next;
      });
      onFeedRemoved?.(feedId);
    },
    [messageFeeds, onFeedRemoved, setMessageFeeds, persistStateToUrl],
  );

  return {
    applyFilter,
    toggleGroup,
    selectAllGroups,
    setGroupScope,
    createMessageFeed,
    removeMessageFeed,
  };
}
