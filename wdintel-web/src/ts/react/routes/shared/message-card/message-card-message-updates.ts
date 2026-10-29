import type { InboxMessage } from '../../../../../Bindings';

export type MessageItem = [number, InboxMessage];

export type MessageFeedWithItems = {
  items: MessageItem[];
  pendingNewerItems?: MessageItem[];
};

export function inboxMessagesEqual(left: InboxMessage, right: InboxMessage): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function mergeUpdatedMessageItems(
  items: MessageItem[],
  requestedIds: Set<number>,
  updatesById: Map<number, InboxMessage>,
  removedMessageIds: Set<number>,
): MessageItem[] {
  let changed = false;
  const nextItems = items.flatMap((item) => {
    const [messageId, message] = item;
    if (!requestedIds.has(messageId)) return [item];
    const refreshedMessage = updatesById.get(messageId);
    if (refreshedMessage == null) {
      changed = true;
      removedMessageIds.add(messageId);
      return [];
    }
    if (inboxMessagesEqual(refreshedMessage, message)) return [item];
    changed = true;
    return [[messageId, refreshedMessage] as MessageItem];
  });
  return changed ? nextItems : items;
}

export function mergeUpdatedDutyFeedMessages<T extends MessageFeedWithItems & { id: string }>(
  currentFeeds: T[],
  feedId: string | null,
  requestedMessageIds: number[],
  updates: MessageItem[],
): T[] {
  if (currentFeeds.length === 0 || requestedMessageIds.length === 0) return currentFeeds;

  const requestedIds = new Set(requestedMessageIds);
  const updatesById = new Map<number, InboxMessage>(updates);
  let changed = false;
  const nextFeeds = currentFeeds.map((feed) => {
    if (feedId != null && feed.id !== feedId) return feed;
    const feedRuntime = feed as T & { readIds?: Set<number>; unreadCount?: number };
    const removedMessageIds = new Set<number>();
    const originalReadIds = feedRuntime.readIds instanceof Set ? feedRuntime.readIds : null;
    const nextItems = mergeUpdatedMessageItems(
      feed.items,
      requestedIds,
      updatesById,
      removedMessageIds,
    );
    const pendingNewerItems = feed.pendingNewerItems
      ? mergeUpdatedMessageItems(
          feed.pendingNewerItems,
          requestedIds,
          updatesById,
          removedMessageIds,
        )
      : feed.pendingNewerItems;
    if (nextItems === feed.items && pendingNewerItems === feed.pendingNewerItems) return feed;
    changed = true;
    if (removedMessageIds.size === 0) {
      return { ...feed, items: nextItems, pendingNewerItems };
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
      pendingNewerItems,
      readIds,
      unreadCount,
    };
  });

  return changed ? nextFeeds : currentFeeds;
}
