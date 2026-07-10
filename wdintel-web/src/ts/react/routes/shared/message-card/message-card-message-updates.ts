import type { InboxMessage } from '../../../../../Bindings';

export type MessageItem = [number, InboxMessage];

export type MessageFeedWithItems = {
  items: MessageItem[];
};

type MessageFeedUnreadState = {
  readIds?: Set<number>;
  unreadCount?: number;
};

type MessageTagFields = Pick<InboxMessage, 'inboxTags' | 'tags'>;

export type MessageTagMergeOptions = {
  withoutModelTags?: boolean;
};

function filterModelTags(inboxTags: InboxMessage['inboxTags']): InboxMessage['inboxTags'] {
  if (inboxTags == null) return inboxTags;
  return inboxTags.filter((tag) => tag.model == null);
}

function mergeTagFields(
  message: InboxMessage,
  updates: MessageTagFields,
  options?: MessageTagMergeOptions,
): InboxMessage {
  if (!options?.withoutModelTags) {
    return {
      ...message,
      inboxTags: updates.inboxTags,
      tags: updates.tags,
    };
  }

  const inboxTags = filterModelTags(updates.inboxTags);
  if (inboxTags == null) {
    return {
      ...message,
      inboxTags: updates.inboxTags,
      tags: updates.tags,
    };
  }

  return {
    ...message,
    inboxTags,
    tags: inboxTags.map((tag) => tag.tagId),
  };
}

export function mergeUpdatedVisibleMessageTags(
  current: MessageItem[],
  updates: MessageItem[],
  options?: MessageTagMergeOptions,
): MessageItem[] {
  if (current.length === 0 || updates.length === 0) return current;

  const updatesById = new Map<number, MessageTagFields>();
  updates.forEach(([messageId, message]) => {
    updatesById.set(messageId, {
      inboxTags: message.inboxTags,
      tags: message.tags,
    });
  });

  let changed = false;
  const nextItems = current.map(([messageId, message]) => {
    const nextMessage = updatesById.get(messageId);
    if (
      nextMessage === undefined ||
      (nextMessage.inboxTags === message.inboxTags && nextMessage.tags === message.tags)
    ) {
      return [messageId, message] as MessageItem;
    }
    changed = true;
    return [messageId, mergeTagFields(message, nextMessage, options)] as MessageItem;
  });

  return changed ? nextItems : current;
}

function mergeUpdatedDutyFeedItems(
  currentItems: MessageItem[],
  requestedMessageIds: ReadonlySet<number>,
  updates: MessageItem[],
): { items: MessageItem[]; removedMessageIds: Set<number> } {
  if (currentItems.length === 0 || requestedMessageIds.size === 0) {
    return { items: currentItems, removedMessageIds: new Set() };
  }

  const updatesById = new Map<number, InboxMessage>();
  updates.forEach(([messageId, message]) => {
    updatesById.set(messageId, message);
  });

  let changed = false;
  const nextItems: MessageItem[] = [];
  const removedMessageIds = new Set<number>();
  currentItems.forEach(([messageId, message]) => {
    if (!requestedMessageIds.has(messageId)) {
      nextItems.push([messageId, message]);
      return;
    }

    const refreshedMessage = updatesById.get(messageId);
    if (refreshedMessage == null) {
      changed = true;
      removedMessageIds.add(messageId);
      return;
    }

    if (refreshedMessage === message) {
      nextItems.push([messageId, message]);
      return;
    }

    changed = true;
    nextItems.push([messageId, refreshedMessage]);
  });

  return {
    items: changed ? nextItems : currentItems,
    removedMessageIds,
  };
}

function mergeDutyFeedUnreadState<T extends MessageFeedUnreadState>(
  feed: T,
  removedMessageIds: ReadonlySet<number>,
): T {
  if (removedMessageIds.size === 0 || !(feed.readIds instanceof Set)) return feed;

  const nextReadIds = new Set([...feed.readIds].filter((id) => !removedMessageIds.has(id)));
  const removedUnreadCount =
    typeof feed.unreadCount === 'number'
      ? [...removedMessageIds].filter((id) => !feed.readIds?.has(id)).length
      : 0;
  const unreadCount =
    typeof feed.unreadCount === 'number'
      ? Math.max(0, feed.unreadCount - removedUnreadCount)
      : feed.unreadCount;

  return {
    ...feed,
    readIds: nextReadIds,
    unreadCount,
  };
}

export function mergeUpdatedDutyFeedMessages<
  T extends MessageFeedWithItems & MessageFeedUnreadState & { id: string },
>(currentFeeds: T[], feedId: string, requestedMessageIds: number[], updates: MessageItem[]): T[] {
  if (currentFeeds.length === 0 || requestedMessageIds.length === 0) return currentFeeds;

  const requestedIds = new Set(requestedMessageIds);
  let changed = false;
  const nextFeeds = currentFeeds.map((feed) => {
    if (feed.id !== feedId) return feed;
    const { items: nextItems, removedMessageIds } = mergeUpdatedDutyFeedItems(
      feed.items,
      requestedIds,
      updates,
    );
    if (nextItems === feed.items) return feed;
    changed = true;
    return { ...mergeDutyFeedUnreadState(feed, removedMessageIds), items: nextItems };
  });

  return changed ? nextFeeds : currentFeeds;
}
