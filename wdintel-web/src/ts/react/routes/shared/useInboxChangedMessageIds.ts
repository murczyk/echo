import { useEffect, useRef } from 'react';

type Params = {
  onMessageIds: (messageIds: number[]) => void | Promise<void>;
};

function inboxChangedMessageIds(messageIds: unknown): number[] {
  if (!Array.isArray(messageIds)) return [];
  return Array.from(
    new Set(
      messageIds.filter((messageId): messageId is number => {
        return typeof messageId === 'number' && Number.isInteger(messageId);
      }),
    ),
  );
}

export function useInboxChangedMessageIds({ onMessageIds }: Params) {
  const onMessageIdsRef = useRef(onMessageIds);
  const pendingIdsRef = useRef<Set<number>>(new Set());
  const refreshInFlightRef = useRef(false);
  const isMountedRef = useRef(false);

  useEffect(() => {
    onMessageIdsRef.current = onMessageIds;
  }, [onMessageIds]);

  useEffect(() => {
    isMountedRef.current = true;

    const flushPendingIds = async () => {
      if (refreshInFlightRef.current) return;
      refreshInFlightRef.current = true;
      try {
        while (pendingIdsRef.current.size > 0 && isMountedRef.current) {
          const pendingIds = Array.from(pendingIdsRef.current);
          pendingIdsRef.current.clear();
          try {
            await onMessageIdsRef.current(pendingIds);
          } catch (error) {
            console.error(error);
          }
        }
      } finally {
        refreshInFlightRef.current = false;
      }
    };

    const enqueueMessageIds = (messageIds: number[]) => {
      if (messageIds.length === 0) return;
      messageIds.forEach((messageId) => pendingIdsRef.current.add(messageId));
      void flushPendingIds();
    };

    const onInboxChanged = (event: Event) => {
      const messageIds = inboxChangedMessageIds(
        (event as CustomEvent<{ messageIds?: unknown }>).detail?.messageIds,
      );
      if (messageIds.length === 0) return;
      enqueueMessageIds(messageIds);
    };

    window.addEventListener('echo-inbox-changed', onInboxChanged);

    return () => {
      isMountedRef.current = false;
      pendingIdsRef.current.clear();
      window.removeEventListener('echo-inbox-changed', onInboxChanged);
    };
  }, []);
}
