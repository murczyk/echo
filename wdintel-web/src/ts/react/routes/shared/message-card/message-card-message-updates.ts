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

export function mergeUpdatedDutyFeedMessageTags<T extends MessageFeedWithItems>(
  currentFeeds: T[],
  updates: MessageItem[],
  options?: MessageTagMergeOptions,
): T[] {
  if (currentFeeds.length === 0 || updates.length === 0) return currentFeeds;

  let changed = false;
  const nextFeeds = currentFeeds.map((feed) => {
    const nextItems = mergeUpdatedVisibleMessageTags(feed.items, updates, options);
    if (nextItems === feed.items) return feed;
    changed = true;
    return { ...feed, items: nextItems };
  });

  return changed ? nextFeeds : currentFeeds;
}
