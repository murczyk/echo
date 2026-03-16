import React from 'react';

import type { RerDutyQueryStateWf as RerDutyFeedFilterState } from '../../../../Bindings';
import {
  emptyFilter,
  filtersEqual,
  generateMessageFeedId,
  pushStateToUrl,
  toQueryState,
  VIRTUOSO_FIRST_ITEM_INDEX_INITIAL,
} from './utils';
import type { MessageFeedState } from './utils';

const MAX_MESSAGE_FEEDS = 4;

export function useRerDutyFeedCrud(
  messageFeeds: MessageFeedState[],
  setMessageFeeds: React.Dispatch<React.SetStateAction<MessageFeedState[]>>,
) {
  const applyFilter = React.useCallback((feedId: string, f: RerDutyFeedFilterState) => {
    setMessageFeeds((prev) => {
      const w = prev.find((w) => w.id === feedId);
      if (!w || filtersEqual(w.filter, f)) return prev;
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
      pushStateToUrl(toQueryState(next));
      return next;
    });
  }, []);

  const toggleGroup = React.useCallback(
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

  const selectAllGroups = React.useCallback(
    (feedId: string) => {
      const w = messageFeeds.find((x) => x.id === feedId);
      if (!w) return;
      const f = { ...w.filter, groupsSelected: null };
      applyFilter(feedId, f);
    },
    [messageFeeds, applyFilter],
  );

  const createMessageFeed = React.useCallback(() => {
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
    setMessageFeeds((prev) => {
      if (prev.length >= MAX_MESSAGE_FEEDS || prev.some((w) => w.id === id)) return prev;
      const next = [...prev, newFeed];
      pushStateToUrl(toQueryState(next));
      return next;
    });
  }, []);

  const removeMessageFeed = React.useCallback(
    (feedId: string) => {
      if (messageFeeds.length <= 1) return;
      setMessageFeeds((prev) => {
        const next = prev.filter((w) => w.id !== feedId);
        pushStateToUrl(toQueryState(next));
        return next;
      });
    },
    [messageFeeds.length],
  );

  return { applyFilter, toggleGroup, selectAllGroups, createMessageFeed, removeMessageFeed };
}
