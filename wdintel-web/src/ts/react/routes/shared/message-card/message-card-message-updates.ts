import type { InboxMessage } from '../../../../../Bindings';

export type MessageItem = [number, InboxMessage];

export type MessageFeedWithItems = {
  items: MessageItem[];
};

export function mergeUpdatedDutyFeedMessages<T extends MessageFeedWithItems & { id: string }>(
  currentFeeds: T[],
  feedId: string,
  requestedMessageIds: number[],
  updates: MessageItem[],
): T[] {
  if (currentFeeds.length === 0 || requestedMessageIds.length === 0) return currentFeeds;

  const requestedIds = new Set(requestedMessageIds);
  const updatesById = new Map<number, InboxMessage>(updates);
  let changed = false;
  const nextFeeds = currentFeeds.map((feed) => {
    if (feed.id !== feedId) return feed;
    const feedRuntime = feed as T & { readIds?: Set<number>; unreadCount?: number };
    const removedMessageIds = new Set<number>();
    const originalReadIds = feedRuntime.readIds instanceof Set ? feedRuntime.readIds : null;
    let feedChanged = false;
    const nextItems = feedRuntime.items
      .map(([messageId, message]) => {
        if (!requestedIds.has(messageId)) return [messageId, message] as MessageItem;
        const refreshedMessage = updatesById.get(messageId);
        if (refreshedMessage == null) {
          feedChanged = true;
          removedMessageIds.add(messageId);
          return null;
        }
        if (refreshedMessage === message) {
          return [messageId, message] as MessageItem;
        }
        feedChanged = true;
        return [messageId, refreshedMessage] as MessageItem;
      })
      .filter((item): item is MessageItem => item != null);
    if (!feedChanged) return feed;
    changed = true;
    if (removedMessageIds.size === 0) {
      return { ...feed, items: nextItems };
    }

    const readIds =
      originalReadIds == null
        ? feedRuntime.readIds
        : new Set([...originalReadIds].filter((id) => !removedMessageIds.has(id)));
    const unreadCount =
      typeof feedRuntime.unreadCount === 'number'
        ? Math.max(
            0,
            feedRuntime.unreadCount -
              [...removedMessageIds].filter((id) => !originalReadIds?.has(id)).length,
          )
        : feedRuntime.unreadCount;

    return {
      ...feed,
      items: nextItems,
      readIds,
      unreadCount,
    };
  });

  return changed ? nextFeeds : currentFeeds;
}
