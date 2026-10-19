import { useCallback, useState } from 'react';
import type { GroupFeedState, InboxMessage } from '../../../../Bindings';
import type { MessageFeedState } from './utils';

type UnreadBoundary = {
  key: string;
  groups: readonly GroupFeedState[] | null;
  messageId: number | null;
  dismissed?: boolean;
};

function isPersistedUnread(id: number, message: InboxMessage, group: GroupFeedState): boolean {
  if (
    group.oldestUnreadMessageRef != null &&
    (group.oldestUnreadMessageRef === message.messageUuid ||
      group.oldestUnreadMessageRef === message.messageUid)
  )
    return true;
  const memberships =
    message.groupMasterKeys ?? (message.groupMasterKey ? [message.groupMasterKey] : []);
  if (
    !memberships.includes(group.masterKey) ||
    group.lastReadCreatedAtOrder === undefined ||
    group.lastReadMessageId === undefined
  )
    return false;
  const order =
    message.createdAtOrder ?? (message.createdAt == null ? null : message.createdAt * 1000);
  if (order == null) return false;
  if (group.lastReadCreatedAtOrder === null) return true;
  return (
    order > group.lastReadCreatedAtOrder ||
    (order === group.lastReadCreatedAtOrder &&
      group.lastReadMessageId != null &&
      id > group.lastReadMessageId)
  );
}

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
  const boundary = previous?.key === key ? previous : { key, groups: null, messageId: null };
  if (feed.loading || boundary.dismissed) return boundary;
  const unreadGroups =
    boundary.groups ??
    (ready
      ? groups.filter(
          (group) =>
            !group.ignoreOperativny &&
            (!feed.groupScopeMasterKey || group.masterKey === feed.groupScopeMasterKey) &&
            group.unreadCount > 0,
        )
      : null);
  const messageId =
    boundary.messageId ??
    feed.items.find(
      ([id, message]) =>
        (feed.unreadCount > 0 && !feed.readIds.has(id)) ||
        unreadGroups?.some((group) => isPersistedUnread(id, message, group)),
    )?.[0] ??
    null;
  return unreadGroups === boundary.groups && messageId === boundary.messageId
    ? boundary
    : { key, groups: unreadGroups, messageId };
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
