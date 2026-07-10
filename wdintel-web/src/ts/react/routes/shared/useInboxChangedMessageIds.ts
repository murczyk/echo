import { useEffect, useRef } from 'react';

import type { EventMsg, LongPollRsp } from '../../../../Bindings';
import { transformSnakeToCamel } from '../../../snake-to-camel';
import { isAbortError, postJson } from '../../services/api/client';

type Params = {
  onMessageIds: (messageIds: number[]) => void | Promise<void>;
};

const EVENT_POLL_RETRY_MS = 1000;

async function pollEvents(lastEventId: string | null, signal: AbortSignal): Promise<LongPollRsp> {
  const raw = await postJson<unknown>(
    '/api/event-stream/long-poll',
    { session_id: 'current', last_event_id: lastEventId },
    { signal },
  );
  return transformSnakeToCamel<LongPollRsp>(raw);
}

function inboxChangedMessageId(event: EventMsg): number | null {
  if (typeof event.eventType !== 'object' || event.eventType == null) return null;
  const eventType = event.eventType as { ETInboxChanged?: unknown };
  const messageId = eventType.ETInboxChanged;
  return typeof messageId === 'number' && Number.isInteger(messageId) ? messageId : null;
}

function inboxChangedMessageIds(events: EventMsg[]): number[] {
  return Array.from(
    new Set(
      events
        .map(inboxChangedMessageId)
        .filter((messageId): messageId is number => messageId != null),
    ),
  );
}

export function useInboxChangedMessageIds({ onMessageIds }: Params) {
  const onMessageIdsRef = useRef(onMessageIds);

  useEffect(() => {
    onMessageIdsRef.current = onMessageIds;
  }, [onMessageIds]);

  useEffect(() => {
    let disposed = false;
    let lastEventId: string | null = null;
    let retryTimer: number | null = null;
    let activeController: AbortController | null = null;

    const scheduleRetry = () => {
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void runPoll();
      }, EVENT_POLL_RETRY_MS);
    };

    const runPoll = async () => {
      const controller = new AbortController();
      activeController = controller;
      try {
        const rsp = await pollEvents(lastEventId, controller.signal);
        if (disposed || controller.signal.aborted) return;
        lastEventId = rsp.lastEventId ?? lastEventId;
        const messageIds = inboxChangedMessageIds(rsp.events ?? []);
        if (messageIds.length > 0) await onMessageIdsRef.current(messageIds);
        if (!disposed) void runPoll();
      } catch (error) {
        if (disposed || controller.signal.aborted || isAbortError(error)) return;
        scheduleRetry();
      } finally {
        if (activeController === controller) activeController = null;
      }
    };

    void runPoll();

    return () => {
      disposed = true;
      activeController?.abort();
      if (retryTimer != null) window.clearTimeout(retryTimer);
    };
  }, []);
}
