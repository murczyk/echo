/**
 * @vitest-environment happy-dom
 */
import { act, createRef, forwardRef, StrictMode, useImperativeHandle } from 'react';
import type { RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage } from '../../../../Bindings';
import { useCreatedMessageResult, type CreatedMessageResultState } from './useCreatedMessageResult';

const fetchMessagesByIds = vi.hoisted(() => vi.fn());

vi.mock('../../services/api/inbox-messages', () => ({
  fetchMessagesByIds,
}));

type CreatedMessageInput = {
  signal_message_id: number;
  message?: InboxMessage;
};

type HarnessApi = {
  handleCreatedMessage: (result: CreatedMessageInput) => Promise<void>;
  closeCreatedMessageResult: () => void;
};

let latestState: CreatedMessageResultState = { kind: 'closed' };

const Harness = forwardRef<HarnessApi>(function Harness(_props, ref) {
  const { createdMessageResult, closeCreatedMessageResult, handleCreatedMessage } =
    useCreatedMessageResult();

  latestState = createdMessageResult;

  useImperativeHandle(
    ref,
    () => ({
      handleCreatedMessage,
      closeCreatedMessageResult,
    }),
    [closeCreatedMessageResult, handleCreatedMessage],
  );

  return null;
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function renderHarness(opts?: {
  strictMode?: boolean;
}): Promise<{ root: Root; apiRef: RefObject<HarnessApi> }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const apiRef = createRef<HarnessApi>();

  await act(async () => {
    root.render(
      opts?.strictMode ? (
        <StrictMode>
          <Harness ref={apiRef} />
        </StrictMode>
      ) : (
        <Harness ref={apiRef} />
      ),
    );
  });

  return { root, apiRef };
}

describe('useCreatedMessageResult', () => {
  let root: Root | undefined;
  let apiRef: RefObject<HarnessApi> | undefined;

  beforeEach(() => {
    latestState = { kind: 'closed' };
    fetchMessagesByIds.mockReset();
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', undefined);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('uses the response message directly and performs no fetch', async () => {
    ({ root, apiRef } = await renderHarness());
    const message = { messageUid: 'm-1' } as InboxMessage;

    await act(async () => {
      await apiRef.current!.handleCreatedMessage({ signal_message_id: 7, message });
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(fetchMessagesByIds).not.toHaveBeenCalled();
    expect(latestState).toEqual({ kind: 'message', messageId: 7, message });
  });

  it('still produces a message in Strict Mode', async () => {
    ({ root, apiRef } = await renderHarness({ strictMode: true }));
    const message = { messageUid: 'm-strict' } as InboxMessage;

    await act(async () => {
      await apiRef.current!.handleCreatedMessage({ signal_message_id: 8, message });
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(latestState).toEqual({ kind: 'message', messageId: 8, message });
  });

  it('fetches once when the response has no message', async () => {
    ({ root, apiRef } = await renderHarness());
    const message = { messageUid: 'm-2' } as InboxMessage;
    fetchMessagesByIds.mockResolvedValueOnce([[9, message]]);

    await act(async () => {
      await apiRef.current!.handleCreatedMessage({ signal_message_id: 9 });
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(fetchMessagesByIds).toHaveBeenCalledTimes(1);
    expect(fetchMessagesByIds).toHaveBeenCalledWith([9]);
    expect(latestState).toEqual({ kind: 'message', messageId: 9, message });
  });

  it('produces receipt state for rejection and empty response', async () => {
    ({ root, apiRef } = await renderHarness());
    fetchMessagesByIds.mockRejectedValueOnce(new Error('boom'));

    await act(async () => {
      await apiRef.current!.handleCreatedMessage({ signal_message_id: 11 });
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(latestState).toEqual(
      expect.objectContaining({
        kind: 'receipt',
        messageId: 11,
      }),
    );

    fetchMessagesByIds.mockReset();
    fetchMessagesByIds.mockResolvedValueOnce([[12, undefined]]);

    await act(async () => {
      await apiRef.current!.handleCreatedMessage({ signal_message_id: 12 });
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(latestState).toEqual(
      expect.objectContaining({
        kind: 'receipt',
        messageId: 12,
      }),
    );
  });

  it('ignores an older result that resolves after a newer one', async () => {
    ({ root, apiRef } = await renderHarness());
    const older = createDeferred<Array<[number, InboxMessage | undefined]>>();
    const olderMessage = { messageUid: 'm-old' } as InboxMessage;
    const newerMessage = { messageUid: 'm-new' } as InboxMessage;
    fetchMessagesByIds.mockImplementationOnce(() => older.promise);

    const olderPromise = apiRef.current!.handleCreatedMessage({ signal_message_id: 21 });
    const newerPromise = apiRef.current!.handleCreatedMessage({
      signal_message_id: 22,
      message: newerMessage,
    });

    await act(async () => {
      await newerPromise;
      await vi.runAllTimersAsync();
    });
    expect(latestState).toEqual({ kind: 'message', messageId: 22, message: newerMessage });

    await act(async () => {
      older.resolve([[21, olderMessage]]);
      await olderPromise;
      await vi.runAllTimersAsync();
    });
    expect(latestState).toEqual({ kind: 'message', messageId: 22, message: newerMessage });
  });

  it('close invalidates an unresolved request', async () => {
    ({ root, apiRef } = await renderHarness());
    const deferred = createDeferred<Array<[number, InboxMessage | undefined]>>();
    const message = { messageUid: 'm-close' } as InboxMessage;
    fetchMessagesByIds.mockImplementationOnce(() => deferred.promise);

    const pending = apiRef.current!.handleCreatedMessage({ signal_message_id: 31 });

    await act(async () => {
      apiRef.current!.closeCreatedMessageResult();
    });
    await act(async () => {
      deferred.resolve([[31, message]]);
      await pending;
      await vi.runAllTimersAsync();
    });

    expect(latestState).toEqual({ kind: 'closed' });
  });

  it('unmount prevents updates', async () => {
    ({ root, apiRef } = await renderHarness());
    const deferred = createDeferred<Array<[number, InboxMessage | undefined]>>();
    fetchMessagesByIds.mockImplementationOnce(() => deferred.promise);

    const pending = apiRef.current!.handleCreatedMessage({ signal_message_id: 41 });

    await act(async () => {
      root.unmount();
    });

    await act(async () => {
      deferred.resolve([[41, { messageUid: 'm-unmount' } as InboxMessage]]);
      await pending;
      await vi.runAllTimersAsync();
    });

    expect(latestState).toEqual({ kind: 'closed' });
  });

  it('scheduled presentation cannot reopen a closed preview', async () => {
    ({ root, apiRef } = await renderHarness());
    const message = { messageUid: 'm-scheduled' } as InboxMessage;

    const pending = apiRef.current!.handleCreatedMessage({ signal_message_id: 51, message });

    await act(async () => {
      apiRef.current!.closeCreatedMessageResult();
    });
    await act(async () => {
      await pending;
      await vi.runAllTimersAsync();
    });

    expect(latestState).toEqual({ kind: 'closed' });
  });
});
