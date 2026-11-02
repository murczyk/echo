import { useEffect, useRef, useState } from 'react';

import { usePowerSnackbar } from '../../../components/PowerSnackbar';
import {
  type AiAgentAuditRequestDetail,
  type AiAgentRequestState,
  getAiAgentAuditRequest,
  streamAiAgentAdminEvents,
} from '../../../services/api/ai-agent';
import { applyAiAgentEvent, type LiveRequest } from '../../ai-agent-chat';
import { streamAiAgentEventsWithReconnect } from '../../ai-agent-chat/stream';
import { errorMessage } from '../format';

const TERMINAL_STATES = new Set<AiAgentRequestState>(['completed', 'failed', 'cancelled']);

export function isTerminalRequestState(state: AiAgentRequestState): boolean {
  return TERMINAL_STATES.has(state);
}

export function liveRequestFromDetail(detail: AiAgentAuditRequestDetail): LiveRequest {
  const userMessage = detail.conversation.messages.find(
    (message) => message.requestId === detail.id && message.role === 'user',
  );
  const initial: LiveRequest = {
    id: detail.id,
    conversationId: detail.conversationId,
    prompt: detail.prompt,
    createdAt: detail.createdAt,
    startedAt: detail.startedAt,
    reasoningPreset: userMessage?.reasoningPreset ?? detail.metadata.reasoningPreset,
    maxRuntimeSeconds: userMessage?.maxRuntimeSeconds ?? detail.metadata.maxRuntimeSeconds,
    completionMetadata: detail.metadata.completionMetadata,
    attachments: userMessage?.attachments ?? [],
    state: 'queued',
    assistantText: '',
    progress: [],
    tools: [],
    activity: [],
    sources: [],
    lastSequence: 0,
    streamError: null,
  };
  const replayed = detail.events.reduce(applyAiAgentEvent, initial);
  if (!isTerminalRequestState(detail.state)) return replayed;
  return {
    ...replayed,
    state: detail.state,
    finishedAt: replayed.finishedAt ?? detail.completedAt ?? undefined,
  };
}

export function useLiveAdminRequest(
  detail: AiAgentAuditRequestDetail | null,
  onUpdated: (detail: AiAgentAuditRequestDetail) => void,
): { live: LiveRequest | null; reconnect: () => void } {
  const [live, setLive] = useState<LiveRequest | null>(() =>
    detail ? liveRequestFromDetail(detail) : null,
  );
  const onUpdatedRef = useRef(onUpdated);
  onUpdatedRef.current = onUpdated;
  const { notify } = usePowerSnackbar();

  useEffect(() => {
    if (!detail) {
      setLive(null);
      return;
    }
    let current = liveRequestFromDetail(detail);
    setLive(current);
    if (isTerminalRequestState(detail.state) || isTerminalRequestState(current.state)) return;

    const controller = new AbortController();
    const update = (next: LiveRequest) => {
      current = next;
      if (!controller.signal.aborted) setLive(next);
    };
    void (async () => {
      try {
        await streamAiAgentEventsWithReconnect({
          requestId: detail.id,
          signal: controller.signal,
          getAfterSequence: () => current.lastSequence,
          isTerminal: () => isTerminalRequestState(current.state),
          onEvent: (event) => update(applyAiAgentEvent(current, event)),
          connect: streamAiAgentAdminEvents,
        });
      } catch (streamError) {
        if (controller.signal.aborted) return;
        const message = errorMessage(streamError);
        update({ ...current, streamError: message });
        notify({ severity: 'error', message: `Потік запиту перервано: ${message}` });
        return;
      }
      if (controller.signal.aborted) return;
      try {
        const next = await getAiAgentAuditRequest(detail.id);
        if (!controller.signal.aborted) onUpdatedRef.current(next);
      } catch (loadError) {
        if (controller.signal.aborted) return;
        notify({
          severity: 'error',
          message: `Не вдалося оновити запит: ${errorMessage(loadError)}`,
        });
      }
    })();
    return () => controller.abort();
  }, [detail]);

  async function reconnect() {
    if (!detail) return;
    try {
      onUpdatedRef.current(await getAiAgentAuditRequest(detail.id));
    } catch (loadError) {
      notify({
        severity: 'error',
        message: `Не вдалося оновити запит: ${errorMessage(loadError)}`,
      });
    }
  }

  const current =
    detail && live?.id === detail.id ? live : detail ? liveRequestFromDetail(detail) : null;
  return { live: current, reconnect: () => void reconnect() };
}
