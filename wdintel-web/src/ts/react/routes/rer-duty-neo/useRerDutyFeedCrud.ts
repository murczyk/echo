import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { RerDutyQueryStateWf as RerDutyFeedFilterState } from '../../../../Bindings';
import {
  emptyFilter,
  filtersEqual,
  generateMessageFeedId,
  VIRTUOSO_FIRST_ITEM_INDEX_INITIAL,
} from './utils';
import type { MessageFeedState } from './utils';

const MAX_MESSAGE_FEEDS = 4;

export function useRerDutyFeedCrud(
  messageFeeds: MessageFeedState[],
  setMessageFeeds: Dispatch<SetStateAction<MessageFeedState[]>>,
  onFeedRemoved?: (feedId: string) => void,
  persistStateToUrl: (next: MessageFeedState[]) => void,
) {
  const applyFilter = useCallback((feedId: string, f: RerDutyFeedFilterState) => {
      let nextState: MessageFeedState[] | null = null;
      setMessageFeeds((prev) => {
      const w = prev.find((w) => w.id === feedId);
      if (!w) return prev;
      if (filtersEqual(w.filter, f)) {
        nextState = prev;
        return prev;
      }
      const next = prev.map((w) =>
        w.id === feedId
          ? {
              ...w,
              filter: f,
              items: [],
              loading: true,
              hasReachedStart: false,
              firstItemIndex: VIRTUOSO_FIRST_ITEM_INDEX_INITIAL,
              referenceTimeMs: null,
              readIds: new Set<number>(),
              unreadCount: 0,
              adjacentFreqsRange: w.adjacentFreqsRange,
              highlightSignalsEnabled: w.highlightSignalsEnabled,
              onlyMyUnitTagsEnabled: w.onlyMyUnitTagsEnabled,
            }
          : w,
      );
      nextState = next;
      return next;
    });
    if (nextState) requestPersist(nextState);
  }, [requestPersist, setMessageFeeds]);

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
      firstItemIndex: VIRTUOSO_FIRST_ITEM_INDEX_INITIAL,
      referenceTimeMs: null,
      readIds: new Set<number>(),
      unreadCount: 0,
      adjacentFreqsRange: 0,
      highlightSignalsEnabled: false,
      onlyMyUnitTagsEnabled: false,
    };
    if (messageFeeds.length >= MAX_MESSAGE_FEEDS || messageFeeds.some((w) => w.id === id)) return;
    const next = [...messageFeeds, newFeed];
    setMessageFeeds(next);
    requestPersist(next);
  }, [messageFeeds, requestPersist, setMessageFeeds]);

  const removeMessageFeed = useCallback(
    (feedId: string) => {
      if (messageFeeds.length <= 1) return;
      if (!messageFeeds.some((w) => w.id === feedId)) return;
      let nextState: MessageFeedState[] | null = null;
      setMessageFeeds((prev) => {
        const next = prev.filter((w) => w.id !== feedId);
        nextState = next;
        return next;
      });
      onFeedRemoved?.(feedId);
      if (nextState) requestPersist(nextState);
    },
    [messageFeeds, onFeedRemoved, setMessageFeeds, persistStateToUrl],
  );

  return { applyFilter, toggleGroup, selectAllGroups, createMessageFeed, removeMessageFeed };
}
