/**
 * @vitest-environment happy-dom
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage } from '../../../../Bindings';
import {
  buildMessageDraftMap,
  enqueueMessageSave,
  prepareQueuedMessageUpdate,
  useAnalysisMessageEditor,
} from './use-analysis-message-editor';

const hoisted = vi.hoisted(() => ({
  fetchMessagesByIds: vi.fn(),
  onInboxChangedMessageIds: vi.fn(),
}));

vi.mock('../../services/api/inbox-messages', () => ({
  fetchMessagesByIds: hoisted.fetchMessagesByIds,
}));

vi.mock('../shared/useInboxChangedMessageIds', () => ({
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
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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

describe('useAnalysisMessageEditor', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: ReturnType<typeof useAnalysisMessageEditor> | null;

  function Harness() {
    latest = useAnalysisMessageEditor({
      messages: [],
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
});
