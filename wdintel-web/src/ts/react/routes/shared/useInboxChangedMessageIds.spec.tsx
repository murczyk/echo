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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

  it('waits for the current refresh before starting the next long-poll', async () => {
    const firstRefresh = createDeferred<void>();
    hoisted.postJson
      .mockResolvedValueOnce({
        events: [{ id: '1', event_type: { ETInboxChanged: 1 }, created_at: 1 }],
        last_event_id: 'stream-1',
      })
      .mockResolvedValueOnce({
        events: [
          { id: '2', event_type: { ETInboxChanged: 1 }, created_at: 2 },
          { id: '3', event_type: { ETInboxChanged: 2 }, created_at: 3 },
        ],
        last_event_id: 'stream-2',
      })
      .mockReturnValue(new Promise(() => undefined));
    const onMessageIds = vi
      .fn()
      .mockImplementationOnce(() => firstRefresh.promise)
      .mockResolvedValue(undefined);

    renderHook(onMessageIds);
    await flushPromises();
    await flushPromises();

    expect(onMessageIds).toHaveBeenCalledTimes(1);
    expect(onMessageIds).toHaveBeenCalledWith([1]);
    expect(hoisted.postJson).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstRefresh.resolve();
      await Promise.resolve();
    });
    await flushPromises();

    expect(hoisted.postJson.mock.calls[1][1]).toEqual({
      session_id: 'current',
      last_event_id: 'stream-1',
    });
    expect(onMessageIds).toHaveBeenNthCalledWith(2, [1, 2]);
  });
});
