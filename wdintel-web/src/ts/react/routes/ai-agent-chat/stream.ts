import { AiAgentEvent, streamAiAgentEvents } from '../../services/api/ai-agent';

type Connect = typeof streamAiAgentEvents;

export async function streamAiAgentEventsWithReconnect(input: {
  requestId: string;
  signal: AbortSignal;
  getAfterSequence: () => number;
  isTerminal: () => boolean;
  onEvent: (event: AiAgentEvent) => void;
  connect?: Connect;
  maxReconnects?: number;
  reconnectDelayMs?: number;
}): Promise<void> {
  const connect = input.connect ?? streamAiAgentEvents;
  const maxReconnects = input.maxReconnects ?? 3;
  const reconnectDelayMs = input.reconnectDelayMs ?? 500;
  let reconnects = 0;
  let lastError: unknown = new Error('Потік подій завершився до завершення запиту.');

  while (!input.signal.aborted && !input.isTerminal()) {
    try {
      await connect({
        requestId: input.requestId,
        afterSequence: input.getAfterSequence(),
        signal: input.signal,
        onEvent: input.onEvent,
      });
    } catch (error) {
      lastError = error;
    }

    if (input.signal.aborted || input.isTerminal()) return;
    reconnects += 1;
    if (reconnects > maxReconnects) throw lastError;
    await new Promise((resolve) => globalThis.setTimeout(resolve, reconnectDelayMs * reconnects));
  }
}
