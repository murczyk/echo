import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { RerDutyQueryStateWf as RerDutyFeedFilterState } from '../../../../Bindings';
import { emptyFilter, filtersEqual, generateMessageFeedId } from './utils';
import type { MessageFeedState } from './utils';

const MAX_MESSAGE_FEEDS = 4;

export function useRerDutyFeedCrud(
  messageFeeds: MessageFeedState[],
  setMessageFeeds: Dispatch<SetStateAction<MessageFeedState[]>>,
  persistStateToUrl: (next: MessageFeedState[]) => void,
  markFeedReloadRequested: (feedId: string) => void,
  onFeedRemoved?: (feedId: string) => void,
) {
  const applyFilter = useCallback(
    (feedId: string, f: RerDutyFeedFilterState) => {
      const currentFeed = messageFeeds.find((feed) => feed.id === feedId);
      if (!currentFeed) return;
      if (filtersEqual(currentFeed.filter, f)) {
        persistStateToUrl(messageFeeds);
        return;
      }
      markFeedReloadRequested(feedId);
      setMessageFeeds((prev) => {
        const w = prev.find((feed) => feed.id === feedId);
        if (!w || filtersEqual(w.filter, f)) return prev;
        const next = prev.map((feed) =>
          feed.id === feedId
            ? {
                ...feed,
                filter: f,
                loading: true,
                loadingOlder: false,
                hasReachedStart: false,
                adjacentFreqsRange: feed.adjacentFreqsRange,
                highlightSignalsEnabled: feed.highlightSignalsEnabled,
                onlyMyUnitTagsEnabled: feed.onlyMyUnitTagsEnabled,
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

  const createMessageFeed = useCallback(() => {
    const id = generateMessageFeedId();
    const newFeed: MessageFeedState = {
      id,
      filter: emptyFilter(),
      items: [],
      loading: true,
      loadingOlder: false,
      hasReachedStart: false,
      referenceTimeMs: null,
      readIds: new Set<number>(),
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

  return { applyFilter, toggleGroup, selectAllGroups, createMessageFeed, removeMessageFeed };
}
