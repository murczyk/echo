import { useCallback, useState } from 'react';
import type { MessageFeedState } from './utils';

type UnreadBoundary = {
  key: string;
  messageId: number | null;
  dismissed?: boolean;
};

function resolveUnreadBoundary(feed: MessageFeedState, previous?: UnreadBoundary): UnreadBoundary {
  const key = JSON.stringify([
    feed.id,
    feed.groupScopeMasterKey,
    feed.filter,
    feed.referenceTimeMs,
    feed.adjacentFreqsRange,
    feed.highlightSignalsEnabled,
    feed.onlyMyUnitTagsEnabled,
  ]);
  const boundary = previous?.key === key ? previous : { key, messageId: null };
  if (feed.loading || boundary.dismissed) return boundary;
  const messageId =
    boundary.messageId ??
    feed.items.find(
      ([id, message]) => message.isOwn !== true && feed.unreadCount > 0 && !feed.readIds.has(id),
    )?.[0] ??
    null;
  return messageId === boundary.messageId ? boundary : { ...boundary, messageId };
}

export function useDutyUnreadBoundaries(feeds: readonly MessageFeedState[]) {
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
    const boundary = resolveUnreadBoundary(feed, previous);
    next.set(feed.id, boundary);
    changed ||= boundary !== previous;
  }
  if (changed) setBoundaries(next);
  return { boundaries: changed ? next : boundaries, dismissUnreadBoundary };
}
