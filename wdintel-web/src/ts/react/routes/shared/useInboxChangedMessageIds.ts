import { useEffect, useRef } from 'react';

type Params = {
  ignoreEvent?: (event: InboxChangedEvent) => boolean;
  minIntervalMs?: number;
  scopeKey?: unknown;
  enabled?: boolean;
  refreshOnMount?: boolean;
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

export function inboxChangedEvents(detail: unknown): InboxChangedEvent[] {
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

export function useInboxChangedMessageIds({
  ignoreEvent,
  onMessageIds,
  minIntervalMs = 0,
  scopeKey,
  enabled = true,
  refreshOnMount = false,
}: Params) {
  const ignoreEventRef = useRef(ignoreEvent);
  const onMessageIdsRef = useRef(onMessageIds);
  const intervalRef = useRef(minIntervalMs);
  useEffect(() => {
    ignoreEventRef.current = ignoreEvent;
    onMessageIdsRef.current = onMessageIds;
    intervalRef.current = minIntervalMs;
  }, [ignoreEvent, onMessageIds, minIntervalMs]);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let inFlight = false;
    let completedAt: number | null = null;
    let initialRefresh = refreshOnMount;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let wake: (() => void) | null = null;
    const pending = new Map<number, InboxChangedEvent>();
    const flush = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        while ((initialRefresh || pending.size > 0) && !disposed) {
          const interval = Math.max(0, intervalRef.current);
          const delay =
            completedAt === null
              ? 0
              : Math.max(0, Math.min(interval, completedAt + interval - Date.now()));
          if (delay > 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
              timeout = setTimeout(resolve, delay);
            });
            timeout = null;
            wake = null;
          }
          if (disposed) return;
          initialRefresh = false;
          const events = Array.from(pending.values());
          pending.clear();
          try {
            await onMessageIdsRef.current(
              events.map((event) => event.messageId),
              events,
            );
          } catch (error) {
            console.error(error);
          } finally {
            completedAt = Date.now();
          }
        }
      } finally {
        inFlight = false;
      }
    };
    const onInboxChanged = (event: Event) => {
      const events = inboxChangedEvents((event as CustomEvent<unknown>).detail).filter(
        (inboxEvent) => !ignoreEventRef.current?.(inboxEvent),
      );
      events.forEach((event) => {
        const previous = pending.get(event.messageId);
        pending.set(event.messageId, {
          messageId: event.messageId,
          origin: event.origin ?? previous?.origin ?? null,
          intelligenceReport: event.intelligenceReport || previous?.intelligenceReport === true,
        });
      });
      if (pending.size > 0) void flush();
    };
    window.addEventListener('echo-inbox-changed', onInboxChanged);
    if (refreshOnMount) void flush();
    return () => {
      disposed = true;
      pending.clear();
      if (timeout !== null) clearTimeout(timeout);
      wake?.();
      window.removeEventListener('echo-inbox-changed', onInboxChanged);
    };
  }, [enabled, scopeKey, refreshOnMount]);
}
