/**
 * @vitest-environment happy-dom
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxMessage, InboxMessagesRsp } from '../../../../Bindings';
import { minimalInboxMessage } from './inbox-message-mocks';
import { useRerDutyFeedInteractionActions } from './useRerDutyFeedInteractionActions';
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

describe('useRerDutyFeedState — unread buffering and read state', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    ({ container, root } = fixture.setup());
  });

  afterEach(fixture.cleanup);
  it('#3360 retains buffered arrivals when a complete arrow action is cancelled', async () => {
    const { apiRef } = await mountLoadedFeed(true);
    let actions: ReturnType<typeof useRerDutyFeedInteractionActions> | null = null;
    function Actions() {
      const feedState = apiRef.current!;
      actions = useRerDutyFeedInteractionActions({
        messageFeeds: feedState.messageFeeds,
        showArrowResult: vi.fn(),
        columnRefsRef: feedState.columnRefsRef,
        setWatchModeByFeedId: feedState.setWatchModeByFeedId,
        setLoadingNewerFeedIds: feedState.setLoadingNewerFeedIds,
        loadFeedInitialMessages: feedState.loadFeedInitialMessages,
        loadFeedNewerMessages: feedState.loadFeedNewerMessages,
        flushPendingNewerMessages: feedState.flushPendingNewerMessages,
        requestValidatedInboxCount: feedState.requestValidatedInboxCount,
        catchUpFeedUnreadToTail: feedState.catchUpFeedUnreadToTail,
        dutyDisableAutoScroll: true,
        setMessageFeeds: feedState.setMessageFeeds,
        beginExplicitNavigation: feedState.beginExplicitNavigation,
        isExplicitNavigationCurrent: feedState.isExplicitNavigationCurrent,
        registerExplicitLanding: feedState.registerExplicitLanding,
        registerExplicitLoading: feedState.registerExplicitLoading,
        cancelExplicitNavigation: feedState.cancelExplicitNavigation,
        registerExplicitScheduledWork: feedState.registerExplicitScheduledWork,
        clearExplicitScheduledWork: feedState.clearExplicitScheduledWork,
        getExplicitScrollNavigation: feedState.getExplicitScrollNavigation,
      });
      return null;
    }
    const host = document.createElement('div');
    document.body.appendChild(host);
    const actionRoot = createRoot(host);
    try {
      await act(async () => actionRoot.render(<Actions />));
      hoisted.fetchInboxCount.mockResolvedValue({ quantity: 19, firstElementTs: null });
      const response = deferred('cancelled complete arrow response');
      hoisted.fetchInboxMessages.mockImplementationOnce(() => response.promise);
      let click: Promise<void> | undefined;
      await act(async () => {
        click = actions!.handleArrowClick('mf-0');
        await flushMicrotasks();
      });
      apiRef.current!.cancelFollowTail('mf-0');
      await act(async () => {
        response.resolve(rangeRsp(2, 20));
        await click;
        await flushMicrotasks();
      });
      const feed = apiRef.current!.messageFeeds[0];
      expect(feed.pendingNewerItems.map(([id]) => id)).toEqual(
        rangeRsp(2, 20).inboxItems.map(([id]) => id),
      );
      expect(feed.unreadCount).toBeGreaterThan(0);
    } finally {
      act(() => actionRoot.unmount());
      host.remove();
    }
  });

  it('#3360 releases cancelled arrow loading before its count response settles', async () => {
    const { apiRef } = await mountLoadedFeed(true);
    let actions: ReturnType<typeof useRerDutyFeedInteractionActions> | null = null;
    function Actions() {
      const feedState = apiRef.current!;
      actions = useRerDutyFeedInteractionActions({
        messageFeeds: feedState.messageFeeds,
        showArrowResult: vi.fn(),
        columnRefsRef: feedState.columnRefsRef,
        setWatchModeByFeedId: feedState.setWatchModeByFeedId,
        setLoadingNewerFeedIds: feedState.setLoadingNewerFeedIds,
        loadFeedInitialMessages: feedState.loadFeedInitialMessages,
        loadFeedNewerMessages: feedState.loadFeedNewerMessages,
        flushPendingNewerMessages: feedState.flushPendingNewerMessages,
        requestValidatedInboxCount: feedState.requestValidatedInboxCount,
        catchUpFeedUnreadToTail: feedState.catchUpFeedUnreadToTail,
        dutyDisableAutoScroll: true,
        setMessageFeeds: feedState.setMessageFeeds,
        beginExplicitNavigation: feedState.beginExplicitNavigation,
        isExplicitNavigationCurrent: feedState.isExplicitNavigationCurrent,
        registerExplicitLanding: feedState.registerExplicitLanding,
        registerExplicitLoading: feedState.registerExplicitLoading,
        cancelExplicitNavigation: feedState.cancelExplicitNavigation,
        registerExplicitScheduledWork: feedState.registerExplicitScheduledWork,
        clearExplicitScheduledWork: feedState.clearExplicitScheduledWork,
        getExplicitScrollNavigation: feedState.getExplicitScrollNavigation,
      });
      return null;
    }
    const host = document.createElement('div');
    document.body.appendChild(host);
    const actionRoot = createRoot(host);
    const count = deferred<number>('cancelled arrow count');
    hoisted.fetchInboxCount.mockImplementationOnce(() => count.promise);
    try {
      await act(async () => actionRoot.render(<Actions />));
      let click: Promise<void> | undefined;
      await act(async () => {
        click = actions!.handleArrowClick('mf-0');
        await flushMicrotasks();
      });
      expect(apiRef.current!.loadingNewerFeedIds.has('mf-0')).toBe(true);
      await act(async () => {
        apiRef.current!.cancelFollowTail('mf-0');
        await flushMicrotasks();
      });
      expect(apiRef.current!.loadingNewerFeedIds.has('mf-0')).toBe(false);
      await act(async () => {
        count.resolve(0);
        await click;
        await flushMicrotasks();
      });
      expect(apiRef.current!.loadingNewerFeedIds.has('mf-0')).toBe(false);
    } finally {
      act(() => actionRoot.unmount());
      host.remove();
    }
  });

  it('#3360 does not acknowledge an arrow response cancelled before its deferred landing', async () => {
    const { apiRef } = await mountLoadedFeed(true);
    const operation = apiRef.current!.beginExplicitNavigation('mf-0');
    const response = deferred('landing cancelled after response');
    hoisted.fetchInboxMessages.mockImplementationOnce(() => response.promise);
    const load = apiRef.current!.loadFeedNewerMessages('mf-0', {
      nolimit: true,
      scrollToEndAfterLoad: true,
      explicitNavigation: true,
      followGeneration: operation.generation,
    });
    await act(async () => {
      response.resolve(rangeRsp(2, 20));
      await load;
      await flushMicrotasks();
    });
    apiRef.current!.cancelFollowTail('mf-0');
    runNextRaf();
    runNextRaf();
    runNextRaf();
    await act(async () => flushMicrotasks());
    expect(apiRef.current!.messageFeeds[0].readIds.has(2)).toBe(false);
  });

  it('#3360 acknowledges only a verified explicit target and preserves later pending arrivals', async () => {
    const { apiRef, scrollToEnd } = await mountLoadedFeed(true);
    const operation = apiRef.current!.beginExplicitNavigation('mf-0');
    hoisted.fetchInboxMessages.mockResolvedValueOnce(rangeRsp(2, 20));
    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0', {
        nolimit: true,
        scrollToEndAfterLoad: true,
        explicitNavigation: true,
        explicitOperation: operation,
        followGeneration: operation.generation,
      });
      await flushMicrotasks();
    });

    let acknowledgements = 0;
    apiRef.current!.registerExplicitLanding(operation, { id: 20, timestamp: 2000 }, () => {
      acknowledgements += 1;
      apiRef.current!.catchUpFeedUnreadToTail('mf-0', { id: 20, timestamp: 2000 });
    });
    await act(async () => {
      apiRef.current!.setMessageFeeds((feeds) =>
        feeds.map((feed) => ({
          ...feed,
          pendingNewerItems: rangeRsp(21, 21).inboxItems,
          unreadCount: 20,
        })),
      );
      await flushMicrotasks();
    });
    const navigation = apiRef.current!.getExplicitScrollNavigation('mf-0', operation.generation);
    expect(navigation).toBeDefined();
    navigation.onLanded();
    navigation.onLanded();
    await act(async () => flushMicrotasks());

    const feed = apiRef.current!.messageFeeds[0];
    expect(acknowledgements).toBe(1);
    expect(feed.readIds.has(20)).toBe(true);
    expect(feed.readIds.has(21)).toBe(false);
    expect(feed.pendingNewerItems.map(([id]) => id)).toEqual([21]);
    expect(feed.unreadCount).toBe(1);
  });

  it('#3360 makes an explicit target unavailable when its column disappears before deferred landing', async () => {
    const { apiRef, scrollToEnd } = await mountLoadedFeed(true);
    const operation = apiRef.current!.beginExplicitNavigation('mf-0');
    hoisted.fetchInboxMessages.mockResolvedValueOnce(rangeRsp(2, 2));
    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0', {
        scrollToEndAfterLoad: true,
        explicitNavigation: true,
        explicitOperation: operation,
        followGeneration: operation.generation,
      });
      await flushMicrotasks();
    });
    const acknowledge = vi.fn();
    apiRef.current!.registerExplicitLanding(operation, { id: 2, timestamp: 200 }, acknowledge);
    const navigation = apiRef.current!.getExplicitScrollNavigation('mf-0', operation.generation);
    navigation?.onUnavailable();

    expect(acknowledge).not.toHaveBeenCalled();
    expect(apiRef.current!.getExplicitScrollNavigation('mf-0', operation.generation)).toBeNull();
    expect(apiRef.current!.messageFeeds[0].readIds.has(2)).toBe(false);
  });

  it('#3360 makes a superseded landing callback unable to acknowledge the newer operation', async () => {
    const { apiRef } = await mountLoadedFeed(true);
    const first = apiRef.current!.beginExplicitNavigation('mf-0');
    const acknowledged = vi.fn();
    apiRef.current!.registerExplicitLanding(first, { id: 1, timestamp: 100 }, acknowledged);
    const firstNavigation = apiRef.current!.getExplicitScrollNavigation('mf-0', first.generation);
    expect(firstNavigation).not.toBeNull();

    const second = apiRef.current!.beginExplicitNavigation('mf-0');
    firstNavigation?.onLanded();

    expect(acknowledged).not.toHaveBeenCalled();
    expect(apiRef.current!.isExplicitNavigationCurrent(first)).toBe(false);
    expect(apiRef.current!.isExplicitNavigationCurrent(second)).toBe(true);
  });

  it('#3360 keeps a cancelled explicit response unread', async () => {
    const { apiRef } = await mountLoadedFeed(true);
    const generation = apiRef.current!.beginFollowTail('mf-0');
    const response = deferred('cancelled explicit response');
    hoisted.fetchInboxMessages.mockImplementationOnce(() => response.promise);
    const load = apiRef.current!.loadFeedNewerMessages('mf-0', {
      explicitNavigation: true,
      scrollToEndAfterLoad: true,
      followGeneration: generation,
    });
    apiRef.current!.cancelFollowTail('mf-0');
    await act(async () => {
      response.resolve(rangeRsp(2, 20));
      await load;
      await flushMicrotasks();
    });
    expect(apiRef.current!.messageFeeds[0].readIds.has(2)).toBe(false);
  });

  it('#3360 protects visible rows during a physical-bottom background flush', async () => {
    const { apiRef } = await mountLoadedFeed(true);
    await act(async () => {
      apiRef.current!.setMessageFeeds((feeds) =>
        feeds.map((feed) => ({
          ...feed,
          items: rangeRsp(1, 40).inboxItems,
          pendingNewerItems: rangeRsp(41, 60).inboxItems,
        })),
      );
    });
    await act(async () => {
      apiRef.current!.flushPendingNewerMessages('mf-0', {
        urgent: true,
        allowWindowTrim: true,
        protectedItemIds: Array.from({ length: 26 }, (_, index) => index + 15),
      });
      await flushMicrotasks();
    });
    expect(apiRef.current!.messageFeeds[0].items.some(([id]) => id === 15)).toBe(true);
    expect(apiRef.current!.messageFeeds[0].items.at(-1)?.[0]).toBe(54);
    expect(apiRef.current!.messageFeeds[0].pendingNewerItems?.map(([id]) => id)).toEqual([
      55, 56, 57, 58, 59, 60,
    ]);
  });

  it('#3360 keeps reading rows when a delayed ON response arrives after scroll-away', async () => {
    const { apiRef } = await mountLoadedFeed();
    await act(async () => {
      apiRef.current!.setMessageFeeds((feeds) =>
        feeds.map((feed) => ({ ...feed, items: rangeRsp(21, 60).inboxItems })),
      );
    });
    apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = true;
    apiRef.current!.physicallyAtBottomByFeedIdRef.current['mf-0'] = true;
    const generation = apiRef.current!.beginFollowTail('mf-0');
    const response = deferred('reader moved');
    hoisted.fetchInboxMessages.mockImplementationOnce(() => response.promise);
    const load = apiRef.current!.loadFeedNewerMessages('mf-0', {
      scrollToEndAfterLoad: true,
      followGeneration: generation,
    });
    apiRef.current!.cancelFollowTail('mf-0');
    apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = false;
    apiRef.current!.physicallyAtBottomByFeedIdRef.current['mf-0'] = false;
    await act(async () => {
      response.resolve(rangeRsp(61, 80));
      await load;
      await flushMicrotasks();
    });
    expect(apiRef.current!.messageFeeds[0].items.some(([id]) => id === 25)).toBe(true);
  });

  it('#3360 does not let a setting change authorize automatic read advancement', async () => {
    const { apiRef } = await mountLoadedFeed();
    const generation = apiRef.current!.beginFollowTail('mf-0');
    const response = deferred('setting changed');
    hoisted.fetchInboxMessages.mockImplementationOnce(() => response.promise);
    const load = apiRef.current!.loadFeedNewerMessages('mf-0', {
      scrollToEndAfterLoad: true,
      followGeneration: generation,
    });
    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} disableAutoScroll />);
      await flushMicrotasks();
    });
    await act(async () => {
      response.resolve(rangeRsp(2, 20));
      await load;
      await flushMicrotasks();
    });
    expect(apiRef.current!.messageFeeds[0].readIds.has(2)).toBe(false);
  });
  it('preserves confirmed preview count while buffering a near-bottom newer page', async () => {
    const { apiRef } = await mountLoadedFeed();
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
      .mockResolvedValueOnce({ quantity: 21, firstElementTs: null });
    await startPoll();
    await act(async () => {
      await flushMicrotasks();
    });
    expect(apiRef.current!.confirmedTailPreviewByFeedId['mf-0']).toMatchObject({
      tailId: 1,
      count: 21,
    });

    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp([
        [2, minimalInboxMessage({ timestamp: 200 })],
        [3, minimalInboxMessage({ timestamp: 300 })],
        [4, minimalInboxMessage({ timestamp: 400 })],
        [5, minimalInboxMessage({ timestamp: 500 })],
        [6, minimalInboxMessage({ timestamp: 600 })],
      ]),
    );
    await act(async () => {
      apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = true;
      apiRef.current!.physicallyAtBottomByFeedIdRef.current['mf-0'] = false;
      apiRef.current!.cancelFollowTail('mf-0');
      await apiRef.current!.loadFeedNewerMessages('mf-0', { showLoading: false });
    });

    const feed = apiRef.current!.messageFeeds[0];
    expect(feed.items.map(([id]) => id)).toEqual([1]);
    expect(feed.pendingNewerItems?.map(([id]) => id)).toEqual([2, 3, 4, 5, 6]);
    expect(apiRef.current!.confirmedTailPreviewByFeedId['mf-0']).toMatchObject({
      tailId: 1,
      count: 21,
    });
    expect(
      feedIndicatorUnreadCount(feed, apiRef.current!.confirmedTailPreviewByFeedId['mf-0'], {
        includeBeyondTailResidual: false,
      }),
    ).toBe(21);
  });

  it('ignores a preview resolved after an accepted empty newer load', async () => {
    const { apiRef, scrollToEnd } = await mountLoadedFeed();
    const preview = deferred<number>('preview');
    apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = false;
    hoisted.fetchInboxCount
      .mockResolvedValueOnce({ quantity: 1, firstElementTs: null })
      .mockImplementationOnce(() => preview.promise);
    await startPoll();
    const followGeneration = apiRef.current!.beginFollowTail('mf-0');
    hoisted.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([]));
    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0', {
        scrollToEndAfterLoad: true,
        followGeneration,
      });
      preview.resolve(1);
      await flushMicrotasks();
    });
    expect(apiRef.current!.confirmedTailPreviewByFeedId['mf-0']).toBeUndefined();
    expect(apiRef.current!.messageFeeds[0].items.map(([id]) => id)).toEqual([1]);
    expect(apiRef.current!.messageFeeds[0].readIds).toEqual(new Set([1]));
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it('ignores a preview resolved after filter invalidation', async () => {
    const { apiRef, scrollToEnd } = await mountLoadedFeed();
    const preview = deferred<number>('preview');
    apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = false;
    hoisted.fetchInboxCount
      .mockResolvedValueOnce({ quantity: 1, firstElementTs: null })
      .mockImplementationOnce(() => preview.promise);
    await startPoll();
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp([[3, minimalInboxMessage({ timestamp: 300 })]]),
    );
    await act(async () => {
      apiRef.current!.applyFilter('mf-0', { ...emptyFilter(), groupsSelected: ['g-1'] });
      await flushMicrotasks();
      preview.resolve(1);
      await flushMicrotasks();
    });
    expect(apiRef.current!.confirmedTailPreviewByFeedId['mf-0']).toBeUndefined();
    expect(apiRef.current!.messageFeeds[0].readIds).toEqual(new Set([3]));
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it('ignores a preview resolved after feed removal', async () => {
    const { apiRef, scrollToEnd } = await mountLoadedFeed();
    const preview = deferred<number>('preview');
    apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = false;
    hoisted.fetchInboxCount
      .mockResolvedValueOnce({ quantity: 1, firstElementTs: null })
      .mockImplementationOnce(() => preview.promise);
    await startPoll();
    await act(async () => {
      apiRef.current!.createMessageFeed();
      await flushMicrotasks();
    });
    await act(async () => {
      apiRef.current!.removeMessageFeed('mf-0');
      preview.resolve(1);
      await flushMicrotasks();
    });
    expect(apiRef.current!.confirmedTailPreviewByFeedId['mf-0']).toBeUndefined();
    expect(apiRef.current!.messageFeeds.map((feed) => feed.id)).not.toContain('mf-0');
    expect(scrollToEnd).not.toHaveBeenCalled();
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

    const reloadA = deferred<InboxMessagesRsp>('reloadA');
    const reloadB = deferred<InboxMessagesRsp>('reloadB');
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
    await act(async () => {
      await flushMicrotasks();
    });
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
    expect(hoisted.notifyDutyNewMessages).toHaveBeenLastCalledWith(
      'mf-0',
      2,
      hoisted.beginDutyNotificationPollCycle.mock.results.at(-1)?.value,
    );

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
    expect(apiRef.current?.error).toBe('count failed');

    hoisted.fetchInboxCount.mockResolvedValueOnce({ quantity: 5, firstElementTs: null });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(hoisted.notifyDutyNewMessages).not.toHaveBeenCalled();
    expect(apiRef.current?.error).toBeNull();
  });

  it('keeps empty feeds from notifying even when count responses are positive', async () => {
    hoisted.fetchInboxMessages.mockResolvedValue(inboxRsp([], null));

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

    const staleCount = deferred<{ quantity: number; firstElementTs: number | null }>('staleCount');
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
    expect(hoisted.notifyDutyNewMessages).not.toHaveBeenCalled();

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
    expect(hoisted.notifyDutyNewMessages).toHaveBeenLastCalledWith(
      'mf-0',
      2,
      hoisted.beginDutyNotificationPollCycle.mock.results.at(-1)?.value,
    );
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

    const newerResponse = deferred<InboxMessagesRsp>('newerResponse');
    hoisted.fetchInboxMessages.mockImplementationOnce(() => newerResponse.promise);

    let loadPromise!: Promise<void>;
    act(() => {
      apiRef.current!.setMessageFeeds((prev) =>
        prev.map((feed) => (feed.id === 'mf-0' ? { ...feed, unreadCount: 25 } : feed)),
      );
      const followGeneration = apiRef.current!.beginFollowTail('mf-0');
      loadPromise = apiRef.current!.loadFeedNewerMessages('mf-0', {
        scrollToEndAfterLoad: true,
        followGeneration,
      });
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
    expect(feedAfterAppend.unreadCount).toBe(0);

    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp([[81, minimalInboxMessage({ timestamp: 8100 })]]),
    );
    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0', {
        skipIfNewestExhausted: true,
        scrollToEndAfterLoad: true,
        followGeneration: apiRef.current!.ensureFollowTail('mf-0'),
      });
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
    expectTailCountRequest(10);

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
    expectTailCountRequest(10);
    expect(hoisted.notifyDutyNewMessages).toHaveBeenCalledTimes(1);
    expect(hoisted.notifyDutyNewMessages).toHaveBeenLastCalledWith(
      'mf-0',
      2,
      hoisted.beginDutyNotificationPollCycle.mock.results.at(-1)?.value,
    );

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
    expect(hoisted.notifyDutyNewMessages).toHaveBeenLastCalledWith(
      'mf-0',
      2,
      hoisted.beginDutyNotificationPollCycle.mock.results.at(-1)?.value,
    );
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

    expectTailCountRequest(10);
    expect(apiRef.current?.messageFeeds[0]?.unreadCount).toBe(7);
    expect(hoisted.notifyDutyNewMessages).toHaveBeenCalledTimes(1);
    expect(hoisted.notifyDutyNewMessages).toHaveBeenLastCalledWith(
      'mf-0',
      2,
      hoisted.beginDutyNotificationPollCycle.mock.results.at(-1)?.value,
    );
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

    const newerResponse = deferred<InboxMessagesRsp>('newerResponse');
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

    const newerResponse = deferred<InboxMessagesRsp>('newerResponse');
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

    expectTailCountRequest(12);
    expect(apiRef.current?.messageFeeds[0]?.unreadCount).toBe(3);
    expect(hoisted.notifyDutyNewMessages).not.toHaveBeenCalled();
  });

  it('resets an unsafe unread cursor before evicted unread IDs until they are read', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: 40 }, (_, index) => [
          index + 1,
          minimalInboxMessage({ timestamp: (index + 1) * 100 }),
        ]),
      ),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };
    await act(async () => root.render(<TestHarness apiRef={apiRef} />));
    await act(async () => flushMicrotasks());
    apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = true;
    hoisted.fetchInboxCount.mockResolvedValueOnce({ quantity: 0, firstElementTs: null });
    await startPoll();
    await act(async () => flushMicrotasks());
    expectTailCountRequest(40);
    hoisted.notifyDutyNewMessages.mockReset();
    const windowedUnreadItems = new Map(
      Array.from({ length: 100000 }, (_, index) => [index + 41, (index + 41) * 100]),
    );
    windowedUnreadItems.set(900, 100);
    await act(async () =>
      apiRef.current!.setMessageFeeds((feeds) =>
        feeds.map((feed) => ({
          ...feed,
          items: Array.from({ length: 20 }, (_, index) => [
            index + 61,
            minimalInboxMessage({ timestamp: (index + 61) * 100 }),
          ]),
          readIds: new Set(Array.from({ length: 20 }, (_, index) => index + 61)),
          windowedUnreadItems,
        })),
      ),
    );
    apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = true;
    const countCallsBeforeRewind = hoisted.fetchInboxCount.mock.calls.length;
    hoisted.fetchInboxCount.mockResolvedValueOnce({ quantity: 5, firstElementTs: null });
    await startPoll();
    await act(async () => flushMicrotasks());
    const rewindRequests = hoisted.fetchInboxCount.mock.calls
      .slice(countCallsBeforeRewind)
      .map(([request]) => request);
    expect(rewindRequests[0]).toEqual(
      expect.objectContaining({ sinceIdNoninclusive: null, nolimit: true }),
    );
    expect(rewindRequests.some((request) => request?.sinceIdNoninclusive === 40)).toBe(false);
    expect(hoisted.notifyDutyNewMessages).not.toHaveBeenCalled();

    await act(async () =>
      apiRef.current!.setMessageFeeds((feeds) =>
        feeds.map((feed) => ({
          ...feed,
          readIds: new Set(feed.readIds),
          windowedUnreadItems: new Map<number, number>(),
        })),
      ),
    );
    await act(async () => flushMicrotasks());
    hoisted.fetchInboxCount.mockResolvedValueOnce({ quantity: 1, firstElementTs: null });
    await startPoll();
    await act(async () => flushMicrotasks());
    hoisted.fetchInboxCount.mockResolvedValueOnce({ quantity: 1, firstElementTs: null });
    await startPoll();
    await act(async () => flushMicrotasks());
    expectTailCountRequest(80);
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
    expect(hoisted.notifyDutyNewMessages).toHaveBeenCalledWith(
      'mf-0',
      1,
      hoisted.beginDutyNotificationPollCycle.mock.results.at(-1)?.value,
    );
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
      expect(feed.items.map(([id]) => id)).toEqual([1]);
      expect(feed.pendingNewerItems?.map(([id]) => id)).toEqual([2]);
      expect(feed.readIds.has(2)).toBe(false);
      expect(feed.unreadCount).toBeGreaterThan(0);
    });

    // #3360: background polling cannot replace the visible window while automatic follow is off.
    it('buffers without marking read when user prefs disable auto-scroll even at bottom', async () => {
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
      expect(feed.items.map(([id]) => id)).toEqual([1]);
      expect(feed.pendingNewerItems?.map(([id]) => id)).toEqual([2]);
      expect(feed.readIds.has(2)).toBe(false);
      expect(feed.unreadCount).toBeGreaterThan(0);
    });

    it('#3360 keeps a full reading window intact during a non-physical pending flush', async () => {
      const { apiRef } = await mountLoadedFeed();
      const items = Array.from(
        { length: DUTY_FEED_MESSAGE_WINDOW_LIMIT },
        (_, index) => [index + 1, minimalInboxMessage({ timestamp: (index + 1) * 100 })] as const,
      );
      await act(async () => {
        apiRef.current!.setMessageFeeds((feeds) =>
          feeds.map((feed) => ({
            ...feed,
            items: [...items],
            pendingNewerItems: [[41, minimalInboxMessage({ timestamp: 4100 })]],
          })),
        );
        await flushMicrotasks();
      });

      await act(async () => {
        apiRef.current!.flushPendingNewerMessages('mf-0', {
          allowWindowTrim: false,
          protectedItemIds: [1],
        });
        await flushMicrotasks();
      });

      const feed = apiRef.current!.messageFeeds[0];
      expect(feed.items.map(([id]) => id)).toEqual(items.map(([id]) => id));
      expect(feed.pendingNewerItems?.map(([id]) => id)).toEqual([41]);
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
      expect(feed.items.map(([id]) => id)).toEqual([1]);
      expect(feed.pendingNewerItems?.map(([id]) => id)).toEqual([2]);
      expect(feed.readIds.has(2)).toBe(false);
      expect(feed.unreadCount).toBeGreaterThan(0);
    });
  });
});
