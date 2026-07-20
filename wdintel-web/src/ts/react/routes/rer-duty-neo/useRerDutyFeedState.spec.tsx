/**
 * @vitest-environment happy-dom
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxMessage, InboxMessagesRsp } from '../../../../Bindings';
import { minimalInboxMessage } from './inbox-message-mocks';
import {
  DUTY_FEED_MESSAGE_WINDOW_LIMIT,
  emptyFilter,
  feedIndicatorUnreadCount,
  feedLoadedUnreadCount,
} from './utils';
import { useRerDutyFeedState } from './useRerDutyFeedState';

const hoisted = vi.hoisted(() => ({
  fetchInboxMessages: vi.fn(),
  fetchInboxCount: vi.fn(),
  rerDutyShortStateCreate: vi.fn(),
  rerDutyShortStateGet: vi.fn(),
  fetchServerInfo: vi.fn(),
  systemSettingsCurrent: vi.fn(),
  notifyDutyNewMessages: vi.fn(),
}));

vi.mock('../../services/api/inbox', () => ({
  fetchInboxMessages: hoisted.fetchInboxMessages,
  fetchInboxCount: hoisted.fetchInboxCount,
  rerDutyShortStateCreate: hoisted.rerDutyShortStateCreate,
  rerDutyShortStateGet: hoisted.rerDutyShortStateGet,
}));

vi.mock('../../services/api/system-settings', () => ({
  currentSystemSettings: hoisted.systemSettingsCurrent,
}));

vi.mock('./notifications', () => ({
  notifyDutyNewMessages: hoisted.notifyDutyNewMessages,
}));

vi.mock('../../services/api/networks', () => ({
  getNetworksByIds: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../../services/api/units', () => ({
  getUnitsList: vi.fn(() => Promise.resolve([])),
}));

function inboxRsp(items: Array<[number, InboxMessage]>): InboxMessagesRsp {
  return {
    inboxItems: items,
    callsigns: [],
    signalProfiles: {},
    signalGroups: [],
    freqPelengsSummary: null,
    pageLimit: 20,
  };
}

function rangeRsp(from: number, to: number): InboxMessagesRsp {
  return inboxRsp(
    Array.from({ length: to - from + 1 }, (_, index) => {
      const id = from + index;
      return [id, minimalInboxMessage({ timestamp: id * 100 })];
    }),
  );
}

function TestHarness(props: {
  apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null>;
  disableAutoScroll?: boolean;
}) {
  const api = useRerDutyFeedState({
    freqs: [],
    setProfiles: vi.fn(),
    setGroupInfos: vi.fn(),
    testEnabled: false,
    testSinceMs: 0,
    testLimit: 1,
    pollIntervalSec: 1,
    disableAutoScroll: props.disableAutoScroll ?? false,
  });
  props.apiRef.current = api;
  return null;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useRerDutyFeedState — loading', () => {
  let container: HTMLElement;
  let root: Root;
  let rafCallbacks: FrameRequestCallback[];

  const runNextRaf = () => {
    const callback = rafCallbacks.shift();
    callback?.(0);
  };

  async function mountLoadedFeed(disableAutoScroll = false) {
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };
    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} disableAutoScroll={disableAutoScroll} />);
      await flushMicrotasks();
    });
    const scrollToEnd = vi.fn();
    apiRef.current!.columnRefsRef.current['mf-0'] = { scrollToEnd };
    return { apiRef, scrollToEnd };
  }

  async function startPoll() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    rafCallbacks = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.clearAllMocks();
    hoisted.fetchInboxMessages.mockReset();
    hoisted.fetchInboxCount.mockReset();
    hoisted.notifyDutyNewMessages.mockReset();
    window.history.replaceState({}, '', '/');
    hoisted.fetchInboxCount.mockResolvedValue({ quantity: 0, firstElementTs: null });
    hoisted.fetchInboxMessages.mockResolvedValue(
      inboxRsp([[1, minimalInboxMessage({ timestamp: 100 })]]),
    );
    hoisted.systemSettingsCurrent.mockResolvedValue({
      id: 1,
      rerAnalysisUnitsExactMatchOnlyDefault: false,
      rerDutyTestEnabled: false,
      rerDutyInsertHistoricalInterceptions: false,
      rerDutyTestSinceMs: 0,
      rerDutyTestLimit: 1,
      rerDutyPollIntervalSec: 1,
      rerShortUrlEnabled: false,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
      container.remove();
      document.body.innerHTML = '';
    });
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('runs a single get-inbox initial load per feed on mount', async () => {
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };
    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(1);
    expect(apiRef.current?.messageFeeds[0]?.items[0]?.[0]).toBe(1);
    expect(apiRef.current?.messageFeeds[0]?.loading).toBe(false);
  });

  it('preserves a follow generation until cancellation', async () => {
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };
    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
      await flushMicrotasks();
    });

    const firstGeneration = apiRef.current!.beginFollowTail('mf-0');
    expect(apiRef.current!.ensureFollowTail('mf-0')).toBe(firstGeneration);
    apiRef.current!.cancelFollowTail('mf-0');
    expect(apiRef.current!.ensureFollowTail('mf-0')).toBe(firstGeneration + 2);
  });

  it('keeps an empty tail preview from creating a false unread badge loop', async () => {
    const { apiRef, scrollToEnd } = await mountLoadedFeed();
    await act(async () => {
      apiRef.current!.setMessageFeeds((feeds) =>
        feeds.map((feed) => ({ ...feed, readIds: new Set([...feed.readIds, 1]) })),
      );
    });
    apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = false;
    apiRef.current!.physicallyAtBottomByFeedIdRef.current['mf-0'] = false;
    apiRef.current!.cancelFollowTail('mf-0');
    hoisted.fetchInboxCount.mockResolvedValueOnce({ quantity: 1, firstElementTs: null });
    hoisted.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([]));
    await startPoll();
    let feed = apiRef.current!.messageFeeds[0];
    expect(feed.unreadCount).toBe(1);
    expect(feedLoadedUnreadCount(feed)).toBe(0);
    expect(apiRef.current!.confirmedTailPreviewByFeedId['mf-0']).toMatchObject({
      tailId: 1,
      count: 0,
    });
    expect(scrollToEnd).not.toHaveBeenCalled();

    const generation = apiRef.current!.beginFollowTail('mf-0');
    hoisted.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([]));
    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0', {
        nolimit: true,
        scrollToEndAfterLoad: true,
        showLoading: true,
        followGeneration: generation,
      });
    });
    runNextRaf();
    runNextRaf();
    feed = apiRef.current!.messageFeeds[0];
    expect(feed.items.map(([id]) => id)).toEqual([1]);
    expect(feed.unreadCount).toBe(0);
    expect(feedLoadedUnreadCount(feed)).toBe(0);
    expect(apiRef.current!.confirmedTailPreviewByFeedId['mf-0']).toBeUndefined();
    expect(scrollToEnd).toHaveBeenCalledTimes(1);

    apiRef.current!.cancelFollowTail('mf-0');
    apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = false;
    apiRef.current!.physicallyAtBottomByFeedIdRef.current['mf-0'] = false;
    scrollToEnd.mockClear();
    hoisted.fetchInboxCount.mockResolvedValueOnce({ quantity: 1, firstElementTs: null });
    hoisted.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([]));
    await startPoll();
    feed = apiRef.current!.messageFeeds[0];
    expect(feed.unreadCount).toBe(1);
    expect(feedLoadedUnreadCount(feed)).toBe(0);
    expect(apiRef.current!.confirmedTailPreviewByFeedId['mf-0']).toMatchObject({
      tailId: 1,
      count: 0,
    });
    expect(scrollToEnd).not.toHaveBeenCalled();
    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(4);
    expect(
      feedIndicatorUnreadCount(feed, apiRef.current!.confirmedTailPreviewByFeedId['mf-0']),
    ).toBe(0);
  });

  it('confirms newer messages without appending or scrolling while away from bottom', async () => {
    const { apiRef, scrollToEnd } = await mountLoadedFeed();
    await act(async () => {
      apiRef.current!.setMessageFeeds((feeds) =>
        feeds.map((feed) => ({ ...feed, readIds: new Set([...feed.readIds, 1]) })),
      );
    });
    apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = false;
    apiRef.current!.physicallyAtBottomByFeedIdRef.current['mf-0'] = false;
    await act(async () => {
      await flushMicrotasks();
    });
    hoisted.fetchInboxCount.mockResolvedValueOnce({ quantity: 1, firstElementTs: null });
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp([[2, minimalInboxMessage({ timestamp: 200 })]]),
    );
    await startPoll();
    await act(async () => flushMicrotasks());

    expect(hoisted.fetchInboxCount).toHaveBeenCalled();
    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(2);
    const feed = apiRef.current!.messageFeeds[0];
    expect(feed.items.map(([id]) => id)).toEqual([1]);
    expect(feed.readIds).toEqual(new Set([1]));
    expect(feed.unreadCount).toBe(1);
    expect(apiRef.current!.tailAvailabilityByFeedId['mf-0']).toBe('available');
    expect(apiRef.current!.confirmedTailPreviewByFeedId['mf-0']).toMatchObject({
      tailId: 1,
      count: 1,
    });
    expect(apiRef.current!.loadingNewerFeedIds.has('mf-0')).toBe(false);
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it('ignores a preview resolved after an accepted empty newer load', async () => {
    const { apiRef, scrollToEnd } = await mountLoadedFeed();
    const preview = deferred<InboxMessagesRsp>();
    apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = false;
    hoisted.fetchInboxCount.mockResolvedValueOnce({ quantity: 1, firstElementTs: null });
    hoisted.fetchInboxMessages.mockImplementationOnce(() => preview.promise);
    await startPoll();
    const followGeneration = apiRef.current!.beginFollowTail('mf-0');
    hoisted.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([]));
    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0', {
        scrollToEndAfterLoad: true,
        followGeneration,
      });
      preview.resolve(inboxRsp([[2, minimalInboxMessage({ timestamp: 200 })]]));
      await flushMicrotasks();
    });
    expect(apiRef.current!.confirmedTailPreviewByFeedId['mf-0']).toBeUndefined();
    expect(apiRef.current!.messageFeeds[0].items.map(([id]) => id)).toEqual([1]);
    expect(apiRef.current!.messageFeeds[0].readIds).toEqual(new Set([1]));
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it('ignores a preview resolved after filter invalidation', async () => {
    const { apiRef, scrollToEnd } = await mountLoadedFeed();
    const preview = deferred<InboxMessagesRsp>();
    apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = false;
    hoisted.fetchInboxCount.mockResolvedValueOnce({ quantity: 1, firstElementTs: null });
    hoisted.fetchInboxMessages.mockImplementationOnce(() => preview.promise);
    await startPoll();
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp([[3, minimalInboxMessage({ timestamp: 300 })]]),
    );
    await act(async () => {
      apiRef.current!.applyFilter('mf-0', { ...emptyFilter(), groupsSelected: ['g-1'] });
      await flushMicrotasks();
      preview.resolve(inboxRsp([[2, minimalInboxMessage({ timestamp: 200 })]]));
      await flushMicrotasks();
    });
    expect(apiRef.current!.confirmedTailPreviewByFeedId['mf-0']).toBeUndefined();
    expect(apiRef.current!.messageFeeds[0].readIds).toEqual(new Set([3]));
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it('ignores a preview resolved after feed removal', async () => {
    const { apiRef, scrollToEnd } = await mountLoadedFeed();
    const preview = deferred<InboxMessagesRsp>();
    apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = false;
    hoisted.fetchInboxCount.mockResolvedValueOnce({ quantity: 1, firstElementTs: null });
    hoisted.fetchInboxMessages.mockImplementationOnce(() => preview.promise);
    await startPoll();
    await act(async () => {
      apiRef.current!.createMessageFeed();
      await flushMicrotasks();
    });
    await act(async () => {
      apiRef.current!.removeMessageFeed('mf-0');
      preview.resolve(inboxRsp([[2, minimalInboxMessage({ timestamp: 200 })]]));
      await flushMicrotasks();
    });
    expect(apiRef.current!.confirmedTailPreviewByFeedId['mf-0']).toBeUndefined();
    expect(apiRef.current!.messageFeeds.map((feed) => feed.id)).not.toContain('mf-0');
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it('cancels follow while newer messages are pending', async () => {
    const { apiRef, scrollToEnd } = await mountLoadedFeed();
    const generation = apiRef.current!.beginFollowTail('mf-0');
    const newer = deferred<InboxMessagesRsp>();
    hoisted.fetchInboxMessages.mockImplementationOnce(() => newer.promise);

    const load = apiRef.current!.loadFeedNewerMessages('mf-0', {
      scrollToEndAfterLoad: true,
      followGeneration: generation,
    });
    apiRef.current!.cancelFollowTail('mf-0');
    await act(async () => {
      newer.resolve(inboxRsp([[2, minimalInboxMessage({ timestamp: 200 })]]));
      await load;
      await flushMicrotasks();
    });

    expect(apiRef.current!.messageFeeds[0].items.map(([id]) => id)).toEqual([1, 2]);
    expect(apiRef.current!.messageFeeds[0].readIds.has(2)).toBe(false);
    runNextRaf();
    runNextRaf();
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it('cancels follow while unread count is pending', async () => {
    const { apiRef, scrollToEnd } = await mountLoadedFeed();
    apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = true;
    apiRef.current!.physicallyAtBottomByFeedIdRef.current['mf-0'] = true;
    const generation = apiRef.current!.beginFollowTail('mf-0');
    const count = deferred<{ quantity: number; firstElementTs: number | null }>();
    hoisted.fetchInboxCount.mockImplementationOnce(() => count.promise);

    await startPoll();
    expect(hoisted.fetchInboxCount).toHaveBeenCalledTimes(1);
    apiRef.current!.cancelFollowTail('mf-0');
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp([[2, minimalInboxMessage({ timestamp: 200 })]]),
    );
    await act(async () => {
      count.resolve({ quantity: 1, firstElementTs: null });
      await flushMicrotasks();
    });

    expect(apiRef.current!.messageFeeds[0].items.map(([id]) => id)).toEqual([1, 2]);
    expect(apiRef.current!.messageFeeds[0].readIds.has(2)).toBe(false);
    expect(apiRef.current!.messageFeeds[0].unreadCount).toBeGreaterThan(0);
    expect(generation).toBeGreaterThan(0);
    runNextRaf();
    runNextRaf();
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it('does not scroll when follow is cancelled before the first RAF', async () => {
    const { apiRef, scrollToEnd } = await mountLoadedFeed();
    const generation = apiRef.current!.beginFollowTail('mf-0');
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp([[2, minimalInboxMessage({ timestamp: 200 })]]),
    );

    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0', {
        scrollToEndAfterLoad: true,
        followGeneration: generation,
      });
      await flushMicrotasks();
    });
    apiRef.current!.cancelFollowTail('mf-0');
    runNextRaf();
    runNextRaf();
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it('does not scroll when follow is cancelled between the two RAFs', async () => {
    const { apiRef, scrollToEnd } = await mountLoadedFeed();
    const generation = apiRef.current!.beginFollowTail('mf-0');
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp([[2, minimalInboxMessage({ timestamp: 200 })]]),
    );

    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0', {
        scrollToEndAfterLoad: true,
        followGeneration: generation,
      });
      await flushMicrotasks();
    });
    expect(rafCallbacks).toHaveLength(1);
    runNextRaf();
    apiRef.current!.cancelFollowTail('mf-0');
    runNextRaf();
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it('does not let an obsolete RAF suppress a newer follow generation', async () => {
    const { apiRef, scrollToEnd } = await mountLoadedFeed();
    const firstGeneration = apiRef.current!.beginFollowTail('mf-0');
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp([[2, minimalInboxMessage({ timestamp: 200 })]]),
    );
    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0', {
        scrollToEndAfterLoad: true,
        followGeneration: firstGeneration,
      });
      await flushMicrotasks();
    });
    runNextRaf();

    apiRef.current!.cancelFollowTail('mf-0');
    const secondGeneration = apiRef.current!.beginFollowTail('mf-0');
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp([[3, minimalInboxMessage({ timestamp: 300 })]]),
    );
    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0', {
        scrollToEndAfterLoad: true,
        followGeneration: secondGeneration,
      });
      await flushMicrotasks();
    });

    runNextRaf();
    runNextRaf();
    runNextRaf();
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
    expect(scrollToEnd).toHaveBeenCalledWith('auto');
  });

  it('runs an explicit follow pin with continuous auto-scroll disabled', async () => {
    const { apiRef, scrollToEnd } = await mountLoadedFeed(true);
    const generation = apiRef.current!.beginFollowTail('mf-0');
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp([[2, minimalInboxMessage({ timestamp: 200 })]]),
    );

    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0', {
        scrollToEndAfterLoad: true,
        followGeneration: generation,
      });
      await flushMicrotasks();
    });
    runNextRaf();
    runNextRaf();
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it('restores available after a confirmed-tail request fails', async () => {
    const { apiRef } = await mountLoadedFeed();
    const newer = deferred<InboxMessagesRsp>();
    hoisted.fetchInboxMessages.mockImplementationOnce(() => newer.promise);

    let load!: Promise<void>;
    await act(async () => {
      load = apiRef.current!.loadFeedNewerMessages('mf-0', {
        showLoading: false,
        confirmedTailAvailable: true,
      });
      await flushMicrotasks();
    });
    expect(apiRef.current!.tailAvailabilityByFeedId['mf-0']).toBe('loading');

    await act(async () => {
      newer.reject(new Error('network down'));
      await load;
      await flushMicrotasks();
    });
    expect(apiRef.current!.tailAvailabilityByFeedId['mf-0']).toBe('available');
  });

  it('does not expose a blind background failure as available tail content', async () => {
    const { apiRef } = await mountLoadedFeed();
    const newer = deferred<InboxMessagesRsp>();
    hoisted.fetchInboxMessages.mockImplementationOnce(() => newer.promise);

    const load = apiRef.current!.loadFeedNewerMessages('mf-0', {
      showLoading: false,
      confirmedTailAvailable: false,
    });
    await act(async () => {
      newer.reject(new Error('network down'));
      await load;
      await flushMicrotasks();
    });
    expect(apiRef.current!.tailAvailabilityByFeedId['mf-0'] ?? 'unknown').toBe('unknown');
  });

  it('keeps confirmed tail available when tail count resolves after leaving bottom', async () => {
    const { apiRef, scrollToEnd } = await mountLoadedFeed();
    hoisted.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([]));
    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0');
      await flushMicrotasks();
    });
    expect(apiRef.current!.tailAvailabilityByFeedId['mf-0']).toBe('exhausted');

    apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = true;
    const tailCount = deferred<{ quantity: number; firstElementTs: number | null }>();
    hoisted.fetchInboxCount
      .mockResolvedValueOnce({ quantity: 1, firstElementTs: null })
      .mockImplementationOnce(() => tailCount.promise);
    await startPoll();
    expect(hoisted.fetchInboxCount).toHaveBeenCalledTimes(2);
    expect(apiRef.current!.tailAvailabilityByFeedId['mf-0']).toBe('checking');

    apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = false;
    await act(async () => {
      tailCount.resolve({ quantity: 1, firstElementTs: null });
      await flushMicrotasks();
    });
    expect(apiRef.current!.tailAvailabilityByFeedId['mf-0']).toBe('available');
    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(2);
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it('loads available tail content after returning near bottom', async () => {
    const { apiRef } = await mountLoadedFeed();
    const failedConfirmation = deferred<InboxMessagesRsp>();
    hoisted.fetchInboxMessages.mockImplementationOnce(() => failedConfirmation.promise);
    const failedLoad = apiRef.current!.loadFeedNewerMessages('mf-0', {
      showLoading: false,
      confirmedTailAvailable: true,
    });
    await act(async () => {
      failedConfirmation.reject(new Error('temporary failure'));
      await failedLoad;
      await flushMicrotasks();
    });
    expect(apiRef.current!.tailAvailabilityByFeedId['mf-0']).toBe('available');

    apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = true;
    hoisted.fetchInboxCount.mockResolvedValueOnce({ quantity: 1, firstElementTs: null });
    const newer = deferred<InboxMessagesRsp>();
    hoisted.fetchInboxMessages.mockImplementationOnce(() => newer.promise);
    await startPoll();
    expect(apiRef.current!.tailAvailabilityByFeedId['mf-0']).toBe('loading');
    await act(async () => {
      newer.resolve(inboxRsp([[2, minimalInboxMessage({ timestamp: 200 })]]));
      await flushMicrotasks();
    });
    expect(apiRef.current!.messageFeeds[0].items.map(([id]) => id)).toEqual([1, 2]);
    expect(apiRef.current!.tailAvailabilityByFeedId['mf-0']).toBe('unknown');
  });

  it('marks an available tail exhausted when retry returns no messages', async () => {
    const { apiRef } = await mountLoadedFeed();
    const failedConfirmation = deferred<InboxMessagesRsp>();
    hoisted.fetchInboxMessages.mockImplementationOnce(() => failedConfirmation.promise);
    const failedLoad = apiRef.current!.loadFeedNewerMessages('mf-0', {
      showLoading: false,
      confirmedTailAvailable: true,
    });
    await act(async () => {
      failedConfirmation.reject(new Error('temporary failure'));
      await failedLoad;
      await flushMicrotasks();
    });
    apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = true;
    hoisted.fetchInboxCount.mockResolvedValueOnce({ quantity: 1, firstElementTs: null });
    const newer = deferred<InboxMessagesRsp>();
    hoisted.fetchInboxMessages.mockImplementationOnce(() => newer.promise);
    await startPoll();
    expect(apiRef.current!.tailAvailabilityByFeedId['mf-0']).toBe('loading');
    await act(async () => {
      newer.resolve(inboxRsp([]));
      await flushMicrotasks();
    });
    expect(apiRef.current!.messageFeeds[0].items.map(([id]) => id)).toEqual([1]);
    expect(apiRef.current!.tailAvailabilityByFeedId['mf-0']).toBe('exhausted');
  });

  it('preserves exhausted state after a blind background failure', async () => {
    const { apiRef } = await mountLoadedFeed();
    hoisted.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([]));
    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0');
      await flushMicrotasks();
    });
    const newer = deferred<InboxMessagesRsp>();
    hoisted.fetchInboxMessages.mockImplementationOnce(() => newer.promise);
    const load = apiRef.current!.loadFeedNewerMessages('mf-0', {
      showLoading: false,
      confirmedTailAvailable: false,
    });
    await act(async () => {
      newer.reject(new Error('network down'));
      await load;
      await flushMicrotasks();
    });
    expect(apiRef.current!.tailAvailabilityByFeedId['mf-0']).toBe('exhausted');
  });

  it('ignores a confirmed-tail failure after filter invalidation', async () => {
    const { apiRef } = await mountLoadedFeed();
    const staleNewer = deferred<InboxMessagesRsp>();
    const reload = deferred<InboxMessagesRsp>();
    hoisted.fetchInboxMessages
      .mockImplementationOnce(() => staleNewer.promise)
      .mockImplementationOnce(() => reload.promise);
    const staleLoad = apiRef.current!.loadFeedNewerMessages('mf-0', {
      showLoading: false,
      confirmedTailAvailable: true,
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(apiRef.current!.tailAvailabilityByFeedId['mf-0']).toBe('loading');
    await act(async () => {
      apiRef.current!.applyFilter('mf-0', {
        ...emptyFilter(),
        groupsSelected: ['replacement-filter'],
      });
      await flushMicrotasks();
    });
    expect(apiRef.current!.tailAvailabilityByFeedId['mf-0']).toBe('unknown');
    await act(async () => {
      staleNewer.reject(new Error('stale failure'));
      await staleLoad;
      await flushMicrotasks();
    });
    expect(apiRef.current!.tailAvailabilityByFeedId['mf-0']).toBe('unknown');
    await act(async () => {
      reload.resolve(inboxRsp([[3, minimalInboxMessage({ timestamp: 300 })]]));
      await flushMicrotasks();
    });
    expect(apiRef.current!.tailAvailabilityByFeedId['mf-0']).not.toBe('available');
  });

  it('upgrades an in-flight blind request when confirmed availability coalesces', async () => {
    const { apiRef } = await mountLoadedFeed();
    const newer = deferred<InboxMessagesRsp>();
    hoisted.fetchInboxMessages.mockImplementationOnce(() => newer.promise);

    let blind!: Promise<void>;
    let confirmed!: Promise<void>;
    await act(async () => {
      blind = apiRef.current!.loadFeedNewerMessages('mf-0', { showLoading: false });
      confirmed = apiRef.current!.loadFeedNewerMessages('mf-0', {
        showLoading: false,
        confirmedTailAvailable: true,
      });
      await flushMicrotasks();
    });
    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(2);
    expect(apiRef.current!.tailAvailabilityByFeedId['mf-0']).toBe('loading');

    await act(async () => {
      newer.reject(new Error('network down'));
      await Promise.all([blind, confirmed]);
      await flushMicrotasks();
    });
    expect(apiRef.current!.tailAvailabilityByFeedId['mf-0']).toBe('available');
  });

  it('reloads a settled empty feed through the initial-load effect', async () => {
    hoisted.fetchInboxMessages
      .mockResolvedValueOnce(inboxRsp([]))
      .mockResolvedValueOnce(inboxRsp([[7, minimalInboxMessage({ timestamp: 700 })]]));
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => root.render(<TestHarness apiRef={apiRef} />));
    await act(async () => flushMicrotasks());
    expect(apiRef.current?.messageFeeds[0]?.items).toHaveLength(0);

    await act(async () => apiRef.current?.reloadEmptyFeeds());
    await act(async () => flushMicrotasks());

    expect(apiRef.current?.messageFeeds[0]?.items.map(([id]) => id)).toEqual([7]);
    expect(apiRef.current?.messageFeeds[0]?.loading).toBe(false);
    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(2);
  });

  it('reloads all empty feeds without reloading non-empty feeds', async () => {
    window.history.replaceState(
      {},
      '',
      '/?state=' +
        encodeURIComponent(
          JSON.stringify({
            messageFeeds: [
              ['mf-0', { ...emptyFilter(), groupsSelected: ['group-0'] }],
              ['mf-1', { ...emptyFilter(), groupsSelected: ['group-1'] }],
              ['mf-2', { ...emptyFilter(), groupsSelected: ['group-2'] }],
            ],
          }),
        ),
    );
    hoisted.fetchInboxMessages.mockImplementation((request: any) => {
      const group = request.selectedGroups?.[0];
      if (group === 'group-0')
        return Promise.resolve(inboxRsp([[1, minimalInboxMessage({ timestamp: 100 })]]));
      if (group === 'group-1') return Promise.resolve(inboxRsp([]));
      if (group === 'group-2') return Promise.resolve(inboxRsp([]));
      throw new Error(`Unexpected group ${group}`);
    });
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => root.render(<TestHarness apiRef={apiRef} />));
    await act(async () => flushMicrotasks());
    hoisted.fetchInboxMessages.mockClear();
    hoisted.fetchInboxMessages.mockImplementation((request: any) => {
      const group = request.selectedGroups?.[0];
      if (group === 'group-1')
        return Promise.resolve(inboxRsp([[8, minimalInboxMessage({ timestamp: 800 })]]));
      if (group === 'group-2')
        return Promise.resolve(inboxRsp([[9, minimalInboxMessage({ timestamp: 900 })]]));
      throw new Error(`Unexpected reload group ${group}`);
    });

    await act(async () => apiRef.current?.reloadEmptyFeeds());
    await act(async () => flushMicrotasks());

    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(2);
    expect(
      hoisted.fetchInboxMessages.mock.calls.map(([request]) => request.selectedGroups),
    ).toEqual(expect.arrayContaining([['group-1'], ['group-2']]));
    expect(apiRef.current?.messageFeeds.map((feed) => feed.items.map(([id]) => id))).toEqual([
      [1],
      [8],
      [9],
    ]);
    expect(apiRef.current?.messageFeeds.every((feed) => feed.loading === false)).toBe(true);
    expect(apiRef.current?.error).toBeNull();
  });

  it('invalidates a stale empty-feed initial response during reload', async () => {
    const stale = deferred<InboxMessagesRsp>();
    const fresh = deferred<InboxMessagesRsp>();
    hoisted.fetchInboxMessages
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => fresh.promise);
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => root.render(<TestHarness apiRef={apiRef} />));
    await act(async () => flushMicrotasks());
    await act(async () => apiRef.current?.reloadEmptyFeeds());
    await act(async () => flushMicrotasks());

    fresh.resolve(inboxRsp([[9, minimalInboxMessage({ timestamp: 900 })]]));
    await act(async () => flushMicrotasks());
    stale.resolve(inboxRsp([]));
    await act(async () => flushMicrotasks());

    expect(apiRef.current?.messageFeeds[0]?.items.map(([id]) => id)).toEqual([9]);
    expect(apiRef.current?.error).toBeNull();
  });

  it('clears loading and surfaces an empty-feed reload failure', async () => {
    hoisted.fetchInboxMessages
      .mockResolvedValueOnce(inboxRsp([]))
      .mockRejectedValueOnce(new Error('empty feed reload failed'));
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => root.render(<TestHarness apiRef={apiRef} />));
    await act(async () => flushMicrotasks());
    await act(async () => apiRef.current?.reloadEmptyFeeds());
    await act(async () => flushMicrotasks());

    expect(apiRef.current?.messageFeeds[0]?.loading).toBe(false);
    expect(apiRef.current?.error).toBe('empty feed reload failed');
  });

  it('sets error and clears loading when initial get-inbox fails', async () => {
    hoisted.fetchInboxMessages.mockRejectedValueOnce(new Error('network down'));

    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };
    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(apiRef.current?.error).toBe('network down');
    expect(apiRef.current?.messageFeeds[0]?.loading).toBe(false);
    expect(apiRef.current?.messageFeeds[0]?.items).toHaveLength(0);
  });

  it('keeps existing items visible while a filter reload is pending', async () => {
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };
    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(apiRef.current?.messageFeeds[0]?.items.map(([id]) => id)).toEqual([1]);

    let resolveReload: (value: InboxMessagesRsp) => void = () => {};
    hoisted.fetchInboxMessages.mockImplementationOnce(
      () =>
        new Promise<InboxMessagesRsp>((resolve) => {
          resolveReload = resolve;
        }),
    );

    await act(async () => {
      apiRef.current!.applyFilter('mf-0', { ...emptyFilter(), groupsSelected: ['g-1'] });
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(apiRef.current?.messageFeeds[0]?.loading).toBe(true);
    expect(apiRef.current?.messageFeeds[0]?.items.map(([id]) => id)).toEqual([1]);

    await act(async () => {
      resolveReload(inboxRsp([[2, minimalInboxMessage({ timestamp: 200, text: 'reloaded' })]]));
      await flushMicrotasks();
    });

    expect(apiRef.current?.messageFeeds[0]?.loading).toBe(false);
    expect(apiRef.current?.messageFeeds[0]?.items.map(([id]) => id)).toEqual([2]);
  });

  it('updates unreadCount from poll when count > 0 and column has items', async () => {
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };
    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(apiRef.current?.messageFeeds[0]?.unreadCount).toBe(0);

    hoisted.fetchInboxCount.mockResolvedValue({ quantity: 4, firstElementTs: null });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(apiRef.current?.messageFeeds[0]?.unreadCount).toBe(4);
    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(2);
  });

  it('does not inflate unreadCount from a poll when the feed has no loaded items', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([]));

    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };
    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(apiRef.current?.messageFeeds[0]?.items).toHaveLength(0);

    hoisted.fetchInboxCount.mockResolvedValue({ quantity: 70000, firstElementTs: null });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(apiRef.current?.messageFeeds[0]?.unreadCount).toBe(0);
  });

  it('uses the last message id as the count cursor even when the timestamp is null', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp([[10, minimalInboxMessage({ timestamp: null })]]),
    );

    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };
    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    hoisted.fetchInboxCount.mockResolvedValue({ quantity: 70000, firstElementTs: null });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(hoisted.fetchInboxCount).toHaveBeenCalledTimes(1);
    expect(hoisted.fetchInboxCount.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        sinceIdNoninclusive: 10,
        sinceDateInclusiveMs: null,
        nolimit: true,
      }),
    );
    expect(apiRef.current?.messageFeeds[0]?.unreadCount).toBe(70000);
  });

  it('calls get-inbox again when poll sees new mail and column is near bottom', async () => {
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };
    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp([[2, minimalInboxMessage({ timestamp: 200, text: 'newer' })]]),
    );

    await act(async () => {
      apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = true;
    });

    hoisted.fetchInboxCount.mockResolvedValue({ quantity: 1, firstElementTs: null });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(2);
    const ids = apiRef.current!.messageFeeds[0].items.map(([id]) => id).sort((a, b) => a - b);
    expect(ids).toEqual([1, 2]);
  });

  it('calls get-inbox for newer mail when the feed is near bottom', async () => {
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };
    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp([[3, minimalInboxMessage({ timestamp: 300 })]]),
    );
    hoisted.fetchInboxCount.mockResolvedValue({ quantity: 1, firstElementTs: null });

    await act(async () => {
      apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = true;
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(2);
    expect(apiRef.current!.messageFeeds[0].items.map(([id]) => id).sort()).toEqual([1, 3]);
  });

  it('preserves a larger server unreadCount when appending a partially loaded newer batch', async () => {
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };
    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    hoisted.fetchInboxCount.mockResolvedValue({ quantity: 70000, firstElementTs: null });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(apiRef.current?.messageFeeds[0]?.unreadCount).toBe(70000);

    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: 20 }, (_, index) => [
          2 + index,
          minimalInboxMessage({ timestamp: 200 + index, text: `new-${index}` }),
        ]),
      ),
    );

    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0');
    });

    expect(apiRef.current?.messageFeeds[0]?.items).toHaveLength(21);
    expect(apiRef.current?.messageFeeds[0]?.unreadCount).toBe(70000);
  });

  it('keeps unread polling on the stable cursor when older paging trims the window', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: DUTY_FEED_MESSAGE_WINDOW_LIMIT }, (_, index) => [
          index + 21,
          minimalInboxMessage({ timestamp: (index + 21) * 100 }),
        ]),
      ),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    hoisted.fetchInboxCount.mockImplementation(async (req: any) => ({
      quantity: req.sinceIdNoninclusive === 60 ? 5 : req.sinceIdNoninclusive === 40 ? 25 : 0,
      firstElementTs: null,
    }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(hoisted.fetchInboxCount.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ sinceIdNoninclusive: 60 }),
    );
    expect(apiRef.current?.messageFeeds[0]?.unreadCount).toBe(5);
    hoisted.notifyDutyNewMessages.mockReset();

    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: 20 }, (_, index) => [
          index + 1,
          minimalInboxMessage({ timestamp: (index + 1) * 100 }),
        ]),
      ),
    );
    await act(async () => {
      await apiRef.current!.loadFeedOlderMessages('mf-0');
    });

    expect(apiRef.current!.messageFeeds[0].items.at(-1)?.[0]).toBe(40);
    expect(apiRef.current!.messageFeeds[0].unreadCount).toBe(5);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(hoisted.fetchInboxCount.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ sinceIdNoninclusive: 60 }),
    );
    expect(apiRef.current?.messageFeeds[0]?.unreadCount).toBe(5);
    hoisted.notifyDutyNewMessages.mockReset();
  });

  it('applies each feed count immediately even while another feed poll is still pending', async () => {
    window.history.replaceState(
      {},
      '',
      '/?state=' +
        encodeURIComponent(
          JSON.stringify({
            messageFeeds: [
              ['mf-0', emptyFilter()],
              ['mf-1', emptyFilter()],
            ],
          }),
        ),
    );
    hoisted.fetchInboxMessages
      .mockResolvedValueOnce(
        inboxRsp(
          Array.from({ length: DUTY_FEED_MESSAGE_WINDOW_LIMIT }, (_, index) => [
            index + 21,
            minimalInboxMessage({ timestamp: (index + 21) * 100 }),
          ]),
        ),
      )
      .mockResolvedValueOnce(
        inboxRsp(
          Array.from({ length: DUTY_FEED_MESSAGE_WINDOW_LIMIT }, (_, index) => [
            index + 121,
            minimalInboxMessage({ timestamp: (index + 121) * 100 }),
          ]),
        ),
      );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    const feedA = deferred<{ quantity: number; firstElementTs: number | null }>();
    const feedB = deferred<{ quantity: number; firstElementTs: number | null }>();
    hoisted.fetchInboxCount.mockReset();
    hoisted.fetchInboxCount.mockImplementation((req: any) => {
      if (req.sinceIdNoninclusive === 60) return feedA.promise;
      if (req.sinceIdNoninclusive === 140) return feedB.promise;
      return Promise.resolve({ quantity: 0, firstElementTs: null });
    });

    const feedAResult = apiRef.current!.requestValidatedInboxCount('mf-0');
    const feedBResult = apiRef.current!.requestValidatedInboxCount('mf-1');

    await act(async () => {
      feedA.resolve({ quantity: 5, firstElementTs: null });
      await flushMicrotasks();
    });

    await act(async () => {
      feedB.resolve({ quantity: 0, firstElementTs: null });
      await flushMicrotasks();
    });

    await expect(feedAResult).resolves.toEqual(
      expect.objectContaining({ feedId: 'mf-0', quantity: 5 }),
    );
    await expect(feedBResult).resolves.toEqual(
      expect.objectContaining({ feedId: 'mf-1', quantity: 0 }),
    );
  });

  it('shares one count request per feed across concurrent callers', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: DUTY_FEED_MESSAGE_WINDOW_LIMIT }, (_, index) => [
          index + 21,
          minimalInboxMessage({ timestamp: (index + 21) * 100 }),
        ]),
      ),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    const count = deferred<{ quantity: number; firstElementTs: number | null }>();
    hoisted.fetchInboxCount.mockReset();
    hoisted.fetchInboxCount.mockReturnValue(count.promise);

    const first = apiRef.current!.requestValidatedInboxCount('mf-0');
    const second = apiRef.current!.requestValidatedInboxCount('mf-0');

    expect(first).toBe(second);
    expect(hoisted.fetchInboxCount).toHaveBeenCalledTimes(1);

    await act(async () => {
      count.resolve({ quantity: 5, firstElementTs: null });
      await flushMicrotasks();
    });

    await expect(first).resolves.toEqual(
      expect.objectContaining({ feedId: 'mf-0', quantity: 5, cursorId: 60 }),
    );
    await expect(second).resolves.toEqual(
      expect.objectContaining({ feedId: 'mf-0', quantity: 5, cursorId: 60 }),
    );
  });

  it('does not poll while a reload is pending and resumes with the reloaded cursor', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: DUTY_FEED_MESSAGE_WINDOW_LIMIT }, (_, index) => [
          index + 21,
          minimalInboxMessage({ timestamp: (index + 21) * 100 }),
        ]),
      ),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    let resolveReload: (value: InboxMessagesRsp) => void = () => {};
    hoisted.fetchInboxMessages.mockImplementationOnce(
      () =>
        new Promise<InboxMessagesRsp>((resolve) => {
          resolveReload = resolve;
        }),
    );

    await act(async () => {
      apiRef.current!.applyFilter('mf-0', { ...emptyFilter(), groupsSelected: ['g-1'] });
    });
    await act(async () => {
      await flushMicrotasks();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(hoisted.fetchInboxCount).not.toHaveBeenCalled();

    await act(async () => {
      resolveReload(
        inboxRsp(
          Array.from({ length: DUTY_FEED_MESSAGE_WINDOW_LIMIT }, (_, index) => [
            index + 101,
            minimalInboxMessage({ timestamp: (index + 101) * 100 }),
          ]),
        ),
      );
      await flushMicrotasks();
    });

    hoisted.fetchInboxCount.mockResolvedValue({ quantity: 1, firstElementTs: null });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(hoisted.fetchInboxCount.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ sinceIdNoninclusive: 140 }),
    );
  });

  it('ignores a stale in-flight count response after filter reload', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: DUTY_FEED_MESSAGE_WINDOW_LIMIT }, (_, index) => [
          index + 21,
          minimalInboxMessage({ timestamp: (index + 21) * 100 }),
        ]),
      ),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    await act(async () => {
      apiRef.current!.setWatchModeByFeedId((prev) => ({ ...prev, 'mf-0': true }));
      apiRef.current!.atBottomByFeedIdRef.current['mf-0'] = true;
    });

    const countResponse = deferred<{ quantity: number; firstElementTs: number | null }>();
    hoisted.fetchInboxCount.mockReturnValueOnce(countResponse.promise);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    let resolveReload: (value: InboxMessagesRsp) => void = () => {};
    hoisted.fetchInboxMessages.mockImplementationOnce(
      () =>
        new Promise<InboxMessagesRsp>((resolve) => {
          resolveReload = resolve;
        }),
    );

    await act(async () => {
      apiRef.current!.applyFilter('mf-0', { ...emptyFilter(), groupsSelected: ['g-1'] });
    });
    await act(async () => {
      await flushMicrotasks();
    });

    await act(async () => {
      resolveReload(
        inboxRsp(
          Array.from({ length: DUTY_FEED_MESSAGE_WINDOW_LIMIT }, (_, index) => [
            index + 101,
            minimalInboxMessage({ timestamp: (index + 101) * 100 }),
          ]),
        ),
      );
      await flushMicrotasks();
    });

    await act(async () => {
      countResponse.resolve({ quantity: 999, firstElementTs: null });
      await flushMicrotasks();
    });

    expect(hoisted.notifyDutyNewMessages).not.toHaveBeenCalled();
    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(2);
    expect(apiRef.current?.messageFeeds[0]?.unreadCount).toBe(0);
  });

  it('releases the pending reload marker after a failed reload and resumes count requests from the retained cursor', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: 10 }, (_, index) => [
          index + 1,
          minimalInboxMessage({ timestamp: (index + 1) * 100 }),
        ]),
      ),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    hoisted.fetchInboxMessages.mockRejectedValueOnce(new Error('reload failed'));
    await act(async () => {
      apiRef.current!.applyFilter('mf-0', { ...emptyFilter(), groupsSelected: ['g-1'] });
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(apiRef.current?.error).toBe('reload failed');

    expect(apiRef.current?.messageFeeds[0]?.loading).toBe(false);
    expect(apiRef.current?.messageFeeds[0]?.items.at(-1)?.[0]).toBe(10);

    hoisted.fetchInboxCount.mockResolvedValueOnce({ quantity: 7, firstElementTs: null });
    const countResultPromise = apiRef.current!.requestValidatedInboxCount('mf-0');
    await act(async () => {
      await countResultPromise;
    });
    const countResult = await countResultPromise;

    expect(countResult).toEqual(
      expect.objectContaining({ feedId: 'mf-0', quantity: 7, cursorId: 10, hasItems: true }),
    );
    expect(hoisted.fetchInboxCount).toHaveBeenCalledTimes(1);
    expect(hoisted.fetchInboxCount.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ sinceIdNoninclusive: 10 }),
    );
  });

  it('keeps a stale failure from releasing a newer pending reload', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: 10 }, (_, index) => [
          index + 1,
          minimalInboxMessage({ timestamp: (index + 1) * 100 }),
        ]),
      ),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    const reloadA = deferred<InboxMessagesRsp>();
    const reloadB = deferred<InboxMessagesRsp>();
    hoisted.fetchInboxMessages
      .mockImplementationOnce(() => reloadA.promise)
      .mockImplementationOnce(() => reloadB.promise);

    await act(async () => {
      apiRef.current!.applyFilter('mf-0', { ...emptyFilter(), groupsSelected: ['g-1'] });
    });
    await act(async () => {
      apiRef.current!.applyFilter('mf-0', { ...emptyFilter(), groupsSelected: ['g-2'] });
    });
    await act(async () => {
      await flushMicrotasks();
    });

    await act(async () => {
      reloadA.reject(new Error('reload A failed'));
      await flushMicrotasks();
    });

    const blockedResultPromise = apiRef.current!.requestValidatedInboxCount('mf-0');
    await act(async () => {
      await blockedResultPromise;
    });
    const blockedResult = await blockedResultPromise;
    expect(blockedResult).toBeNull();
    expect(hoisted.fetchInboxCount).not.toHaveBeenCalled();

    await act(async () => {
      reloadB.resolve(
        inboxRsp(
          Array.from({ length: 10 }, (_, index) => [
            index + 101,
            minimalInboxMessage({ timestamp: (index + 101) * 100 }),
          ]),
        ),
      );
      await flushMicrotasks();
    });

    expect(apiRef.current?.messageFeeds[0]?.items.at(-1)?.[0]).toBe(110);

    hoisted.fetchInboxCount.mockResolvedValueOnce({ quantity: 2, firstElementTs: null });
    const resumedResultPromise = apiRef.current!.requestValidatedInboxCount('mf-0');
    await act(async () => {
      await resumedResultPromise;
    });
    const resumedResult = await resumedResultPromise;
    expect(resumedResult).toEqual(
      expect.objectContaining({ feedId: 'mf-0', quantity: 2, cursorId: 110, hasItems: true }),
    );
    expect(hoisted.fetchInboxCount).toHaveBeenCalledTimes(1);
    expect(hoisted.fetchInboxCount.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ sinceIdNoninclusive: 110 }),
    );
  });

  it('allows a failed initial load to be retried successfully', async () => {
    hoisted.fetchInboxMessages.mockRejectedValueOnce(new Error('initial load failed'));
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(apiRef.current?.messageFeeds[0]?.items).toHaveLength(0);
    expect(apiRef.current?.messageFeeds[0]?.loading).toBe(false);
    expect(apiRef.current?.error).toBe('initial load failed');

    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp([[10, minimalInboxMessage({ timestamp: 1000 })]]),
    );
    await act(async () => {
      await apiRef.current!.loadFeedInitialMessages('mf-0');
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(apiRef.current?.messageFeeds[0]?.items.at(-1)?.[0]).toBe(10);
    expect(apiRef.current?.messageFeeds[0]?.loading).toBe(false);
  });

  it('notifies exactly once when the count genuinely increases and ignores repeats', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: DUTY_FEED_MESSAGE_WINDOW_LIMIT }, (_, index) => [
          index + 21,
          minimalInboxMessage({ timestamp: (index + 21) * 100 }),
        ]),
      ),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    let pollCount = 0;
    hoisted.fetchInboxCount.mockImplementation(async (req: any) => ({
      quantity: req.sinceIdNoninclusive === 60 ? (pollCount++ === 0 ? 5 : 7) : 0,
      firstElementTs: null,
    }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(apiRef.current?.messageFeeds[0]?.unreadCount).toBe(5);
    hoisted.notifyDutyNewMessages.mockReset();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(apiRef.current?.messageFeeds[0]?.unreadCount).toBe(7);
    expect(hoisted.notifyDutyNewMessages).toHaveBeenCalledTimes(1);
    expect(hoisted.notifyDutyNewMessages).toHaveBeenLastCalledWith('mf-0', 2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(apiRef.current?.messageFeeds[0]?.unreadCount).toBe(7);
    expect(hoisted.notifyDutyNewMessages).toHaveBeenCalledTimes(1);
  });

  it('preserves the unread baseline when a count poll fails', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: DUTY_FEED_MESSAGE_WINDOW_LIMIT }, (_, index) => [
          index + 21,
          minimalInboxMessage({ timestamp: (index + 21) * 100 }),
        ]),
      ),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    hoisted.fetchInboxCount.mockResolvedValueOnce({ quantity: 5, firstElementTs: null });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(apiRef.current?.messageFeeds[0]?.unreadCount).toBe(5);
    hoisted.notifyDutyNewMessages.mockReset();

    hoisted.fetchInboxCount.mockRejectedValueOnce(new Error('count failed'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(apiRef.current?.messageFeeds[0]?.unreadCount).toBe(5);
    expect(hoisted.notifyDutyNewMessages).not.toHaveBeenCalled();

    hoisted.fetchInboxCount.mockResolvedValueOnce({ quantity: 5, firstElementTs: null });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(hoisted.notifyDutyNewMessages).not.toHaveBeenCalled();
  });

  it('keeps empty feeds from notifying even when count responses are positive', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([]));

    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(apiRef.current?.messageFeeds[0]?.items).toHaveLength(0);

    hoisted.fetchInboxCount.mockResolvedValueOnce({ quantity: 5, firstElementTs: null });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(hoisted.notifyDutyNewMessages).not.toHaveBeenCalled();

    hoisted.fetchInboxCount.mockResolvedValueOnce({ quantity: 9, firstElementTs: null });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(hoisted.notifyDutyNewMessages).not.toHaveBeenCalled();
    expect(apiRef.current?.messageFeeds[0]?.items).toHaveLength(0);
    expect(apiRef.current?.messageFeeds[0]?.unreadCount).toBe(0);
  });

  it('treats a changed count signature as a fresh baseline and discards stale in-flight counts', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: DUTY_FEED_MESSAGE_WINDOW_LIMIT }, (_, index) => [
          index + 21,
          minimalInboxMessage({ timestamp: (index + 21) * 100 }),
        ]),
      ),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    hoisted.fetchInboxCount.mockResolvedValueOnce({ quantity: 5, firstElementTs: null });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(apiRef.current?.messageFeeds[0]?.unreadCount).toBe(5);
    hoisted.notifyDutyNewMessages.mockReset();

    const staleCount = deferred<{ quantity: number; firstElementTs: number | null }>();
    hoisted.fetchInboxCount.mockReturnValueOnce(staleCount.promise);
    const stalePromise = apiRef.current!.requestValidatedInboxCount('mf-0');

    await act(async () => {
      apiRef.current!.setMessageFeeds((prev) =>
        prev.map((feed) => (feed.id === 'mf-0' ? { ...feed, adjacentFreqsRange: 2 } : feed)),
      );
      await flushMicrotasks();
    });

    await act(async () => {
      staleCount.resolve({ quantity: 9, firstElementTs: null });
      await flushMicrotasks();
    });

    await expect(stalePromise).resolves.toBeNull();
    expect(hoisted.notifyDutyNewMessages).not.toHaveBeenCalled();

    hoisted.fetchInboxCount.mockResolvedValueOnce({ quantity: 7, firstElementTs: null });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(apiRef.current?.messageFeeds[0]?.unreadCount).toBe(7);
    expect(hoisted.notifyDutyNewMessages).toHaveBeenCalledTimes(1);
    expect(hoisted.notifyDutyNewMessages).toHaveBeenLastCalledWith('mf-0', 7);

    hoisted.notifyDutyNewMessages.mockReset();
    hoisted.fetchInboxCount.mockResolvedValueOnce({ quantity: 9, firstElementTs: null });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(apiRef.current?.messageFeeds[0]?.unreadCount).toBe(9);
    expect(hoisted.notifyDutyNewMessages).toHaveBeenCalledTimes(1);
    expect(hoisted.notifyDutyNewMessages).toHaveBeenLastCalledWith('mf-0', 2);
  });

  it('keeps queued unread updates when loading newer messages and preserves the newest cursor', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: DUTY_FEED_MESSAGE_WINDOW_LIMIT }, (_, index) => [
          index + 21,
          minimalInboxMessage({ timestamp: (index + 21) * 100 }),
        ]),
      ),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    const newerResponse = deferred<InboxMessagesRsp>();
    hoisted.fetchInboxMessages.mockImplementationOnce(() => newerResponse.promise);

    let loadPromise!: Promise<void>;
    act(() => {
      apiRef.current!.setMessageFeeds((prev) =>
        prev.map((feed) => (feed.id === 'mf-0' ? { ...feed, unreadCount: 25 } : feed)),
      );
      loadPromise = apiRef.current!.loadFeedNewerMessages('mf-0');
    });
    await act(async () => {
      newerResponse.resolve(
        inboxRsp(
          Array.from({ length: 20 }, (_, index) => [
            DUTY_FEED_MESSAGE_WINDOW_LIMIT + 20 + index + 1,
            minimalInboxMessage({
              timestamp: (DUTY_FEED_MESSAGE_WINDOW_LIMIT + 20 + index + 1) * 100,
            }),
          ]),
        ),
      );
      await flushMicrotasks();
    });
    await act(async () => {
      await loadPromise;
    });

    const feedAfterAppend = apiRef.current!.messageFeeds[0];
    expect(feedAfterAppend.items.at(-1)?.[0]).toBe(80);
    expect(feedAfterAppend.unreadCount).toBe(25);

    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp([[81, minimalInboxMessage({ timestamp: 8100 })]]),
    );
    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0', { skipIfNewestExhausted: true });
    });

    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(3);
    expect(apiRef.current!.messageFeeds[0].items.at(-1)?.[0]).toBe(81);
  });

  it('completes the down-arrow path when newer loading returns no rows', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: 10 }, (_, index) => [
          index + 1,
          minimalInboxMessage({ timestamp: (index + 1) * 100 }),
        ]),
      ),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    hoisted.fetchInboxCount.mockImplementation((req: any) => ({
      quantity: req.sinceIdNoninclusive === 10 ? 5 : req.sinceIdNoninclusive === 15 ? 0 : 0,
      firstElementTs: null,
    }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(apiRef.current!.messageFeeds[0].unreadCount).toBe(5);
    hoisted.notifyDutyNewMessages.mockReset();

    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp([
        [11, minimalInboxMessage({ timestamp: 1100 })],
        [12, minimalInboxMessage({ timestamp: 1200 })],
        [13, minimalInboxMessage({ timestamp: 1300 })],
        [14, minimalInboxMessage({ timestamp: 1400 })],
        [15, minimalInboxMessage({ timestamp: 1500 })],
      ]),
    );
    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0');
    });

    expect(apiRef.current!.messageFeeds[0].items.at(-1)?.[0]).toBe(15);
    expect(apiRef.current!.messageFeeds[0].unreadCount).toBe(5);
    expect(hoisted.fetchInboxCount.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ sinceIdNoninclusive: 10 }),
    );

    hoisted.fetchInboxCount.mockImplementation((req: any) => ({
      quantity: req.sinceIdNoninclusive === 10 ? 7 : req.sinceIdNoninclusive === 15 ? 0 : 0,
      firstElementTs: null,
    }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(apiRef.current!.messageFeeds[0].unreadCount).toBe(7);
    expect(hoisted.fetchInboxCount.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ sinceIdNoninclusive: 10 }),
    );
    expect(hoisted.notifyDutyNewMessages).toHaveBeenCalledTimes(1);
    expect(hoisted.notifyDutyNewMessages).toHaveBeenLastCalledWith('mf-0', 2);

    // Historical read state can live outside the fixed window and must survive the zero-row path.
    const historicalId = -1;
    expect(apiRef.current!.messageFeeds[0].items.some(([id]) => id === historicalId)).toBe(false);
    await act(async () => {
      apiRef.current!.setMessageFeeds((prev) =>
        prev.map((feed) =>
          feed.id === 'mf-0'
            ? {
                ...feed,
                readIds: new Set([...feed.readIds, historicalId]),
              }
            : feed,
        ),
      );
      await flushMicrotasks();
    });
    expect(apiRef.current!.messageFeeds[0].readIds.has(historicalId)).toBe(true);

    const scrollToEnd = vi.fn();
    apiRef.current!.columnRefsRef.current['mf-0'] = { scrollToEnd };
    hoisted.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([]));

    await act(async () => {
      const followGeneration = apiRef.current!.beginFollowTail('mf-0');
      await apiRef.current!.loadFeedNewerMessages('mf-0', {
        scrollToEndAfterLoad: true,
        followGeneration,
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(32);
      await flushMicrotasks();
    });

    runNextRaf();
    runNextRaf();
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
    expect(apiRef.current!.messageFeeds[0].items.map(([id]) => id)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
    expect(apiRef.current!.messageFeeds[0].readIds.has(historicalId)).toBe(true);
    expect(apiRef.current!.messageFeeds[0].readIds.has(11)).toBe(true);
    expect(apiRef.current!.messageFeeds[0].readIds.has(15)).toBe(true);
    expect(apiRef.current!.messageFeeds[0].unreadCount).toBe(0);

    const callsBeforeSkip = hoisted.fetchInboxMessages.mock.calls.length;
    hoisted.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([]));
    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0', { skipIfNewestExhausted: true });
    });
    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(callsBeforeSkip);

    hoisted.fetchInboxCount.mockResolvedValueOnce({ quantity: 0, firstElementTs: null });
    const countResult = await apiRef.current!.requestValidatedInboxCount('mf-0');
    expect(countResult).toEqual(
      expect.objectContaining({ feedId: 'mf-0', cursorId: 15, quantity: 0 }),
    );
    expect(hoisted.fetchInboxCount.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ sinceIdNoninclusive: 15 }),
    );
    expect(hoisted.notifyDutyNewMessages).toHaveBeenCalledTimes(1);
    expect(hoisted.notifyDutyNewMessages).toHaveBeenLastCalledWith('mf-0', 2);
  });

  it('retains the unread cursor for unread newer appends and lets polling correct the count', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: 10 }, (_, index) => [
          index + 1,
          minimalInboxMessage({ timestamp: (index + 1) * 100 }),
        ]),
      ),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    let pollCount = 0;
    hoisted.fetchInboxCount.mockImplementation(async (req: any) => ({
      quantity: req.sinceIdNoninclusive === 10 ? (pollCount++ === 0 ? 5 : 7) : 0,
      firstElementTs: null,
    }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(apiRef.current?.messageFeeds[0]?.unreadCount).toBe(5);
    hoisted.notifyDutyNewMessages.mockReset();

    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: 5 }, (_, index) => [
          index + 11,
          minimalInboxMessage({
            timestamp: (index + 11) * 100,
          }),
        ]),
      ),
    );
    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0');
    });

    expect(apiRef.current?.messageFeeds[0]?.items.at(-1)?.[0]).toBe(15);
    expect(apiRef.current?.messageFeeds[0]?.unreadCount).toBe(5);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(hoisted.fetchInboxCount.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ sinceIdNoninclusive: 10 }),
    );
    expect(apiRef.current?.messageFeeds[0]?.unreadCount).toBe(7);
    expect(hoisted.notifyDutyNewMessages).toHaveBeenCalledTimes(1);
    expect(hoisted.notifyDutyNewMessages).toHaveBeenLastCalledWith('mf-0', 2);
  });

  it('marks the current window read on a zero-row markAllRead append without scrolling', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: 10 }, (_, index) => [
          index + 1,
          minimalInboxMessage({ timestamp: (index + 1) * 100 }),
        ]),
      ),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    hoisted.fetchInboxCount.mockResolvedValueOnce({ quantity: 5, firstElementTs: null });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp([
        [11, minimalInboxMessage({ timestamp: 1100 })],
        [12, minimalInboxMessage({ timestamp: 1200 })],
        [13, minimalInboxMessage({ timestamp: 1300 })],
        [14, minimalInboxMessage({ timestamp: 1400 })],
        [15, minimalInboxMessage({ timestamp: 1500 })],
      ]),
    );
    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0');
    });

    hoisted.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([]));
    const scrollToEnd = vi.fn();
    apiRef.current!.columnRefsRef.current['mf-0'] = { scrollToEnd };
    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0', { markAllReadAfterAppend: true });
    });

    const feed = apiRef.current!.messageFeeds[0];
    const currentWindowIds = feed.items.map(([id]) => id);
    expect(feed.items.at(-1)?.[0]).toBe(15);
    expect(feed.unreadCount).toBe(0);
    expect(feed.readIds.has(11)).toBe(true);
    expect(feed.readIds.has(15)).toBe(true);
    expect(currentWindowIds.every((id) => feed.readIds.has(id))).toBe(true);
    expect(scrollToEnd).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(32);
      await flushMicrotasks();
    });
    expect(scrollToEnd).not.toHaveBeenCalled();

    hoisted.fetchInboxCount.mockResolvedValueOnce({ quantity: 0, firstElementTs: null });
    const countResult = await apiRef.current!.requestValidatedInboxCount('mf-0');
    expect(countResult).toEqual(
      expect.objectContaining({ feedId: 'mf-0', cursorId: 15, quantity: 0 }),
    );
  });

  it('keeps mark-read-only joins from scrolling while preserving the shared newer request', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: 10 }, (_, index) => [
          index + 1,
          minimalInboxMessage({ timestamp: (index + 1) * 100 }),
        ]),
      ),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    const newerResponse = deferred<InboxMessagesRsp>();
    hoisted.fetchInboxMessages.mockImplementationOnce(() => newerResponse.promise);
    const scrollToEnd = vi.fn();
    apiRef.current!.columnRefsRef.current['mf-0'] = { scrollToEnd };

    let firstPromise!: Promise<void>;
    let secondPromise!: Promise<void>;
    act(() => {
      const followGeneration = apiRef.current!.beginFollowTail('mf-0');
      firstPromise = apiRef.current!.loadFeedNewerMessages('mf-0');
      secondPromise = apiRef.current!.loadFeedNewerMessages('mf-0', {
        markAllReadAfterAppend: true,
      });
    });

    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(2);

    await act(async () => {
      newerResponse.resolve(
        inboxRsp(
          Array.from({ length: 5 }, (_, index) => [
            11 + index,
            minimalInboxMessage({ timestamp: (11 + index) * 100 }),
          ]),
        ),
      );
      await flushMicrotasks();
    });
    await act(async () => {
      await firstPromise;
      await secondPromise;
      await vi.advanceTimersByTimeAsync(32);
      await flushMicrotasks();
    });

    const feed = apiRef.current!.messageFeeds[0];
    expect(feed.items.at(-1)?.[0]).toBe(15);
    expect(feed.unreadCount).toBe(0);
    expect(feed.readIds.has(1)).toBe(true);
    expect(feed.readIds.has(15)).toBe(true);
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it('keeps follow-tail joins scrolling exactly once while marking the loaded batch read', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: 10 }, (_, index) => [
          index + 1,
          minimalInboxMessage({ timestamp: (index + 1) * 100 }),
        ]),
      ),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    const newerResponse = deferred<InboxMessagesRsp>();
    hoisted.fetchInboxMessages.mockImplementationOnce(() => newerResponse.promise);
    const scrollToEnd = vi.fn();
    apiRef.current!.columnRefsRef.current['mf-0'] = { scrollToEnd };

    let firstPromise!: Promise<void>;
    let secondPromise!: Promise<void>;
    act(() => {
      const followGeneration = apiRef.current!.beginFollowTail('mf-0');
      firstPromise = apiRef.current!.loadFeedNewerMessages('mf-0');
      secondPromise = apiRef.current!.loadFeedNewerMessages('mf-0', {
        scrollToEndAfterLoad: true,
        followGeneration,
      });
    });

    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(2);

    await act(async () => {
      newerResponse.resolve(
        inboxRsp(
          Array.from({ length: 5 }, (_, index) => [
            11 + index,
            minimalInboxMessage({ timestamp: (11 + index) * 100 }),
          ]),
        ),
      );
      await flushMicrotasks();
    });
    await act(async () => {
      await firstPromise;
      await secondPromise;
      await vi.advanceTimersByTimeAsync(32);
      await flushMicrotasks();
    });

    const feed = apiRef.current!.messageFeeds[0];
    expect(feed.items.at(-1)?.[0]).toBe(15);
    expect(feed.unreadCount).toBe(0);
    expect(feed.readIds.has(1)).toBe(true);
    expect(feed.readIds.has(15)).toBe(true);
    runNextRaf();
    runNextRaf();
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it('advances the unread cursor through committed read ids after partial scrolling', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: 10 }, (_, index) => [
          index + 1,
          minimalInboxMessage({ timestamp: (index + 1) * 100 }),
        ]),
      ),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    hoisted.fetchInboxCount.mockResolvedValue({ quantity: 5, firstElementTs: null });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: 5 }, (_, index) => [
          index + 11,
          minimalInboxMessage({ timestamp: (index + 11) * 100 }),
        ]),
      ),
    );
    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0');
    });

    await act(async () => {
      apiRef.current!.setMessageFeeds((prev) =>
        prev.map((feed) =>
          feed.id === 'mf-0'
            ? {
                ...feed,
                readIds: new Set([...feed.readIds, 11, 12]),
                unreadCount: 3,
              }
            : feed,
        ),
      );
      await flushMicrotasks();
    });

    hoisted.notifyDutyNewMessages.mockReset();
    hoisted.fetchInboxCount.mockResolvedValueOnce({ quantity: 3, firstElementTs: null });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(hoisted.fetchInboxCount.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ sinceIdNoninclusive: 12 }),
    );
    expect(apiRef.current?.messageFeeds[0]?.unreadCount).toBe(3);
    expect(hoisted.notifyDutyNewMessages).not.toHaveBeenCalled();
  });

  it('resets the unread cursor and notification baseline after a filter reload', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: DUTY_FEED_MESSAGE_WINDOW_LIMIT }, (_, index) => [
          index + 21,
          minimalInboxMessage({ timestamp: (index + 21) * 100 }),
        ]),
      ),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    hoisted.fetchInboxCount.mockResolvedValue({ quantity: 5, firstElementTs: null });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });
    hoisted.notifyDutyNewMessages.mockReset();

    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: DUTY_FEED_MESSAGE_WINDOW_LIMIT }, (_, index) => [
          index + 101,
          minimalInboxMessage({ timestamp: (index + 101) * 100 }),
        ]),
      ),
    );
    await act(async () => {
      apiRef.current!.applyFilter('mf-0', { ...emptyFilter(), groupsSelected: ['g-1'] });
    });
    await act(async () => {
      await flushMicrotasks();
    });

    hoisted.fetchInboxCount.mockResolvedValue({ quantity: 1, firstElementTs: null });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(hoisted.fetchInboxCount.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ sinceIdNoninclusive: 140 }),
    );
    expect(hoisted.notifyDutyNewMessages).toHaveBeenCalledTimes(1);
    expect(hoisted.notifyDutyNewMessages).toHaveBeenLastCalledWith('mf-0', 1);
  });

  it('keeps unread cursors independent across feeds', async () => {
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };
    window.history.replaceState(
      {},
      '',
      '/?state=' +
        encodeURIComponent(
          JSON.stringify({
            messageFeeds: [
              ['mf-0', emptyFilter()],
              ['mf-1', emptyFilter()],
            ],
          }),
        ),
    );
    hoisted.fetchInboxMessages
      .mockResolvedValueOnce(
        inboxRsp(
          Array.from({ length: DUTY_FEED_MESSAGE_WINDOW_LIMIT }, (_, index) => [
            index + 21,
            minimalInboxMessage({ timestamp: (index + 21) * 100 }),
          ]),
        ),
      )
      .mockResolvedValueOnce(
        inboxRsp(
          Array.from({ length: 10 }, (_, index) => [
            index + 201,
            minimalInboxMessage({ timestamp: (index + 201) * 100 }),
          ]),
        ),
      );

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });

    hoisted.fetchInboxCount.mockImplementation((req: any) =>
      Promise.resolve({
        quantity: req.sinceIdNoninclusive === 60 ? 5 : req.sinceIdNoninclusive === 210 ? 2 : 0,
        firstElementTs: null,
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(
      hoisted.fetchInboxCount.mock.calls.some((call) => call[0].sinceIdNoninclusive === 60),
    ).toBe(true);
    expect(
      hoisted.fetchInboxCount.mock.calls.some((call) => call[0].sinceIdNoninclusive === 210),
    ).toBe(true);
  });

  it('windows initial messages to the newest fixed-size batch', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: DUTY_FEED_MESSAGE_WINDOW_LIMIT + 5 }, (_, index) => [
          index + 1,
          minimalInboxMessage({ timestamp: (index + 1) * 100 }),
        ]),
      ),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    const ids = apiRef.current!.messageFeeds[0].items.map(([id]) => id);
    expect(ids).toHaveLength(DUTY_FEED_MESSAGE_WINDOW_LIMIT);
    expect(ids[0]).toBe(6);
    expect(ids.at(-1)).toBe(DUTY_FEED_MESSAGE_WINDOW_LIMIT + 5);
    expect([...apiRef.current!.messageFeeds[0].readIds].sort((a, b) => a - b)[0]).toBe(6);
  });

  it('prepends older messages and trims the newest side of the fixed window', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: DUTY_FEED_MESSAGE_WINDOW_LIMIT }, (_, index) => [
          index + 21,
          minimalInboxMessage({ timestamp: (index + 21) * 100 }),
        ]),
      ),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: 20 }, (_, index) => [
          index + 1,
          minimalInboxMessage({ timestamp: (index + 1) * 100 }),
        ]),
      ),
    );

    await act(async () => {
      await apiRef.current!.loadFeedOlderMessages('mf-0');
    });

    const feed = apiRef.current!.messageFeeds[0];
    const ids = feed.items.map(([id]) => id);
    expect(ids).toHaveLength(DUTY_FEED_MESSAGE_WINDOW_LIMIT);
    expect(ids[0]).toBe(1);
    expect(ids.at(-1)).toBe(DUTY_FEED_MESSAGE_WINDOW_LIMIT);
    expect(feed.readIds.has(DUTY_FEED_MESSAGE_WINDOW_LIMIT + 20)).toBe(true);
  });

  it('appends newer messages and trims the oldest side of the fixed window', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: DUTY_FEED_MESSAGE_WINDOW_LIMIT }, (_, index) => [
          index + 1,
          minimalInboxMessage({ timestamp: (index + 1) * 100 }),
        ]),
      ),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: 20 }, (_, index) => [
          DUTY_FEED_MESSAGE_WINDOW_LIMIT + index + 1,
          minimalInboxMessage({ timestamp: (DUTY_FEED_MESSAGE_WINDOW_LIMIT + index + 1) * 100 }),
        ]),
      ),
    );

    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0', { markAllReadAfterAppend: true });
    });

    const feed = apiRef.current!.messageFeeds[0];
    const ids = feed.items.map(([id]) => id);
    expect(ids).toHaveLength(DUTY_FEED_MESSAGE_WINDOW_LIMIT);
    expect(ids[0]).toBe(21);
    expect(ids.at(-1)).toBe(DUTY_FEED_MESSAGE_WINDOW_LIMIT + 20);
    expect(feed.readIds.has(1)).toBe(true);
    expect(feed.readIds.has(DUTY_FEED_MESSAGE_WINDOW_LIMIT + 20)).toBe(true);

    hoisted.fetchInboxCount.mockResolvedValueOnce({ quantity: 0, firstElementTs: null });
    const countResult = await apiRef.current!.requestValidatedInboxCount('mf-0');
    expect(countResult).toEqual(
      expect.objectContaining({
        feedId: 'mf-0',
        cursorId: DUTY_FEED_MESSAGE_WINDOW_LIMIT + 20,
      }),
    );
    expect(hoisted.fetchInboxCount.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        sinceIdNoninclusive: DUTY_FEED_MESSAGE_WINDOW_LIMIT + 20,
      }),
    );
  });

  it('clears start exhaustion when newer append evicts older rows from the fixed window', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: DUTY_FEED_MESSAGE_WINDOW_LIMIT }, (_, index) => [
          index + 1,
          minimalInboxMessage({ timestamp: (index + 1) * 100 }),
        ]),
      ),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    hoisted.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([]));
    await act(async () => {
      await apiRef.current!.loadFeedOlderMessages('mf-0');
    });

    expect(apiRef.current!.messageFeeds[0].hasReachedStart).toBe(true);

    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: 20 }, (_, index) => [
          DUTY_FEED_MESSAGE_WINDOW_LIMIT + index + 1,
          minimalInboxMessage({ timestamp: (DUTY_FEED_MESSAGE_WINDOW_LIMIT + index + 1) * 100 }),
        ]),
      ),
    );
    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0', { markAllReadAfterAppend: true });
    });

    const feed = apiRef.current!.messageFeeds[0];
    expect(feed.items[0][0]).toBe(21);
    expect(feed.hasReachedStart).toBe(false);

    hoisted.fetchInboxCount.mockResolvedValueOnce({ quantity: 0, firstElementTs: null });
    const countResult = await apiRef.current!.requestValidatedInboxCount('mf-0');
    expect(countResult).toEqual(
      expect.objectContaining({
        feedId: 'mf-0',
        cursorId: DUTY_FEED_MESSAGE_WINDOW_LIMIT + 20,
      }),
    );
    expect(hoisted.fetchInboxCount.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        sinceIdNoninclusive: DUTY_FEED_MESSAGE_WINDOW_LIMIT + 20,
      }),
    );
  });

  it('keeps returning seen chunk messages read when scrolling back toward newer messages', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: DUTY_FEED_MESSAGE_WINDOW_LIMIT }, (_, index) => [
          index + 21,
          minimalInboxMessage({ timestamp: (index + 21) * 100 }),
        ]),
      ),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: 20 }, (_, index) => [
          index + 1,
          minimalInboxMessage({ timestamp: (index + 1) * 100 }),
        ]),
      ),
    );
    await act(async () => {
      await apiRef.current!.loadFeedOlderMessages('mf-0');
    });

    expect(apiRef.current!.messageFeeds[0].items.at(-1)?.[0]).toBe(DUTY_FEED_MESSAGE_WINDOW_LIMIT);
    expect(apiRef.current!.messageFeeds[0].readIds.has(60)).toBe(true);

    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: 20 }, (_, index) => [
          DUTY_FEED_MESSAGE_WINDOW_LIMIT + index + 1,
          minimalInboxMessage({ timestamp: (DUTY_FEED_MESSAGE_WINDOW_LIMIT + index + 1) * 100 }),
        ]),
      ),
    );
    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0');
    });

    const feed = apiRef.current!.messageFeeds[0];
    expect(feed.items.map(([id]) => id).slice(-3)).toEqual([58, 59, 60]);
    expect(feed.unreadCount).toBe(0);
    expect(feed.readIds.has(60)).toBe(true);
  });

  it('does not call get-inbox for newer when column has no items (loadFeedNewerMessages no-op)', async () => {
    hoisted.fetchInboxMessages.mockResolvedValue(inboxRsp([]));

    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };
    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(apiRef.current?.messageFeeds[0]?.items).toHaveLength(0);
    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(1);

    hoisted.fetchInboxCount.mockResolvedValue({ quantity: 9, firstElementTs: null });

    await act(async () => {
      apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = true;
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(1);
  });

  it('suppresses automatic newer get-inbox after the current newest cursor is exhausted', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp([[80, minimalInboxMessage({ timestamp: 8000 })]]),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };
    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(apiRef.current!.messageFeeds[0].items.at(-1)?.[0]).toBe(80);
    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(1);

    hoisted.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([]));
    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0', { skipIfNewestExhausted: true });
    });
    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(2);

    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0', { skipIfNewestExhausted: true });
    });
    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(2);

    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp([[81, minimalInboxMessage({ timestamp: 8100 })]]),
    );
    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0');
    });

    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(3);
    expect(apiRef.current!.messageFeeds[0].items.at(-1)?.[0]).toBe(81);
  });

  it('does not start a second get-inbox-count for a feed while the first is still in flight', async () => {
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };
    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    hoisted.fetchInboxMessages.mockResolvedValue(inboxRsp([]));

    let startedCount = 0;
    hoisted.fetchInboxCount.mockImplementation(
      () =>
        new Promise<{ quantity: number; firstElementTs: number | null }>((resolve) => {
          startedCount++;
          setTimeout(() => resolve({ quantity: 0, firstElementTs: null }), 2500);
        }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(startedCount).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(startedCount).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(startedCount).toBeGreaterThanOrEqual(2);
  });

  describe('short state persistence', () => {
    it('stores short state and updates url on create success', async () => {
      hoisted.systemSettingsCurrent.mockResolvedValueOnce({
        id: 1,
        rerAnalysisUnitsExactMatchOnlyDefault: false,
        rerDutyTestEnabled: false,
        rerDutyInsertHistoricalInterceptions: false,
        rerDutyTestSinceMs: 0,
        rerDutyTestLimit: 1,
        rerDutyPollIntervalSec: 1,
        rerShortUrlEnabled: true,
      });
      hoisted.rerDutyShortStateCreate.mockResolvedValue({ id: 'short-123' });

      const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
        current: null,
      };
      await act(async () => {
        root.render(<TestHarness apiRef={apiRef} />);
      });
      await act(async () => {
        await flushMicrotasks();
      });

      await act(async () => {
        apiRef.current!.applyFilter('mf-0', { ...emptyFilter(), groupsSelected: ['g-1'] });
      });
      await act(async () => {
        await flushMicrotasks();
      });

      const params = new URLSearchParams(window.location.search);
      expect(params.get('state-short')).toBe('short-123');
      expect(params.get('state')).toBeNull();
    });

    it('falls back to long state url when short state create fails', async () => {
      hoisted.systemSettingsCurrent.mockResolvedValueOnce({
        id: 1,
        rerAnalysisUnitsExactMatchOnlyDefault: false,
        rerDutyTestEnabled: false,
        rerDutyInsertHistoricalInterceptions: false,
        rerDutyTestSinceMs: 0,
        rerDutyTestLimit: 1,
        rerDutyPollIntervalSec: 1,
        rerShortUrlEnabled: true,
      });
      hoisted.rerDutyShortStateCreate.mockRejectedValue(new Error('create failed'));

      const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
        current: null,
      };
      await act(async () => {
        root.render(<TestHarness apiRef={apiRef} />);
      });
      await act(async () => {
        await flushMicrotasks();
      });

      await act(async () => {
        apiRef.current!.applyFilter('mf-0', { ...emptyFilter(), groupsSelected: ['g-1'] });
      });
      await act(async () => {
        await flushMicrotasks();
      });

      const params = new URLSearchParams(window.location.search);
      expect(params.get('state-short')).toBeNull();
      expect(params.get('state')).toBeTruthy();
      expect(apiRef.current?.error).toBe('create failed');
    });
  });

  describe('poll autoscroll (scrollToEndAfterLoad)', () => {
    it('marks newer mail as read when watch mode, pixel at-bottom, and auto-scroll is allowed', async () => {
      const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
        current: null,
      };
      await act(async () => {
        root.render(<TestHarness apiRef={apiRef} />);
      });
      await act(async () => {
        await flushMicrotasks();
      });

      hoisted.fetchInboxMessages.mockResolvedValueOnce(
        inboxRsp([[2, minimalInboxMessage({ timestamp: 200 })]]),
      );
      hoisted.fetchInboxCount.mockResolvedValue({ quantity: 1, firstElementTs: null });

      await act(async () => {
        apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = true;
        apiRef.current!.physicallyAtBottomByFeedIdRef.current['mf-0'] = true;
        apiRef.current!.beginFollowTail('mf-0');
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      await act(async () => {
        await flushMicrotasks();
      });

      const feed = apiRef.current!.messageFeeds[0];
      expect(feed.items.map(([id]) => id).sort()).toEqual([1, 2]);
      expect(feed.readIds.has(1) && feed.readIds.has(2)).toBe(true);
      expect(feed.unreadCount).toBe(0);
    });

    it('does not mark-all-read on newer mail when watch mode but not at pixel bottom (autoscroll off)', async () => {
      const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
        current: null,
      };
      await act(async () => {
        root.render(<TestHarness apiRef={apiRef} />);
      });
      await act(async () => {
        await flushMicrotasks();
      });

      hoisted.fetchInboxMessages.mockResolvedValueOnce(
        inboxRsp([[2, minimalInboxMessage({ timestamp: 200 })]]),
      );
      hoisted.fetchInboxCount.mockResolvedValue({ quantity: 1, firstElementTs: null });

      await act(async () => {
        apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = true;
        apiRef.current!.physicallyAtBottomByFeedIdRef.current['mf-0'] = false;
        apiRef.current!.beginFollowTail('mf-0');
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      await act(async () => {
        await flushMicrotasks();
      });

      const feed = apiRef.current!.messageFeeds[0];
      expect(feed.items.map(([id]) => id).sort()).toEqual([1, 2]);
      expect(feed.readIds.has(2)).toBe(false);
      expect(feed.unreadCount).toBeGreaterThan(0);
    });

    it('does not mark-all-read when user prefs disable auto-scroll even if watch mode and at bottom', async () => {
      const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
        current: null,
      };
      await act(async () => {
        root.render(<TestHarness apiRef={apiRef} disableAutoScroll />);
      });
      await act(async () => {
        await flushMicrotasks();
      });

      hoisted.fetchInboxMessages.mockResolvedValueOnce(
        inboxRsp([[2, minimalInboxMessage({ timestamp: 200 })]]),
      );
      hoisted.fetchInboxCount.mockResolvedValue({ quantity: 1, firstElementTs: null });

      await act(async () => {
        apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = true;
        apiRef.current!.physicallyAtBottomByFeedIdRef.current['mf-0'] = true;
        apiRef.current!.beginFollowTail('mf-0');
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      await act(async () => {
        await flushMicrotasks();
      });

      const feed = apiRef.current!.messageFeeds[0];
      expect(feed.items.map(([id]) => id).sort()).toEqual([1, 2]);
      expect(feed.readIds.has(2)).toBe(false);
      expect(feed.unreadCount).toBeGreaterThan(0);
    });

    it('does not mark-all-read when only near-bottom (range) is true without watch mode', async () => {
      const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
        current: null,
      };
      await act(async () => {
        root.render(<TestHarness apiRef={apiRef} />);
      });
      await act(async () => {
        await flushMicrotasks();
      });

      hoisted.fetchInboxMessages.mockResolvedValueOnce(
        inboxRsp([[2, minimalInboxMessage({ timestamp: 200 })]]),
      );
      hoisted.fetchInboxCount.mockResolvedValue({ quantity: 1, firstElementTs: null });

      await act(async () => {
        apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = true;
        apiRef.current!.atBottomByFeedIdRef.current['mf-0'] = true;
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      await act(async () => {
        await flushMicrotasks();
      });

      const feed = apiRef.current!.messageFeeds[0];
      expect(feed.items.map(([id]) => id).sort()).toEqual([1, 2]);
      expect(feed.readIds.has(2)).toBe(false);
      expect(feed.unreadCount).toBeGreaterThan(0);
    });

    it('uses the committed post-older boundary for queued newer work', async () => {
      const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
        current: null,
      };
      const older = deferred<InboxMessagesRsp>();
      const newer = deferred<InboxMessagesRsp>();
      hoisted.fetchInboxMessages.mockResolvedValueOnce(rangeRsp(21, 40));
      hoisted.fetchInboxMessages.mockImplementationOnce(() => older.promise);
      hoisted.fetchInboxMessages.mockImplementationOnce(() => newer.promise);
      await act(async () => root.render(<TestHarness apiRef={apiRef} />));
      await act(async () => flushMicrotasks());
      const olderPromise = apiRef.current!.loadFeedOlderMessages('mf-0');
      const newerPromise = apiRef.current!.loadFeedNewerMessages('mf-0');
      older.resolve(rangeRsp(1, 20));
      await act(async () => flushMicrotasks());
      expect(hoisted.fetchInboxMessages.mock.calls[2][0].sinceIdNoninclusive).toBe(40);
      newer.resolve(rangeRsp(41, 60));
      await act(async () => Promise.all([olderPromise, newerPromise]));
      expect(apiRef.current!.messageFeeds[0].items.map(([id]) => id)).toEqual(
        Array.from({ length: 40 }, (_, index) => index + 21),
      );
    });

    it('uses the committed post-newer boundary for queued older work', async () => {
      const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
        current: null,
      };
      const newer = deferred<InboxMessagesRsp>();
      const older = deferred<InboxMessagesRsp>();
      hoisted.fetchInboxMessages.mockResolvedValueOnce(rangeRsp(21, 60));
      hoisted.fetchInboxMessages.mockImplementationOnce(() => newer.promise);
      hoisted.fetchInboxMessages.mockImplementationOnce(() => older.promise);
      await act(async () => root.render(<TestHarness apiRef={apiRef} />));
      await act(async () => flushMicrotasks());
      const newerPromise = apiRef.current!.loadFeedNewerMessages('mf-0');
      const olderPromise = apiRef.current!.loadFeedOlderMessages('mf-0');
      newer.resolve(rangeRsp(61, 80));
      await act(async () => {
        await flushMicrotasks();
        await flushMicrotasks();
      });
      expect(hoisted.fetchInboxMessages.mock.calls[2][0].beforeIdNoninclusive).toBe(41);
      older.resolve(rangeRsp(21, 40));
      await act(async () => Promise.all([newerPromise, olderPromise]));
      expect(apiRef.current!.messageFeeds[0].items.map(([id]) => id)).toEqual(
        Array.from({ length: 40 }, (_, index) => index + 21),
      );
    });

    it('shares the active newer promise when an arrow joins it', async () => {
      const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
        current: null,
      };
      const response = deferred<InboxMessagesRsp>();
      hoisted.fetchInboxMessages.mockResolvedValueOnce(rangeRsp(1, 2));
      hoisted.fetchInboxMessages.mockImplementationOnce(() => response.promise);
      await act(async () => root.render(<TestHarness apiRef={apiRef} />));
      await act(async () => flushMicrotasks());
      const automatic = apiRef.current!.loadFeedNewerMessages('mf-0');
      let settled = false;
      void automatic.then(() => {
        settled = true;
      });
      const arrow = apiRef.current!.loadFeedNewerMessages('mf-0', {
        scrollToEndAfterLoad: true,
        markAllReadAfterAppend: true,
      });
      expect(arrow).toBe(automatic);
      expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(2);
      await act(async () => flushMicrotasks());
      expect(settled).toBe(false);
      response.resolve(rangeRsp(3, 4));
      await act(async () => automatic);
      expect(apiRef.current!.messageFeeds[0].unreadCount).toBe(0);
    });

    it('shares one queued older promise for duplicate older calls', async () => {
      const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
        current: null,
      };
      const newer = deferred<InboxMessagesRsp>();
      const older = deferred<InboxMessagesRsp>();
      hoisted.fetchInboxMessages.mockResolvedValueOnce(rangeRsp(21, 40));
      hoisted.fetchInboxMessages.mockImplementationOnce(() => newer.promise);
      hoisted.fetchInboxMessages.mockImplementationOnce(() => older.promise);
      await act(async () => root.render(<TestHarness apiRef={apiRef} />));
      await act(async () => flushMicrotasks());
      const newerPromise = apiRef.current!.loadFeedNewerMessages('mf-0');
      const firstOlder = apiRef.current!.loadFeedOlderMessages('mf-0');
      const secondOlder = apiRef.current!.loadFeedOlderMessages('mf-0');
      expect(secondOlder).toBe(firstOlder);
      newer.resolve(rangeRsp(41, 60));
      await act(async () => flushMicrotasks());
      older.resolve(rangeRsp(1, 20));
      await act(async () => Promise.all([newerPromise, firstOlder, secondOlder]));
      expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(3);
    });

    it('ignores an older-load failure after a filter reload invalidates the request', async () => {
      const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
        current: null,
      };
      const older = deferred<InboxMessagesRsp>();
      const reload = deferred<InboxMessagesRsp>();
      hoisted.fetchInboxMessages.mockResolvedValueOnce(rangeRsp(21, 40));
      hoisted.fetchInboxMessages.mockImplementationOnce(() => older.promise);
      hoisted.fetchInboxMessages.mockImplementationOnce(() => reload.promise);
      await act(async () => root.render(<TestHarness apiRef={apiRef} />));
      await act(async () => flushMicrotasks());

      const olderPromise = apiRef.current!.loadFeedOlderMessages('mf-0');
      await act(async () => {
        apiRef.current!.applyFilter('mf-0', {
          ...emptyFilter(),
          groupsSelected: ['new-filter'],
        });
        await flushMicrotasks();
      });
      older.reject(new Error('stale older failure'));
      await act(async () => {
        await olderPromise;
        await flushMicrotasks();
      });

      expect(apiRef.current!.error).toBeNull();
      expect(apiRef.current!.messageFeeds[0].loading).toBe(true);
      reload.resolve(rangeRsp(41, 60));
      await act(async () => flushMicrotasks());
      expect(apiRef.current!.messageFeeds[0].loading).toBe(false);
    });

    it('invalidates a filter reload exactly once when React replays state updaters', async () => {
      const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
        current: null,
      };
      await act(async () =>
        root.render(
          <React.StrictMode>
            <TestHarness apiRef={apiRef} />
          </React.StrictMode>,
        ),
      );
      await act(async () => flushMicrotasks());
      const previousGeneration = apiRef.current!.getFeedLoadGeneration('mf-0');

      await act(async () => {
        apiRef.current!.applyFilter('mf-0', {
          ...emptyFilter(),
          groupsSelected: ['new-filter'],
        });
        await flushMicrotasks();
      });

      expect(apiRef.current!.getFeedLoadGeneration('mf-0')).toBe(previousGeneration + 1);
    });

    it('ignores an older-load failure after its feed is removed', async () => {
      window.history.replaceState(
        {},
        '',
        '/?state=' +
          encodeURIComponent(
            JSON.stringify({
              messageFeeds: [
                ['mf-0', emptyFilter()],
                ['mf-1', emptyFilter()],
              ],
            }),
          ),
      );
      const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
        current: null,
      };
      const older = deferred<InboxMessagesRsp>();
      hoisted.fetchInboxMessages.mockResolvedValueOnce(rangeRsp(1, 20));
      hoisted.fetchInboxMessages.mockResolvedValueOnce(rangeRsp(21, 40));
      hoisted.fetchInboxMessages.mockImplementationOnce(() => older.promise);
      await act(async () => root.render(<TestHarness apiRef={apiRef} />));
      await act(async () => flushMicrotasks());

      apiRef.current!.loadFeedOlderMessages('mf-1');
      await act(async () => {
        apiRef.current!.removeMessageFeed('mf-1');
        await flushMicrotasks();
      });
      older.reject(new Error('removed feed failure'));
      await act(async () => flushMicrotasks());

      expect(apiRef.current!.error).toBeNull();
      expect(apiRef.current!.messageFeeds.map((feed) => feed.id)).toEqual(['mf-0']);
    });

    it('does not restore available state after a confirmed request feed is removed', async () => {
      window.history.replaceState(
        {},
        '',
        '/?state=' +
          encodeURIComponent(
            JSON.stringify({
              messageFeeds: [
                ['mf-0', emptyFilter()],
                ['mf-1', emptyFilter()],
              ],
            }),
          ),
      );
      const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
        current: null,
      };
      const staleNewer = deferred<InboxMessagesRsp>();
      const mf1ScrollToEnd = vi.fn();
      hoisted.fetchInboxMessages.mockResolvedValueOnce(rangeRsp(1, 20));
      hoisted.fetchInboxMessages.mockResolvedValueOnce(rangeRsp(21, 40));
      hoisted.fetchInboxMessages.mockImplementationOnce(() => staleNewer.promise);
      await act(async () => root.render(<TestHarness apiRef={apiRef} />));
      await act(async () => flushMicrotasks());
      apiRef.current!.columnRefsRef.current['mf-0'] = { scrollToEnd: vi.fn() };
      apiRef.current!.columnRefsRef.current['mf-1'] = { scrollToEnd: mf1ScrollToEnd };

      const staleLoad = apiRef.current!.loadFeedNewerMessages('mf-1', {
        showLoading: false,
        confirmedTailAvailable: true,
      });
      await act(async () => flushMicrotasks());
      expect(apiRef.current!.tailAvailabilityByFeedId['mf-1']).toBe('loading');
      await act(async () => {
        apiRef.current!.removeMessageFeed('mf-1');
        await flushMicrotasks();
      });
      await act(async () => {
        staleNewer.reject(new Error('removed feed failure'));
        await staleLoad;
        await flushMicrotasks();
      });
      expect(apiRef.current!.messageFeeds.map((feed) => feed.id)).toEqual(['mf-0']);
      expect(apiRef.current!.tailAvailabilityByFeedId['mf-1']).not.toBe('available');
      expect(mf1ScrollToEnd).not.toHaveBeenCalled();
    });

    it('starts a replacement newer load while the invalidated request remains pending', async () => {
      const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
        current: null,
      };
      const staleNewer = deferred<InboxMessagesRsp>();
      const reload = deferred<InboxMessagesRsp>();
      const replacementNewer = deferred<InboxMessagesRsp>();
      hoisted.fetchInboxMessages.mockResolvedValueOnce(rangeRsp(21, 40));
      hoisted.fetchInboxMessages.mockImplementationOnce(() => staleNewer.promise);
      hoisted.fetchInboxMessages.mockImplementationOnce(() => reload.promise);
      hoisted.fetchInboxMessages.mockImplementationOnce(() => replacementNewer.promise);
      await act(async () => root.render(<TestHarness apiRef={apiRef} />));
      await act(async () => flushMicrotasks());

      apiRef.current!.loadFeedNewerMessages('mf-0');
      await act(async () => {
        apiRef.current!.applyFilter('mf-0', {
          ...emptyFilter(),
          groupsSelected: ['new-filter'],
        });
        await flushMicrotasks();
      });
      reload.resolve(rangeRsp(101, 120));
      await act(async () => flushMicrotasks());
      expect(apiRef.current!.loadingNewerFeedIds.has('mf-0')).toBe(false);

      const replacementPromise = apiRef.current!.loadFeedNewerMessages('mf-0');
      await act(async () => flushMicrotasks());
      expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(4);
      expect(hoisted.fetchInboxMessages.mock.calls[3][0].sinceIdNoninclusive).toBe(120);

      staleNewer.resolve(rangeRsp(41, 60));
      await act(async () => flushMicrotasks());
      expect(apiRef.current!.loadingNewerFeedIds.has('mf-0')).toBe(true);

      replacementNewer.resolve(rangeRsp(121, 140));
      await act(async () => replacementPromise);
      expect(apiRef.current!.messageFeeds[0].items.at(-1)?.[0]).toBe(140);
    });

    it('starts a replacement older load while the invalidated request remains pending', async () => {
      const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
        current: null,
      };
      const staleOlder = deferred<InboxMessagesRsp>();
      const reload = deferred<InboxMessagesRsp>();
      const replacementOlder = deferred<InboxMessagesRsp>();
      hoisted.fetchInboxMessages.mockResolvedValueOnce(rangeRsp(21, 60));
      hoisted.fetchInboxMessages.mockImplementationOnce(() => staleOlder.promise);
      hoisted.fetchInboxMessages.mockImplementationOnce(() => reload.promise);
      hoisted.fetchInboxMessages.mockImplementationOnce(() => replacementOlder.promise);
      await act(async () => root.render(<TestHarness apiRef={apiRef} />));
      await act(async () => flushMicrotasks());

      apiRef.current!.loadFeedOlderMessages('mf-0');
      await act(async () => {
        apiRef.current!.applyFilter('mf-0', {
          ...emptyFilter(),
          groupsSelected: ['new-filter'],
        });
        await flushMicrotasks();
      });
      reload.resolve(rangeRsp(101, 140));
      await act(async () => flushMicrotasks());

      const replacementPromise = apiRef.current!.loadFeedOlderMessages('mf-0');
      await act(async () => flushMicrotasks());
      expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(4);
      expect(hoisted.fetchInboxMessages.mock.calls[3][0].beforeIdNoninclusive).toBe(101);

      staleOlder.resolve(rangeRsp(1, 20));
      await act(async () => flushMicrotasks());
      expect(apiRef.current!.messageFeeds[0].loadingOlder).toBe(true);

      replacementOlder.resolve(rangeRsp(81, 100));
      await act(async () => replacementPromise);
      expect(apiRef.current!.messageFeeds[0].items[0][0]).toBe(81);
    });

    it('clears an exhausted cursor when a positive count is followed by newer data', async () => {
      const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
        current: null,
      };
      hoisted.fetchInboxMessages.mockResolvedValueOnce(rangeRsp(1, 1));
      hoisted.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([]));
      hoisted.fetchInboxMessages.mockResolvedValueOnce(rangeRsp(2, 2));
      await act(async () => root.render(<TestHarness apiRef={apiRef} />));
      await act(async () => flushMicrotasks());
      await act(async () => apiRef.current!.loadFeedNewerMessages('mf-0'));
      hoisted.fetchInboxCount.mockResolvedValue({ quantity: 1, firstElementTs: null });
      apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = true;
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      await act(async () => flushMicrotasks());
      expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(3);
    });

    it('keeps directional loading independent across two feeds', async () => {
      const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
        current: null,
      };
      hoisted.fetchInboxMessages.mockResolvedValueOnce(rangeRsp(1, 20));
      hoisted.fetchInboxMessages.mockResolvedValueOnce(rangeRsp(101, 120));
      await act(async () => root.render(<TestHarness apiRef={apiRef} />));
      await act(async () => {
        apiRef.current!.createMessageFeed();
        await flushMicrotasks();
      });
      await act(async () => flushMicrotasks());
      const [firstFeedId, secondFeedId] = apiRef.current!.messageFeeds.map((feed) => feed.id);
      const first = deferred<InboxMessagesRsp>();
      const second = deferred<InboxMessagesRsp>();
      hoisted.fetchInboxMessages.mockImplementationOnce(() => first.promise);
      hoisted.fetchInboxMessages.mockImplementationOnce(() => second.promise);

      const firstPromise = apiRef.current!.loadFeedNewerMessages(firstFeedId);
      const secondPromise = apiRef.current!.loadFeedNewerMessages(secondFeedId);
      await act(async () => flushMicrotasks());
      expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(4);

      first.resolve(rangeRsp(21, 40));
      second.resolve(rangeRsp(121, 140));
      await act(async () => Promise.all([firstPromise, secondPromise]));
      expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(4);
      expect(apiRef.current!.messageFeeds).toHaveLength(2);
      expect(apiRef.current!.messageFeeds[0].items.at(-1)?.[0]).toBe(40);
      expect(apiRef.current!.messageFeeds[1].items.at(-1)?.[0]).toBe(140);
    });
  });
});
