/**
 * @vitest-environment happy-dom
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useInboxChangedMessageIds } from '../useInboxChangedMessageIds';

function Harness({
  ignoreEvent,
  onMessageIds,
}: {
  ignoreEvent?: (event: {
    messageId: number;
    origin: string | null;
    intelligenceReport: boolean;
  }) => boolean;
  onMessageIds: (
    messageIds: number[],
    events: Array<{
      messageId: number;
      origin: string | null;
      intelligenceReport: boolean;
    }>,
  ) => void | Promise<void>;
}) {
  useInboxChangedMessageIds({ ignoreEvent, onMessageIds });
  return null;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// @test-scope safeguard: prevents inbox change events from being lost, duplicated, or applied after listener cleanup.
describe('useInboxChangedMessageIds', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
  });

  it('subscribes to echo-inbox-changed and forwards unique integer ids', async () => {
    const onMessageIds = vi.fn();

    await act(async () => {
      root.render(React.createElement(Harness, { onMessageIds }));
    });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('echo-inbox-changed', {
          detail: { messageIds: [7, 7, 8, 8, 9] },
        }),
      );
    });

    expect(onMessageIds).toHaveBeenCalledWith(
      [7, 8, 9],
      [
        { messageId: 7, origin: null, intelligenceReport: false },
        { messageId: 8, origin: null, intelligenceReport: false },
        { messageId: 9, origin: null, intelligenceReport: false },
      ],
    );
  });

  it('ignores malformed events and non-integer ids', async () => {
    const onMessageIds = vi.fn();

    await act(async () => {
      root.render(React.createElement(Harness, { onMessageIds }));
    });

    await act(async () => {
      window.dispatchEvent(new CustomEvent('echo-inbox-changed', { detail: null }));
      window.dispatchEvent(
        new CustomEvent('echo-inbox-changed', {
          detail: { messageIds: ['7', 7.2, 8, null, undefined] },
        }),
      );
    });

    expect(onMessageIds).toHaveBeenCalledWith(
      [8],
      [{ messageId: 8, origin: null, intelligenceReport: false }],
    );
  });

  it('ignores only correlated events and keeps unrelated updates for the same message', async () => {
    const onMessageIds = vi.fn();
    const ignoreEvent = vi.fn(
      (event: { messageId: number; origin: string | null }) => event.origin === 'local-origin',
    );

    await act(async () => {
      root.render(React.createElement(Harness, { ignoreEvent, onMessageIds }));
    });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('echo-inbox-changed', {
          detail: {
            events: [
              { messageId: 7, origin: 'local-origin' },
              { messageId: 7, origin: 'remote-origin' },
              { messageId: 8, origin: null },
            ],
          },
        }),
      );
    });

    expect(onMessageIds).toHaveBeenCalledWith(
      [7, 8],
      [
        { messageId: 7, origin: 'remote-origin', intelligenceReport: false },
        { messageId: 8, origin: null, intelligenceReport: false },
      ],
    );
    expect(ignoreEvent).toHaveBeenCalledTimes(3);
  });

  it('removes the listener on unmount', async () => {
    const onMessageIds = vi.fn();

    await act(async () => {
      root.render(React.createElement(Harness, { onMessageIds }));
    });

    await act(async () => {
      root.unmount();
    });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('echo-inbox-changed', {
          detail: { messageIds: [7] },
        }),
      );
    });

    expect(onMessageIds).not.toHaveBeenCalled();
  });

  it('serializes refreshes and coalesces ids received while a refresh is in flight', async () => {
    const firstRefresh = createDeferred<void>();
    const onMessageIds = vi
      .fn()
      .mockImplementationOnce(() => firstRefresh.promise)
      .mockResolvedValue(undefined);

    await act(async () => {
      root.render(React.createElement(Harness, { onMessageIds }));
    });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('echo-inbox-changed', {
          detail: { messageIds: [7, 8] },
        }),
      );
      window.dispatchEvent(
        new CustomEvent('echo-inbox-changed', {
          detail: { messageIds: [8, 9] },
        }),
      );
    });

    expect(onMessageIds).toHaveBeenCalledTimes(1);
    expect(onMessageIds).toHaveBeenCalledWith(
      [7, 8],
      [
        { messageId: 7, origin: null, intelligenceReport: false },
        { messageId: 8, origin: null, intelligenceReport: false },
      ],
    );

    await act(async () => {
      firstRefresh.resolve();
      await Promise.resolve();
    });

    expect(onMessageIds).toHaveBeenCalledTimes(2);
    expect(onMessageIds).toHaveBeenNthCalledWith(
      2,
      [8, 9],
      [
        { messageId: 8, origin: null, intelligenceReport: false },
        { messageId: 9, origin: null, intelligenceReport: false },
      ],
    );
  });

  it('preserves intelligence report metadata while coalescing message ids', async () => {
    const onMessageIds = vi.fn();

    await act(async () => {
      root.render(React.createElement(Harness, { onMessageIds }));
    });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('echo-inbox-changed', {
          detail: {
            events: [
              { messageId: 91, origin: null },
              { messageId: 91, origin: null, intelligenceReport: true },
            ],
          },
        }),
      );
    });

    expect(onMessageIds).toHaveBeenCalledWith(
      [91],
      [{ messageId: 91, origin: null, intelligenceReport: true }],
    );
  });
});
