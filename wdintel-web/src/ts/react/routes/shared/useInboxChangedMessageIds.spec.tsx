/**
 * @vitest-environment happy-dom
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useInboxChangedMessageIds } from './useInboxChangedMessageIds';

const hoisted = vi.hoisted(() => ({
  postJson: vi.fn(),
}));

vi.mock('../../services/api/client', () => ({
  postJson: hoisted.postJson,
  isAbortError: (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function Harness({
  onMessageIds,
}: {
  onMessageIds: (messageIds: number[]) => void | Promise<void>;
}) {
  useInboxChangedMessageIds({ onMessageIds });
  return null;
}

function renderHook(onMessageIds: (messageIds: number[]) => void | Promise<void>) {
  if (container == null) throw new Error('container not initialized');
  root = createRoot(container);
  act(() => {
    root?.render(React.createElement(Harness, { onMessageIds }));
  });
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  hoisted.postJson.mockReset();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

describe('useInboxChangedMessageIds', () => {
  it('long-polls backend events and forwards changed inbox message ids', async () => {
    hoisted.postJson
      .mockResolvedValueOnce({
        events: [
          { id: '1', event_type: { ETInboxChanged: 7 }, created_at: 1 },
          { id: '2', event_type: 'ETGeneric', created_at: 2 },
          { id: '3', event_type: { ETInboxChanged: 7 }, created_at: 3 },
          { id: '4', event_type: { ETInboxChanged: 8 }, created_at: 4 },
        ],
        last_event_id: 'stream-1',
      })
      .mockReturnValue(new Promise(() => undefined));
    const onMessageIds = vi.fn().mockResolvedValue(undefined);

    renderHook(onMessageIds);
    await flushPromises();
    await flushPromises();

    expect(hoisted.postJson).toHaveBeenCalledWith(
      '/api/event-stream/long-poll',
      { session_id: 'current', last_event_id: null },
      { signal: expect.any(AbortSignal) },
    );
    expect(onMessageIds).toHaveBeenCalledWith([7, 8]);
    expect(hoisted.postJson).toHaveBeenCalledTimes(2);
    expect(hoisted.postJson.mock.calls[1][1]).toEqual({
      session_id: 'current',
      last_event_id: 'stream-1',
    });
  });
});
