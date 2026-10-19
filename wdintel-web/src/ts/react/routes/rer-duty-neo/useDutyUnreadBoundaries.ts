import { useCallback, useState } from 'react';
import type { GroupFeedState } from '../../../../Bindings';
import type { MessageFeedState } from './utils';
import {
  resolveGroupUnreadBoundary,
  type GroupUnreadBoundary as UnreadBoundary,
} from '../shared/group-navigation/group-unread-boundary';

function resolveUnreadBoundary(
  feed: MessageFeedState,
  groups: readonly GroupFeedState[],
  ready: boolean,
  previous?: UnreadBoundary,
): UnreadBoundary {
  const key = JSON.stringify([
    feed.id,
    feed.groupScopeMasterKey,
    feed.filter,
    feed.referenceTimeMs,
    feed.adjacentFreqsRange,
    feed.highlightSignalsEnabled,
    feed.onlyMyUnitTagsEnabled,
  ]);
  return resolveGroupUnreadBoundary(
    {
      key,
      loading: feed.loading,
      ready,
      messages: feed.items,
      groups: groups.filter(
        (group) =>
          !group.ignoreOperativny &&
          (!feed.groupScopeMasterKey || group.masterKey === feed.groupScopeMasterKey),
      ),
      isLocallyUnread: (id) => feed.unreadCount > 0 && !feed.readIds.has(id),
    },
    previous,
  );
}

export function useDutyUnreadBoundaries(
  feeds: readonly MessageFeedState[],
  groups: readonly GroupFeedState[],
  ready: boolean,
) {
  const [boundaries, setBoundaries] = useState(new Map<string, UnreadBoundary>());
  const dismissUnreadBoundary = useCallback((feedId: string) => {
    setBoundaries((current) => {
      const boundary = current.get(feedId);
      if (!boundary || boundary.dismissed) return current;
      return new Map(current).set(feedId, { ...boundary, messageId: null, dismissed: true });
    });
  }, []);
  const next = new Map<string, UnreadBoundary>();
  let changed = boundaries.size !== feeds.length;
  for (const feed of feeds) {
    const previous = boundaries.get(feed.id);
    const boundary = resolveUnreadBoundary(feed, groups, ready, previous);
    next.set(feed.id, boundary);
    changed ||= boundary !== previous;
  }
  if (changed) setBoundaries(next);
  return { boundaries: changed ? next : boundaries, dismissUnreadBoundary };
}
