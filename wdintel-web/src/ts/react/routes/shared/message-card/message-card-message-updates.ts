import type { InboxMessage } from '../../../../../Bindings';

export type MessageItem = [number, InboxMessage];

export type MessageFeedWithItems = {
  items: MessageItem[];
};

export function mergeUpdatedVisibleMessages(
  current: MessageItem[],
  updates: MessageItem[],
): MessageItem[] {
  if (current.length === 0 || updates.length === 0) return current;

  const updatesById = new Map<number, InboxMessage>();
  updates.forEach(([messageId, message]) => {
    updatesById.set(messageId, message);
  });

  let changed = false;
  const nextItems = current.map(([messageId, message]) => {
    const nextMessage = updatesById.get(messageId);
    if (nextMessage === undefined || nextMessage === message) {
      return [messageId, message] as MessageItem;
    }
    changed = true;
    return [messageId, nextMessage] as MessageItem;
  });

  return changed ? nextItems : current;
}

export function mergeUpdatedDutyFeedMessages<T extends MessageFeedWithItems>(
  currentFeeds: T[],
  updates: MessageItem[],
): T[] {
  if (currentFeeds.length === 0 || updates.length === 0) return currentFeeds;

  let changed = false;
  const nextFeeds = currentFeeds.map((feed) => {
    const nextItems = mergeUpdatedVisibleMessages(feed.items, updates);
    if (nextItems === feed.items) return feed;
    changed = true;
    return { ...feed, items: nextItems };
  });

  return changed ? nextFeeds : currentFeeds;
}
