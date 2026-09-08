/**
 * @vitest-environment happy-dom
 */
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxMessage, InboxMessagesRsp } from '../../../../../Bindings';
import { minimalInboxMessage } from '../inbox-message-mocks';
import {
  createDutyFeedStateFixture,
  getDutyApiMocks,
  DutyFeedStateHarness as TestHarness,
  inboxRsp,
  rangeRsp,
  settleReactCommits as flushMicrotasks,
} from '../useRerDutyFeedState.test-utils';
import {
  DUTY_FEED_UNREAD_PREFETCH_MIN,
  DUTY_FEED_MESSAGE_WINDOW_LIMIT,
  emptyFilter,
  feedIndicatorUnreadCount,
  feedLoadedUnreadCount,
  feedPendingNewerUnreadCount,
} from '../utils';

const fixture = createDutyFeedStateFixture();
const hoisted = getDutyApiMocks();
const { deferred, expectTailCountRequest, mountLoadedFeed, runNextRaf, startPoll } = fixture;

// @test-scope safeguard: prevents directional page loads and late responses from replacing the current feed window.
describe('useRerDutyFeedState — directional loading and races', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    ({ container, root } = fixture.setup());
  });

  afterEach(fixture.cleanup);
  describe('poll autoscroll (scrollToEndAfterLoad)', () => {
    it('releases a stalled newer lane after the pagination request deadline', async () => {
      const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
        current: null,
      };
      const stalled = deferred<InboxMessagesRsp>('stalled newer');
      let signal: AbortSignal | undefined;
      hoisted.fetchInboxMessages.mockResolvedValueOnce(rangeRsp(1, 1));
      hoisted.fetchInboxMessages.mockImplementationOnce((_, options?: { signal?: AbortSignal }) => {
        signal = options?.signal;
        signal?.addEventListener('abort', () => {
          stalled.reject(new DOMException('aborted', 'AbortError'));
        });
        return stalled.promise;
      });
      await act(async () => root.render(<TestHarness apiRef={apiRef} />));
      await act(async () => flushMicrotasks());

      const stalledLoad = apiRef.current!.loadFeedNewerMessages('mf-0');
      await act(async () => flushMicrotasks());
      expect(signal?.aborted).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
        await flushMicrotasks();
      });

      expect(signal?.aborted).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(24_999);
        await flushMicrotasks();
      });

      expect(signal?.aborted).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
        await flushMicrotasks();
      });

      expect(signal?.aborted).toBe(true);
      await expect(stalledLoad).resolves.toEqual({ ok: false, addedCount: 0 });

      hoisted.fetchInboxMessages.mockResolvedValueOnce(rangeRsp(2, 2));
      let retryResult: { ok: boolean; addedCount: number } | undefined;
      await act(async () => {
        retryResult = await apiRef.current!.loadFeedNewerMessages('mf-0');
        await flushMicrotasks();
      });
      expect(retryResult).toEqual({ ok: true, addedCount: 1 });
      expect(apiRef.current!.messageFeeds[0].items.at(-1)?.[0]).toBe(2);
    });

    it('allows an older page request to finish after ten seconds', async () => {
      const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
        current: null,
      };
      const older = deferred<InboxMessagesRsp>('older pagination');
      let signal: AbortSignal | undefined;
      hoisted.fetchInboxMessages.mockResolvedValueOnce(rangeRsp(21, 40));
      hoisted.fetchInboxMessages.mockImplementationOnce((_, options?: { signal?: AbortSignal }) => {
        signal = options?.signal;
        return older.promise;
      });
      await act(async () => root.render(<TestHarness apiRef={apiRef} />));
      await act(async () => flushMicrotasks());

      const olderLoad = apiRef.current!.loadFeedOlderMessages('mf-0');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_001);
        await flushMicrotasks();
      });

      expect(signal?.aborted).toBe(false);
      older.resolve(rangeRsp(1, 20));
      await act(async () => {
        await olderLoad;
        await flushMicrotasks();
      });
      expect(apiRef.current!.messageFeeds[0].items[0]?.[0]).toBe(1);
    });

    it('ignores an older-load failure after a filter reload invalidates the request', async () => {
      const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
        current: null,
      };
      const older = deferred<InboxMessagesRsp>('older');
      const reload = deferred<InboxMessagesRsp>('reload');
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
      const older = deferred<InboxMessagesRsp>('older');
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
      const staleNewer = deferred<InboxMessagesRsp>('staleNewer');
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
      const staleNewer = deferred<InboxMessagesRsp>('staleNewer');
      const reload = deferred<InboxMessagesRsp>('reload');
      const replacementNewer = deferred<InboxMessagesRsp>('replacementNewer');
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
      const staleOlder = deferred<InboxMessagesRsp>('staleOlder');
      const reload = deferred<InboxMessagesRsp>('reload');
      const replacementOlder = deferred<InboxMessagesRsp>('replacementOlder');
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
      hoisted.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([]));
      await act(async () => root.render(<TestHarness apiRef={apiRef} />));
      await act(async () => flushMicrotasks());
      await act(async () => apiRef.current!.loadFeedNewerMessages('mf-0'));
      hoisted.fetchInboxCount.mockResolvedValue({ quantity: 1, firstElementTs: null });
      apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = true;
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      await act(async () => flushMicrotasks());
      expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(4);
      expect(apiRef.current!.messageFeeds[0].items.map(([id]) => id)).toEqual([1]);
      expect(apiRef.current!.messageFeeds[0].pendingNewerItems?.map(([id]) => id)).toEqual([2]);
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
      const first = deferred<InboxMessagesRsp>('first');
      const second = deferred<InboxMessagesRsp>('second');
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
  describe('poll autoscroll (scrollToEndAfterLoad)', () => {
    it('uses the committed post-older boundary for queued newer work', async () => {
      const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
        current: null,
      };
      const older = deferred<InboxMessagesRsp>('older');
      const newer = deferred<InboxMessagesRsp>('newer');
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
        Array.from({ length: 40 }, (_, index) => index + 1),
      );
      expect(apiRef.current!.messageFeeds[0].pendingNewerItems?.map(([id]) => id)).toEqual(
        Array.from({ length: 20 }, (_, index) => index + 41),
      );
    });
  });
  describe('poll autoscroll (scrollToEndAfterLoad)', () => {
    it('uses the committed post-newer boundary for queued older work', async () => {
      const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
        current: null,
      };
      const newer = deferred<InboxMessagesRsp>('newer');
      const older = deferred<InboxMessagesRsp>('older');
      hoisted.fetchInboxMessages.mockResolvedValueOnce(rangeRsp(21, 60));
      hoisted.fetchInboxMessages.mockImplementationOnce(() => newer.promise);
      hoisted.fetchInboxMessages.mockImplementationOnce(() => older.promise);
      await act(async () => root.render(<TestHarness apiRef={apiRef} />));
      await act(async () => flushMicrotasks());
      apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = true;
      apiRef.current!.physicallyAtBottomByFeedIdRef.current['mf-0'] = true;
      const newerPromise = apiRef.current!.loadFeedNewerMessages('mf-0');
      const olderPromise = apiRef.current!.loadFeedOlderMessages('mf-0');
      await act(async () => {
        newer.resolve(rangeRsp(61, 80));
        await flushMicrotasks();
      });
      expect(hoisted.fetchInboxMessages.mock.calls[2][0].beforeIdNoninclusive).toBe(21);
      await act(async () => {
        older.resolve(rangeRsp(21, 40));
        await Promise.all([newerPromise, olderPromise]);
      });
      expect(apiRef.current!.messageFeeds[0].items.map(([id]) => id)).toEqual(
        Array.from({ length: 40 }, (_, index) => index + 21),
      );
      expect(apiRef.current!.messageFeeds[0].pendingNewerItems?.map(([id]) => id)).toEqual(
        Array.from({ length: 20 }, (_, index) => index + 61),
      );
    });
  });
  describe('poll autoscroll (scrollToEndAfterLoad)', () => {
    it('shares the active newer promise when an arrow joins it', async () => {
      const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
        current: null,
      };
      const response = deferred<InboxMessagesRsp>('response');
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
  });
  describe('poll autoscroll (scrollToEndAfterLoad)', () => {
    it('shares one queued older promise for duplicate older calls', async () => {
      const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
        current: null,
      };
      const newer = deferred<InboxMessagesRsp>('newer');
      const older = deferred<InboxMessagesRsp>('older');
      hoisted.fetchInboxMessages.mockResolvedValueOnce(rangeRsp(21, 40));
      hoisted.fetchInboxMessages.mockImplementationOnce(() => newer.promise);
      hoisted.fetchInboxMessages.mockImplementationOnce(() => older.promise);
      await act(async () => root.render(<TestHarness apiRef={apiRef} />));
      await act(async () => flushMicrotasks());
      apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = true;
      apiRef.current!.physicallyAtBottomByFeedIdRef.current['mf-0'] = true;
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
  });
});
