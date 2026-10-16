import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupFeedState } from '../../../../../../Bindings';

import { createGroupFeedStateStore } from '../group-feed-state-store';

function group(masterKey: string, unreadCount = 0): GroupFeedState {
  return {
    masterKey,
    name: masterKey,
    colorKey: 'blue',
    ignoreOperativny: false,
    unreadCount,
    oldestUnreadMessageRef: null,
    lastActivityAt: null,
    latestCursor: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('group feed state store', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('single-flights concurrent visible consumers', async () => {
    const request = deferred<GroupFeedState[]>();
    const fetchStates = vi.fn(() => request.promise);
    const store = createGroupFeedStateStore({ fetchStates });

    const releaseFirst = store.addVisibleConsumer();
    const releaseSecond = store.addVisibleConsumer();
    expect(fetchStates).toHaveBeenCalledOnce();

    request.resolve([group('g-1')]);
    await vi.runAllTimersAsync();
    expect(store.getSnapshot().groups).toEqual([group('g-1')]);
    releaseFirst();
    releaseSecond();
  });

  it('keeps a closed consumer stale without fetching', async () => {
    const fetchStates = vi.fn(async () => [group('g-1')]);
    const store = createGroupFeedStateStore({ fetchStates });

    store.invalidate();
    await vi.runAllTimersAsync();

    expect(fetchStates).not.toHaveBeenCalled();
    expect(store.getSnapshot().stale).toBe(true);
  });

  it('coalesces an inbox-event burst into one refresh', async () => {
    const fetchStates = vi.fn(async () => [group('g-1')]);
    const store = createGroupFeedStateStore({ fetchStates, eventDebounceMs: 50 });
    const release = store.addVisibleConsumer();
    await vi.runAllTimersAsync();
    fetchStates.mockClear();

    store.invalidate();
    store.invalidate();
    store.invalidate();
    await vi.advanceTimersByTimeAsync(50);

    expect(fetchStates).toHaveBeenCalledOnce();
    release();
  });

  it('revalidates stale data on visibility and focus', async () => {
    const fetchStates = vi.fn(async () => [group('g-1')]);
    const store = createGroupFeedStateStore({ fetchStates });
    store.invalidate();

    const release = store.addVisibleConsumer();
    await vi.runAllTimersAsync();
    expect(fetchStates).toHaveBeenCalledOnce();

    store.invalidate({ schedule: false });
    await store.revalidateIfStale();
    expect(fetchStates).toHaveBeenCalledTimes(2);
    release();
  });

  it('discards a response from an obsolete generation', async () => {
    const first = deferred<GroupFeedState[]>();
    const second = deferred<GroupFeedState[]>();
    const fetchStates = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const store = createGroupFeedStateStore({ fetchStates, eventDebounceMs: 10 });
    const release = store.addVisibleConsumer();

    store.invalidate();
    await vi.advanceTimersByTimeAsync(10);
    second.resolve([group('new')]);
    await Promise.resolve();
    first.resolve([group('old')]);
    await Promise.resolve();

    expect(store.getSnapshot().groups).toEqual([group('new')]);
    release();
  });

  it('applies acknowledgement response without a follow-up GET', async () => {
    const fetchStates = vi.fn(async () => [group('g-1', 2)]);
    const acknowledge = vi.fn(async () => group('g-1', 0));
    const store = createGroupFeedStateStore({ fetchStates, acknowledge });
    const release = store.addVisibleConsumer();
    await vi.runAllTimersAsync();
    fetchStates.mockClear();

    await store.acknowledge({
      masterKey: 'g-1',
      cursor: { createdAt: 1, messageId: 2 },
    });

    expect(store.getSnapshot().groups).toEqual([group('g-1', 0)]);
    expect(fetchStates).not.toHaveBeenCalled();
    release();
  });

  it('does not publish an acknowledgement completed after its scope was aborted', async () => {
    const response = deferred<GroupFeedState>();
    const acknowledge = vi.fn(() => response.promise);
    const store = createGroupFeedStateStore({ acknowledge });
    const controller = new AbortController();
    const pending = store.acknowledge(
      {
        masterKey: 'g-1',
        cursor: { createdAt: 10, messageId: 11 },
      },
      controller.signal,
    );

    controller.abort();
    response.resolve(group('g-1', 0));

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(store.getSnapshot().groups).toEqual([]);
  });
});
