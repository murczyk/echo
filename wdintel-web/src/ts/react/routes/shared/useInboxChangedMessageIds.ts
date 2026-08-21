import { useEffect, useRef } from 'react';

type Params = {
  ignoreEvent?: (event: InboxChangedEvent) => boolean;
  onMessageIds: (messageIds: number[], events: InboxChangedEvent[]) => void | Promise<void>;
};

export type InboxChangedEvent = {
  messageId: number;
  origin: string | null;
  intelligenceReport: boolean;
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
      const intelligenceReport =
        (event as { intelligenceReport?: unknown }).intelligenceReport === true;
      uniqueEvents.set(`${messageId}:${origin ?? ''}:${intelligenceReport}`, {
        messageId,
        origin,
        intelligenceReport,
      });
    });
    return Array.from(uniqueEvents.values());
  }

  const messageIds = (detail as { messageIds?: unknown }).messageIds;
  if (!Array.isArray(messageIds)) return [];
  return Array.from(new Set(messageIds.filter(isMessageId))).map((messageId) => ({
    messageId,
    origin: null,
    intelligenceReport: false,
  }));
}

export function useInboxChangedMessageIds({ ignoreEvent, onMessageIds }: Params) {
  const ignoreEventRef = useRef(ignoreEvent);
  const onMessageIdsRef = useRef(onMessageIds);
  const pendingEventsRef = useRef<Map<number, InboxChangedEvent>>(new Map());
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
        while (pendingEventsRef.current.size > 0 && isMountedRef.current) {
          const pendingEvents = Array.from(pendingEventsRef.current.values());
          pendingEventsRef.current.clear();
          try {
            await onMessageIdsRef.current(
              pendingEvents.map((event) => event.messageId),
              pendingEvents,
            );
          } catch (error) {
            console.error(error);
          }
        }
      } finally {
        refreshInFlightRef.current = false;
      }
    };

    const enqueueEvents = (events: InboxChangedEvent[]) => {
      if (events.length === 0) return;
      events.forEach((event) => {
        const pendingEvent = pendingEventsRef.current.get(event.messageId);
        pendingEventsRef.current.set(event.messageId, {
          messageId: event.messageId,
          origin: event.origin ?? pendingEvent?.origin ?? null,
          intelligenceReport: event.intelligenceReport || pendingEvent?.intelligenceReport === true,
        });
      });
      void flushPendingIds();
    };

    const onInboxChanged = (event: Event) => {
      const events = inboxChangedEvents((event as CustomEvent<unknown>).detail).filter(
        (inboxEvent) => !ignoreEventRef.current?.(inboxEvent),
      );
      enqueueEvents(events);
    };

    window.addEventListener('echo-inbox-changed', onInboxChanged);

    return () => {
      isMountedRef.current = false;
      pendingEventsRef.current.clear();
      window.removeEventListener('echo-inbox-changed', onInboxChanged);
    };
  }, []);
}
