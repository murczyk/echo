/**
 * @vitest-environment happy-dom
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage } from '../../../../../Bindings';
import {
  buildMessageDraftMap,
  enqueueMessageSave,
  prepareQueuedMessageUpdate,
  useAnalysisMessageEditor,
} from '../use-analysis-message-editor';

const hoisted = vi.hoisted(() => ({
  fetchMessagesByIds: vi.fn(),
  onInboxChangedMessageIds: vi.fn(),
}));

vi.mock('../../../services/api/inbox-messages', () => ({
  fetchMessagesByIds: hoisted.fetchMessagesByIds,
}));

vi.mock('../../shared/useInboxChangedMessageIds', () => ({
  useInboxChangedMessageIds: ({
    onMessageIds,
  }: {
    onMessageIds: (messageIds: number[]) => void | Promise<void>;
  }) => {
    hoisted.onInboxChangedMessageIds = onMessageIds;
  },
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    promise,
    resolve,
    reject,
  };
}

// @test-scope safeguard: prevents concurrent saves for one message from applying in an order different from the user's edits.
describe('enqueueMessageSave', () => {
  it('serializes saves per message id', async () => {
    const queue = new Map<number, Promise<void>>();
    const events: string[] = [];
    const firstDone = deferred<void>();

    const first = enqueueMessageSave(queue, 7, async () => {
      events.push('first-start');
      await firstDone.promise;
      events.push('first-end');
      return true;
    });

    const second = enqueueMessageSave(queue, 7, async () => {
      events.push('second-start');
      return true;
    });

    await Promise.resolve();
    expect(events).toEqual(['first-start']);

    firstDone.resolve();
    await first;
    await second;

    expect(events).toEqual(['first-start', 'first-end', 'second-start']);
  });
});

// @test-scope safeguard: preserves the latest queued message draft when React state has not committed yet, preventing a later edit from restoring stale fields.
describe('prepareQueuedMessageUpdate', () => {
  it('uses the queued draft snapshot before React state commits', () => {
    const message = { callsigns: ['A'], callsignsAlg2: [] } as InboxMessage;
    const draftMap = buildMessageDraftMap([[5, message]]);

    const first = prepareQueuedMessageUpdate(
      draftMap,
      [[5, message]],
      5,
      (current) =>
        ({
          ...current,
          callsigns: [],
        }) as InboxMessage,
    );
    expect(first.currentMessage?.callsigns).toEqual(['A']);
    expect(first.nextMessage?.callsigns).toEqual([]);

    const second = prepareQueuedMessageUpdate(
      draftMap,
      [[5, message]],
      5,
      (current) =>
        ({
          ...current,
          callsigns: [...(current.callsigns ?? []), 'B'],
        }) as InboxMessage,
    );
    expect(second.currentMessage?.callsigns).toEqual([]);
    expect(second.nextMessage?.callsigns).toEqual(['B']);
  });
});

// @test-scope safeguard: preserves remote attachment refresh and correct report-versus-message edit ownership for the selected analysis message.
describe('useAnalysisMessageEditor', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: ReturnType<typeof useAnalysisMessageEditor> | null;
  let harnessMessages: Array<[number, InboxMessage]>;

  function Harness() {
    latest = useAnalysisMessageEditor({
      messages: harnessMessages,
      onError: vi.fn(),
      onUnauthorized: vi.fn().mockReturnValue(false),
      onUpdateLocalMessage: vi.fn(),
    });
    return null;
  }

  beforeEach(async () => {
    hoisted.fetchMessagesByIds.mockReset();
    hoisted.onInboxChangedMessageIds = vi.fn();
    latest = null;
    harnessMessages = [];
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(Harness));
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
  });

  it('opens report-edit loading synchronously and hydrates the editor without reopening', async () => {
    const request = deferred<Array<[number, InboxMessage]>>();
    const report = { groupMasterKey: null } as InboxMessage;
    hoisted.fetchMessagesByIds.mockReturnValueOnce(request.promise);

    act(() => {
      latest?.openReportEditor(91);
    });

    expect(latest?.editTargetLoadState).toEqual({ status: 'loading', reportId: 91 });
    expect(latest?.editorEditAsReport).toBe(true);
    expect(latest?.editorMessage).toBeNull();
    expect(latest?.reportSource).toBeNull();
    expect(hoisted.fetchMessagesByIds).toHaveBeenCalledWith(
      [91],
      null,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    await act(async () => {
      request.resolve([[91, report]]);
      await request.promise;
    });

    expect(latest?.editTargetLoadState).toEqual({ status: 'idle' });
    expect(latest?.editorMessage).toEqual({ id: 91, message: report });
  });

  it('keeps a failed report editor load open and retryable', async () => {
    const onError = vi.fn();
    root.unmount();
    function ErrorHarness() {
      latest = useAnalysisMessageEditor({
        messages: [],
        onError,
        onUnauthorized: vi.fn().mockReturnValue(false),
        onUpdateLocalMessage: vi.fn(),
      });
      return null;
    }
    root = createRoot(container);
    await act(async () => root.render(React.createElement(ErrorHarness)));
    hoisted.fetchMessagesByIds.mockRejectedValueOnce(new Error('failed'));

    act(() => latest?.openReportEditor(91));
    await act(async () => Promise.resolve());

    expect(latest?.editTargetLoadState).toEqual({
      status: 'error',
      reportId: 91,
      message: 'failed',
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it('aborts loading when the editor closes and ignores the stale result', async () => {
    const request = deferred<Array<[number, InboxMessage]>>();
    hoisted.fetchMessagesByIds.mockReturnValueOnce(request.promise);
    act(() => latest?.openReportEditor(91));
    const signal = hoisted.fetchMessagesByIds.mock.calls[0]?.[2]?.signal as AbortSignal;

    act(() => latest?.closeEditor());
    expect(signal.aborted).toBe(true);
    expect(latest?.editTargetLoadState).toEqual({ status: 'idle' });

    await act(async () => {
      request.resolve([[91, {} as InboxMessage]]);
      await request.promise;
    });
    expect(latest?.editorMessage).toBeNull();
  });

  it('aborts a loading report when a regular editor wins the transition', async () => {
    const request = deferred<Array<[number, InboxMessage]>>();
    const message = { groupMasterKey: 'group' } as InboxMessage;
    harnessMessages = [[42, message]];
    await act(async () => root.render(React.createElement(Harness)));
    hoisted.fetchMessagesByIds.mockReturnValueOnce(request.promise);
    act(() => latest?.openReportEditor(91));
    const signal = hoisted.fetchMessagesByIds.mock.calls[0]?.[2]?.signal as AbortSignal;
    act(() => latest?.openEditor(42));

    expect(signal.aborted).toBe(true);
    expect(latest?.editorMessage).toEqual({ id: 42, message });
    await act(async () => {
      request.resolve([[91, {} as InboxMessage]]);
      await request.promise;
    });
    expect(latest?.editorMessage).toEqual({ id: 42, message });
  });

  it('retries a failed report load with a fresh request', async () => {
    const first = deferred<Array<[number, InboxMessage]>>();
    const second = deferred<Array<[number, InboxMessage]>>();
    hoisted.fetchMessagesByIds
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    act(() => latest?.openReportEditor(91));
    await act(async () => {
      first.reject(new Error('failed'));
      await Promise.resolve();
    });
    act(() => latest?.retryEditTargetLoad());
    const firstSignal = hoisted.fetchMessagesByIds.mock.calls[0]?.[2]?.signal as AbortSignal;
    const secondSignal = hoisted.fetchMessagesByIds.mock.calls[1]?.[2]?.signal as AbortSignal;
    expect(secondSignal).not.toBe(firstSignal);
    await act(async () => {
      second.resolve([[91, {} as InboxMessage]]);
      await second.promise;
    });
    expect(latest?.editorMessage?.id).toBe(91);
  });

  it('updates attachments in an open report editor after a remote change', async () => {
    const original = { media: [{ id: 'old' }] } as InboxMessage;
    const updated = { media: [{ id: 'new' }] } as InboxMessage;
    hoisted.fetchMessagesByIds
      .mockResolvedValueOnce([[91, original]])
      .mockResolvedValueOnce([[91, updated]]);

    await act(async () => {
      await latest?.openReportEditor(91);
    });
    expect(latest?.editorMessage?.message.media).toEqual([{ id: 'old' }]);

    await act(async () => {
      await hoisted.onInboxChangedMessageIds([91]);
    });

    expect(latest?.editorMessage?.message.media).toEqual([{ id: 'new' }]);
  });

  it('opens an own report card in report edit mode from the regular editor action', async () => {
    harnessMessages = [
      [
        91,
        {
          groupMasterKey: null,
          parentMessages: [{ id: 42, isAccessible: false, isDeleted: false }],
        } as InboxMessage,
      ],
    ];
    await act(async () => {
      root.render(React.createElement(Harness));
    });

    await act(async () => {
      latest?.openEditor(91);
    });

    expect(latest?.editorEditAsReport).toBe(true);
  });

  it('opens a forwarded report in regular message edit mode', async () => {
    harnessMessages = [
      [
        91,
        {
          groupMasterKey: 'g-2',
          parentMessages: [{ id: 42, isAccessible: true, isDeleted: false }],
        } as InboxMessage,
      ],
    ];
    await act(async () => {
      root.render(React.createElement(Harness));
    });

    await act(async () => {
      latest?.openEditor(91);
    });

    expect(latest?.editorEditAsReport).toBe(false);
  });
});
