import { describe, expect, it, vi } from 'vitest';

import type { AiAgentEvent } from '../../../services/api/ai-agent';
import { streamAiAgentEventsWithReconnect } from '../stream';
describe('streamAiAgentEventsWithReconnect', () => {
  it('resumes after the last ordered sequence', async () => {
    let lastSequence = 0;
    let terminal = false;
    const afterSequences: number[] = [];
    const connect = vi.fn(
      async (input: { afterSequence: number; onEvent: (event: AiAgentEvent) => void }) => {
        afterSequences.push(input.afterSequence);
        if (afterSequences.length === 1) {
          input.onEvent({
            sequence: 3,
            requestId: 'request-1',
            type: 'assistant_delta',
            createdAt: 0,
            text: 'частина',
            toolCallId: null,
            toolName: null,
            sourceTitle: null,
            sourceUrl: null,
            method: null,
            path: null,
            status: null,
            isError: null,
          });
          lastSequence = 3;
          throw new Error('disconnected');
        }
        terminal = true;
      },
    );

    await streamAiAgentEventsWithReconnect({
      requestId: 'request-1',
      signal: new AbortController().signal,
      getAfterSequence: () => lastSequence,
      isTerminal: () => terminal,
      onEvent: vi.fn(),
      connect: connect as never,
      reconnectDelayMs: 0,
    });

    expect(afterSequences).toEqual([0, 3]);
  });

  it('#3985 keeps resuming a long request that delivers events between drops', async () => {
    let sequence = 0;
    let connections = 0;
    const connect = vi.fn(async (input: { onEvent: (event: AiAgentEvent) => void }) => {
      connections += 1;
      if (connections <= 6) {
        sequence += 1;
        input.onEvent({ sequence, requestId: 'request-1', type: 'progress' } as AiAgentEvent);
        throw new Error('disconnected');
      }
      throw new Error('still offline');
    });

    await expect(
      streamAiAgentEventsWithReconnect({
        requestId: 'request-1',
        signal: new AbortController().signal,
        getAfterSequence: () => sequence,
        isTerminal: () => false,
        onEvent: vi.fn(),
        connect: connect as never,
        reconnectDelayMs: 0,
      }),
    ).rejects.toThrow('still offline');
    // Six drops after delivered events, then the usual three retries.
    expect(connections).toBe(9);
  });

  it('stops retrying after cancellation', async () => {
    const controller = new AbortController();
    const connect = vi.fn(async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });

    await streamAiAgentEventsWithReconnect({
      requestId: 'request-1',
      signal: controller.signal,
      getAfterSequence: () => 0,
      isTerminal: () => false,
      onEvent: vi.fn(),
      connect: connect as never,
      reconnectDelayMs: 0,
    });

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('makes three reconnect attempts before failing', async () => {
    const connect = vi.fn().mockRejectedValue(new Error('disconnected'));

    await expect(
      streamAiAgentEventsWithReconnect({
        requestId: 'request-1',
        signal: new AbortController().signal,
        getAfterSequence: () => 0,
        isTerminal: () => false,
        onEvent: vi.fn(),
        connect,
        reconnectDelayMs: 0,
      }),
    ).rejects.toThrow('disconnected');

    expect(connect).toHaveBeenCalledTimes(4);
  });
});
