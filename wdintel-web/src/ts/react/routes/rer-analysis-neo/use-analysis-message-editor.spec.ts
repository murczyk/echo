import { describe, expect, it } from 'vitest';

import type { InboxMessage } from '../../../../Bindings';
import { buildMessageDraftMap, enqueueMessageSave, prepareQueuedMessageUpdate } from './use-analysis-message-editor';

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

    const first = prepareQueuedMessageUpdate(draftMap, [[5, message]], 5, (current) => ({
      ...current,
      callsigns: [],
    } as InboxMessage));
    expect(first.currentMessage?.callsigns).toEqual(['A']);
    expect(first.nextMessage?.callsigns).toEqual([]);

    const second = prepareQueuedMessageUpdate(draftMap, [[5, message]], 5, (current) => ({
      ...current,
      callsigns: [...(current.callsigns ?? []), 'B'],
    } as InboxMessage));
    expect(second.currentMessage?.callsigns).toEqual([]);
    expect(second.nextMessage?.callsigns).toEqual(['B']);
  });
});
