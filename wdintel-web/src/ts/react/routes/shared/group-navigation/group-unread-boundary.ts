import { useCallback, useState } from 'react';
import type { GroupFeedState, InboxMessage } from '../../../../../Bindings';

export type GroupUnreadBoundary = {
  key: string;
  groups: readonly GroupFeedState[] | null;
  messageId: number | null;
  dismissed?: boolean;
};

function isPersistedUnread(id: number, message: InboxMessage, group: GroupFeedState): boolean {
  if (message.isOwn === true) return false;
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
  return (
    group.lastReadCreatedAtOrder === null ||
    order > group.lastReadCreatedAtOrder ||
    (order === group.lastReadCreatedAtOrder &&
      group.lastReadMessageId != null &&
      id > group.lastReadMessageId)
  );
}

type Options = {
  key: string;
  loading: boolean;
  groups: readonly GroupFeedState[];
  ready: boolean;
  messages: ReadonlyArray<[number, InboxMessage]>;
  isLocallyUnread?: (id: number) => boolean;
};

export function resolveGroupUnreadBoundary(
  options: Options,
  previous?: GroupUnreadBoundary,
): GroupUnreadBoundary {
  const { key, loading, groups, ready, messages, isLocallyUnread } = options;
  const boundary = previous?.key === key ? previous : { key, groups: null, messageId: null };
  if (loading || boundary.dismissed) return boundary;
  const unreadGroups =
    boundary.groups ?? (ready ? groups.filter((group) => group.unreadCount > 0) : null);
  const messageId =
    boundary.messageId ??
    messages.find(
      ([id, message]) =>
        message.isOwn !== true &&
        (isLocallyUnread?.(id) ||
          unreadGroups?.some((group) => isPersistedUnread(id, message, group))),
    )?.[0] ??
    null;
  return unreadGroups === boundary.groups && messageId === boundary.messageId
    ? boundary
    : { key, groups: unreadGroups, messageId };
}

export function useGroupUnreadBoundary(options: Options) {
  const [boundary, setBoundary] = useState<GroupUnreadBoundary>();
  const next = resolveGroupUnreadBoundary(options, boundary);
  if (next !== boundary) setBoundary(next);
  const dismiss = useCallback(() => {
    setBoundary((current) =>
      current ? { ...current, messageId: null, dismissed: true } : current,
    );
  }, []);
  return { messageId: next.messageId, dismiss };
}
