import type { InboxMessage } from '../../../../../Bindings';

export type MessageItem = [number, InboxMessage];

export type MessageFeedWithItems = {
  items: MessageItem[];
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
    let feedChanged = false;
    const nextItems = feed.items.map(([messageId, message]) => {
      if (!requestedIds.has(messageId)) return [messageId, message] as MessageItem;
      const refreshedMessage = updatesById.get(messageId);
      if (refreshedMessage == null || refreshedMessage === message) {
        return [messageId, message] as MessageItem;
      }
      feedChanged = true;
      return [messageId, refreshedMessage] as MessageItem;
    });
    if (!feedChanged) return feed;
    changed = true;
    return { ...feed, items: nextItems };
  });

  return changed ? nextFeeds : currentFeeds;
}
