import { useEffect } from 'react';

export const INBOX_CHANGED_MESSAGE_IDS_EVENT = 'inbox-changed-message-ids';

type InboxChangedMessageIdsEventDetail = number[] | { messageIds?: number[] };

type Params = {
  onMessageIds: (messageIds: number[]) => void | Promise<void>;
};

function getMessageIdsFromEvent(event: Event): number[] {
  const detail = (event as CustomEvent<InboxChangedMessageIdsEventDetail>).detail;
  if (Array.isArray(detail)) return detail;
  return detail?.messageIds ?? [];
}

export function useInboxChangedMessageIds({ onMessageIds }: Params) {
  useEffect(() => {
    const handleInboxChangedMessageIds = (event: Event) => {
      const messageIds = getMessageIdsFromEvent(event);
      if (messageIds.length > 0) void onMessageIds(messageIds);
    };

    window.addEventListener(INBOX_CHANGED_MESSAGE_IDS_EVENT, handleInboxChangedMessageIds);
    return () => {
      window.removeEventListener(INBOX_CHANGED_MESSAGE_IDS_EVENT, handleInboxChangedMessageIds);
    };
  }, [onMessageIds]);
}
