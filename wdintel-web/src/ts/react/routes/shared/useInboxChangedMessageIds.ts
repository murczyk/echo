import { useEffect, useRef } from 'react';

type InboxChangedDetail = {
  messageIds?: unknown;
};

type Params = {
  onMessageIds: (messageIds: number[]) => void | Promise<void>;
};

function extractMessageIds(detail: unknown): number[] {
  if (detail == null || typeof detail !== 'object') return [];
  const messageIds = (detail as InboxChangedDetail).messageIds;
  if (!Array.isArray(messageIds)) return [];

  const dedupedMessageIds: number[] = [];
  const seenIds = new Set<number>();
  messageIds.forEach((messageId) => {
    if (!Number.isInteger(messageId) || seenIds.has(messageId)) return;
    seenIds.add(messageId);
    dedupedMessageIds.push(messageId);
  });
  return dedupedMessageIds;
}

export function useInboxChangedMessageIds({ onMessageIds }: Params) {
  const onMessageIdsRef = useRef(onMessageIds);

  useEffect(() => {
    onMessageIdsRef.current = onMessageIds;
  }, [onMessageIds]);

  useEffect(() => {
    const handleInboxChanged = (event: Event) => {
      const messageIds = extractMessageIds((event as CustomEvent<unknown>).detail);
      if (messageIds.length === 0) return;
      void onMessageIdsRef.current(messageIds);
    };

    window.addEventListener('echo-inbox-changed', handleInboxChanged);
    return () => {
      window.removeEventListener('echo-inbox-changed', handleInboxChanged);
    };
  }, []);
}
