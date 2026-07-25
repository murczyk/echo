import { useEffect, useRef } from 'react';

type Params = {
  ignoreEvent?: (event: InboxChangedEvent) => boolean;
  onMessageIds: (messageIds: number[]) => void | Promise<void>;
};

export type InboxChangedEvent = {
  messageId: number;
  origin: string | null;
};

function isMessageId(messageId: unknown): messageId is number {
  return typeof messageId === 'number' && Number.isInteger(messageId);
}

function inboxChangedEvents(detail: unknown): InboxChangedEvent[] {
  if (detail == null || typeof detail !== 'object') return [];
  const rawEvents = (detail as { events?: unknown }).events;
  if (Array.isArray(rawEvents)) {
    const uniqueEvents = new Map<string, InboxChangedEvent>();
    rawEvents.forEach((event) => {
      if (event == null || typeof event !== 'object') return;
      const messageId = (event as { messageId?: unknown }).messageId;
      if (!isMessageId(messageId)) return;
      const rawOrigin = (event as { origin?: unknown }).origin;
      const origin = typeof rawOrigin === 'string' && rawOrigin !== '' ? rawOrigin : null;
      uniqueEvents.set(`${messageId}:${origin ?? ''}`, { messageId, origin });
    });
    return Array.from(uniqueEvents.values());
  }

  const messageIds = (detail as { messageIds?: unknown }).messageIds;
  if (!Array.isArray(messageIds)) return [];
  return Array.from(new Set(messageIds.filter(isMessageId))).map((messageId) => ({
    messageId,
    origin: null,
  }));
}

export function useInboxChangedMessageIds({ ignoreEvent, onMessageIds }: Params) {
  const ignoreEventRef = useRef(ignoreEvent);
  const onMessageIdsRef = useRef(onMessageIds);
  const pendingIdsRef = useRef<Set<number>>(new Set());
  const refreshInFlightRef = useRef(false);
  const isMountedRef = useRef(false);

  useEffect(() => {
    ignoreEventRef.current = ignoreEvent;
    onMessageIdsRef.current = onMessageIds;
  }, [ignoreEvent, onMessageIds]);

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
      const messageIds = inboxChangedEvents((event as CustomEvent<unknown>).detail)
        .filter((inboxEvent) => !ignoreEventRef.current?.(inboxEvent))
        .map((inboxEvent) => inboxEvent.messageId);
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
