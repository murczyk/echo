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
  const pendingIdsRef = useRef<Set<number>>(new Set());
  const isProcessingRef = useRef(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    onMessageIdsRef.current = onMessageIds;
  }, [onMessageIds]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const processQueue = () => {
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;

    void (async () => {
      try {
        while (isMountedRef.current) {
          const nextIds = Array.from(pendingIdsRef.current);
          if (nextIds.length === 0) return;
          pendingIdsRef.current.clear();

          try {
            await onMessageIdsRef.current(nextIds);
          } catch (error) {
            console.error(error);
          }
        }
      } finally {
        isProcessingRef.current = false;
      }
    })();
  };

  useEffect(() => {
    const handleInboxChanged = (event: Event) => {
      const messageIds = extractMessageIds((event as CustomEvent<unknown>).detail);
      if (messageIds.length === 0) return;
      messageIds.forEach((messageId) => pendingIdsRef.current.add(messageId));
      processQueue();
    };

    window.addEventListener('echo-inbox-changed', handleInboxChanged);
    return () => {
      window.removeEventListener('echo-inbox-changed', handleInboxChanged);
    };
  }, []);
}
