/**
 * @vitest-environment happy-dom
 */
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxMessage, InboxMessagesRsp } from '../../../../Bindings';
import { minimalInboxMessage } from './inbox-message-mocks';
import {
  createDutyFeedStateFixture,
  getDutyApiMocks,
  DutyFeedStateHarness as TestHarness,
  inboxRsp,
  rangeRsp,
  settleReactCommits as flushMicrotasks,
} from './useRerDutyFeedState.test-utils';
import {
  DUTY_FEED_UNREAD_PREFETCH_MIN,
  DUTY_FEED_MESSAGE_WINDOW_LIMIT,
  emptyFilter,
  feedIndicatorUnreadCount,
  feedLoadedUnreadCount,
  feedPendingNewerUnreadCount,
} from './utils';

const fixture = createDutyFeedStateFixture();
const hoisted = getDutyApiMocks();
const { deferred, expectTailCountRequest, mountLoadedFeed, runNextRaf, startPoll } = fixture;

describe('useRerDutyFeedState — polling and tail availability', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    ({ container, root } = fixture.setup());
  });

  afterEach(fixture.cleanup);
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
    hoisted.fetchInboxCount
      .mockResolvedValueOnce({ quantity: 1, firstElementTs: null })
      .mockResolvedValueOnce({ quantity: 0, firstElementTs: null })
      .mockResolvedValueOnce({ quantity: 1, firstElementTs: null })
      .mockResolvedValueOnce({ quantity: 0, firstElementTs: null });
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
    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(2);
    expect(
      feedIndicatorUnreadCount(feed, apiRef.current!.confirmedTailPreviewByFeedId['mf-0']),
    ).toBe(0);
  });

  it('clears poll-inflated unread at near-bottom when newer fetch returns empty', async () => {
    const { apiRef } = await mountLoadedFeed();
    await act(async () => {
      apiRef.current!.setMessageFeeds((feeds) =>
        feeds.map((feed) => ({
          ...feed,
          readIds: new Set([...feed.readIds, 1]),
          unreadCount: 4,
        })),
      );
    });
    apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = true;
    apiRef.current!.physicallyAtBottomByFeedIdRef.current['mf-0'] = true;
    apiRef.current!.cancelFollowTail('mf-0');

    hoisted.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([]));
    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0', {
        skipIfNewestExhausted: true,
        showLoading: false,
      });
    });

    expect(apiRef.current!.messageFeeds[0].unreadCount).toBe(0);
    expect(apiRef.current!.tailAvailabilityByFeedId['mf-0']).toBe('exhausted');

    hoisted.fetchInboxCount.mockResolvedValueOnce({ quantity: 4, firstElementTs: null });
    hoisted.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([]));
    await startPoll();

    expect(apiRef.current!.messageFeeds[0].unreadCount).toBe(0);
  });

  it('does not inflate unreadCount from inbox count while near bottom', async () => {
    const { apiRef } = await mountLoadedFeed();
    await act(async () => {
      apiRef.current!.setMessageFeeds((feeds) =>
        feeds.map((feed) => ({
          ...feed,
          readIds: new Set([...feed.readIds, 1]),
          unreadCount: 0,
        })),
      );
    });
    apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = true;
    apiRef.current!.physicallyAtBottomByFeedIdRef.current['mf-0'] = true;
    apiRef.current!.cancelFollowTail('mf-0');

    hoisted.fetchInboxCount.mockResolvedValueOnce({ quantity: 4, firstElementTs: null });
    hoisted.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([]));
    await startPoll();

    expect(apiRef.current!.messageFeeds[0].unreadCount).toBe(0);
  });

  it('empty newer at near-bottom does not resurrect unread after concurrent mark-read', async () => {
    const { apiRef } = await mountLoadedFeed();
    await act(async () => {
      apiRef.current!.setMessageFeeds((feeds) =>
        feeds.map((feed) => ({
          ...feed,
          readIds: new Set<number>(),
          unreadCount: 4,
        })),
      );
    });
    apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = true;
    apiRef.current!.physicallyAtBottomByFeedIdRef.current['mf-0'] = true;
    apiRef.current!.cancelFollowTail('mf-0');

    hoisted.fetchInboxMessages.mockImplementationOnce(async () => {
      apiRef.current!.setMessageFeeds((feeds) =>
        feeds.map((feed) =>
          feed.id === 'mf-0'
            ? {
                ...feed,
                readIds: new Set(feed.items.map(([id]) => id)),
                windowedUnreadItems: new Map(),
                unreadCount: 0,
              }
            : feed,
        ),
      );
      return inboxRsp([]);
    });

    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0', {
        skipIfNewestExhausted: true,
        showLoading: false,
      });
    });

    const feed = apiRef.current!.messageFeeds[0];
    expect(feed.readIds.has(1)).toBe(true);
    expect(feed.unreadCount).toBe(0);
    expect(feedIndicatorUnreadCount(feed, undefined, { includeBeyondTailResidual: false })).toBe(0);
  });

  it('pins the unread cursor to the loaded tail once every loaded message is read', async () => {
    const { apiRef } = await mountLoadedFeed();
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp([
        [2, minimalInboxMessage({ timestamp: 200 })],
        [3, minimalInboxMessage({ timestamp: 300 })],
      ]),
    );
    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0', { showLoading: false });
    });
    expect(apiRef.current!.messageFeeds[0].items.map(([id]) => id)).toEqual([1, 2, 3]);

    await act(async () => {
      apiRef.current!.setMessageFeeds((feeds) =>
        feeds.map((feed) => ({
          ...feed,
          readIds: new Set([1, 2, 3]),
          unreadCount: 0,
          windowedUnreadItems: new Map(),
        })),
      );
      await flushMicrotasks();
    });

    hoisted.fetchInboxCount.mockClear();
    apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = false;
    hoisted.fetchInboxCount.mockResolvedValue({ quantity: 0, firstElementTs: null });
    await startPoll();

    expect(
      hoisted.fetchInboxCount.mock.calls.some(([request]) => request?.sinceIdNoninclusive === 3),
    ).toBe(true);
  });

  it('catchUpFeedUnreadToTail clears local unread and badges to zero', async () => {
    const { apiRef } = await mountLoadedFeed();
    await act(async () => {
      apiRef.current!.setMessageFeeds((feeds) =>
        feeds.map((feed) => ({
          ...feed,
          readIds: new Set<number>(),
          unreadCount: 9,
          windowedUnreadItems: new Map([[5, 50]]),
        })),
      );
    });

    await act(async () => {
      apiRef.current!.catchUpFeedUnreadToTail('mf-0');
    });

    const feed = apiRef.current!.messageFeeds[0];
    expect(feed.unreadCount).toBe(0);
    expect(feed.windowedUnreadItems.size).toBe(0);
    expect(feed.readIds.has(1)).toBe(true);
    expect(feedIndicatorUnreadCount(feed)).toBe(0);
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
    hoisted.fetchInboxCount
      .mockResolvedValueOnce({ quantity: 1, firstElementTs: null })
      .mockResolvedValueOnce({ quantity: 21, firstElementTs: null });
    await startPoll();
    await act(async () => flushMicrotasks());

    expect(hoisted.fetchInboxCount).toHaveBeenCalled();
    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(1);
    const feed = apiRef.current!.messageFeeds[0];
    expect(feed.items.map(([id]) => id)).toEqual([1]);
    expect(feed.readIds).toEqual(new Set([1]));
    expect(feed.unreadCount).toBe(1);
    expect(apiRef.current!.tailAvailabilityByFeedId['mf-0']).toBe('available');
    expect(apiRef.current!.confirmedTailPreviewByFeedId['mf-0']).toMatchObject({
      tailId: 1,
      count: 21,
    });
    expect(apiRef.current!.loadingNewerFeedIds.has('mf-0')).toBe(false);
    expect(scrollToEnd).not.toHaveBeenCalled();
    expect(hoisted.fetchInboxCount).toHaveBeenLastCalledWith(
      expect.objectContaining({ sinceIdNoninclusive: 1, nolimit: true }),
    );
    expect(
      feedIndicatorUnreadCount(feed, apiRef.current!.confirmedTailPreviewByFeedId['mf-0']),
    ).toBe(21);
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
    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(1);
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

    expect(hoisted.fetchInboxCount).toHaveBeenCalledTimes(2);
    expect(hoisted.fetchInboxCount.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        sinceIdNoninclusive: 10,
        sinceDateInclusiveMs: null,
        nolimit: true,
      }),
    );
    expect(apiRef.current?.messageFeeds[0]?.unreadCount).toBe(70000);
  });

  it('appends newer mail at the physical bottom until the explicit terminal page', async () => {
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
      apiRef.current!.physicallyAtBottomByFeedIdRef.current['mf-0'] = true;
    });

    hoisted.fetchInboxCount.mockResolvedValue({ quantity: 1, firstElementTs: null });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    const newerRequests = hoisted.fetchInboxMessages.mock.calls
      .map(([request]) => request)
      .filter((request) => request?.sinceIdNoninclusive != null);
    expect(newerRequests.map((request) => request.sinceIdNoninclusive)).toEqual([1]);
    const ids = apiRef.current!.messageFeeds[0].items.map(([id]) => id).sort((a, b) => a - b);
    expect(ids).toEqual([1, 2]);
  });

  it('continues count alerts while a poll-triggered newer load is pending', async () => {
    const { apiRef } = await mountLoadedFeed();
    apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = true;
    apiRef.current!.physicallyAtBottomByFeedIdRef.current['mf-0'] = true;
    await startPoll();

    hoisted.beginDutyNotificationPollCycle.mockClear();
    hoisted.endDutyNotificationPollCycle.mockClear();
    hoisted.notifyDutyNewMessages.mockClear();
    hoisted.fetchInboxCount.mockClear();
    const newerMessages = deferred<InboxMessagesRsp>('pending newer messages');
    hoisted.fetchInboxCount.mockReset();
    hoisted.fetchInboxCount.mockResolvedValue({ quantity: 2, firstElementTs: null });
    hoisted.fetchInboxMessages.mockImplementationOnce(() => newerMessages.promise);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await flushMicrotasks();
    });

    expect(hoisted.notifyDutyNewMessages).toHaveBeenCalledWith('mf-0', 2);
    expect(hoisted.endDutyNotificationPollCycle).toHaveBeenCalledTimes(1);
    const newerRequestCount = hoisted.fetchInboxMessages.mock.calls.length;
    hoisted.fetchInboxCount.mockReset();
    hoisted.fetchInboxCount.mockResolvedValue({ quantity: 3, firstElementTs: null });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await flushMicrotasks();
    });
    expect(hoisted.notifyDutyNewMessages).toHaveBeenCalledWith('mf-0', 1);
    expect(hoisted.endDutyNotificationPollCycle).toHaveBeenCalledTimes(2);
    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(newerRequestCount);

    newerMessages.resolve(inboxRsp([]));
    await act(async () => {
      await flushMicrotasks();
    });

    expect(hoisted.endDutyNotificationPollCycle).toHaveBeenCalledTimes(2);
  });

  it('requests newer mail from progressive cursors at the physical bottom', async () => {
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
      apiRef.current!.physicallyAtBottomByFeedIdRef.current['mf-0'] = true;
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    const newerRequests = hoisted.fetchInboxMessages.mock.calls
      .map(([request]) => request)
      .filter((request) => request?.sinceIdNoninclusive != null);
    expect(newerRequests.map((request) => request.sinceIdNoninclusive)).toEqual([1]);
    expect(apiRef.current!.messageFeeds[0].items.map(([id]) => id).sort()).toEqual([1, 3]);
  });

  it('near-bottom catch-up buffers an unread runway and flushes it exactly once', async () => {
    const { apiRef } = await mountLoadedFeed();
    await act(async () => {
      apiRef.current!.setMessageFeeds((feeds) =>
        feeds.map((feed) => ({
          ...feed,
          readIds: new Set(feed.items.map(([id]) => id)),
          windowedUnreadItems: new Map<number, number>(),
          unreadCount: 0,
        })),
      );
    });
    await act(async () => {
      await flushMicrotasks();
    });

    hoisted.fetchInboxMessages.mockImplementation(
      (req: { sinceIdNoninclusive?: number | null }) => {
        const since = req.sinceIdNoninclusive;
        if (since == null) {
          return Promise.resolve(inboxRsp([[1, minimalInboxMessage({ timestamp: 100 })]]));
        }
        return Promise.resolve(rangeRsp(since + 1, since + 5));
      },
    );
    hoisted.fetchInboxCount.mockResolvedValue({ quantity: 25, firstElementTs: null });

    await act(async () => {
      apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = true;
      apiRef.current!.physicallyAtBottomByFeedIdRef.current['mf-0'] = false;
      apiRef.current!.cancelFollowTail('mf-0');
    });

    await startPoll();
    await act(async () => {
      await flushMicrotasks();
    });

    const feed = apiRef.current!.messageFeeds[0];
    expect(feedLoadedUnreadCount(feed)).toBe(0);
    expect(feedPendingNewerUnreadCount(feed)).toBeGreaterThanOrEqual(DUTY_FEED_UNREAD_PREFETCH_MIN);
    expect(feedPendingNewerUnreadCount(feed)).toBeLessThan(25);
    expect(feed.items.map(([id]) => id)).toEqual([1]);
    expect(feed.pendingNewerItems?.map(([id]) => id)).toEqual(
      Array.from({ length: 10 }, (_, index) => index + 2),
    );
    const newerLoads = hoisted.fetchInboxMessages.mock.calls.filter(
      ([request]) => request?.sinceIdNoninclusive != null,
    );
    expect(newerLoads.length).toBe(2);
    expect(newerLoads.map(([request]) => request.sinceIdNoninclusive)).toEqual([1, 6]);

    await act(async () => {
      apiRef.current!.flushPendingNewerMessages('mf-0');
      await flushMicrotasks();
    });
    const flushed = apiRef.current!.messageFeeds[0];
    expect(flushed.items.map(([id]) => id)).toEqual(
      Array.from({ length: 11 }, (_, index) => index + 1),
    );
    expect(flushed.pendingNewerItems).toEqual([]);
    apiRef.current!.flushPendingNewerMessages('mf-0');
    expect(apiRef.current!.messageFeeds[0].items).toHaveLength(11);
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

    expectTailCountRequest(60);
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

    expectTailCountRequest(60);
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

    const feedA = deferred<{ quantity: number; firstElementTs: number | null }>('feedA');
    const feedB = deferred<{ quantity: number; firstElementTs: number | null }>('feedB');
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

    const count = deferred<{ quantity: number; firstElementTs: number | null }>('count');
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

    const countResponse = deferred<{ quantity: number; firstElementTs: number | null }>(
      'countResponse',
    );
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
    expectTailCountRequest(10);
    await act(async () => {
      await flushMicrotasks();
    });
  });

  it('uses the server poll cursor and reloads an empty feed when matching messages arrive', async () => {
    hoisted.fetchInboxMessages
      .mockResolvedValueOnce(inboxRsp([], 80))
      .mockResolvedValueOnce(inboxRsp([[81, minimalInboxMessage({ timestamp: 8100 })]], 81));

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

    hoisted.fetchInboxCount.mockResolvedValue({ quantity: 1, firstElementTs: 8100 });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(hoisted.fetchInboxCount).toHaveBeenCalledWith(
      expect.objectContaining({ sinceIdNoninclusive: 80, nolimit: true }),
    );
    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(2);
    expect(apiRef.current?.messageFeeds[0]?.items.map(([id]) => id)).toEqual([81]);
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
    const countResolvers: Array<
      (value: { quantity: number; firstElementTs: number | null }) => void
    > = [];
    hoisted.fetchInboxCount.mockImplementation(
      () =>
        new Promise<{ quantity: number; firstElementTs: number | null }>((resolve) => {
          startedCount++;
          countResolvers.push(resolve);
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
      countResolvers.shift()?.({ quantity: 0, firstElementTs: null });
      await vi.advanceTimersByTimeAsync(1000);
      await flushMicrotasks();
    });
    expect(startedCount).toBeGreaterThanOrEqual(2);
    await act(async () => {
      countResolvers.shift()?.({ quantity: 0, firstElementTs: null });
      await flushMicrotasks();
    });
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
});
