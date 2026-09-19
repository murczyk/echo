/**
 * @vitest-environment happy-dom
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
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
import { useRerDutyFeedInteractionActions } from './useRerDutyFeedInteractionActions';
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

describe('useRerDutyFeedState — follow tail and scheduled scrolling', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    ({ container, root } = fixture.setup());
  });

  afterEach(fixture.cleanup);
  it('cancels follow while newer messages are pending', async () => {
    const { apiRef, scrollToEnd } = await mountLoadedFeed();
    const generation = apiRef.current!.beginFollowTail('mf-0');
    const newer = deferred<InboxMessagesRsp>('newer');
    hoisted.fetchInboxMessages.mockImplementationOnce(() => newer.promise);

    const load = apiRef.current!.loadFeedNewerMessages('mf-0', {
      scrollToEndAfterLoad: true,
      followGeneration: generation,
    });
    apiRef.current!.cancelFollowTail('mf-0');
    await act(async () => {
      newer.resolve(inboxRsp([[2, minimalInboxMessage({ createdAtOrder: 200 })]]));
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
    const count = deferred<{ quantity: number; firstElementTs: number | null }>('count');
    hoisted.fetchInboxCount.mockImplementationOnce(() => count.promise);

    await startPoll();
    expect(hoisted.fetchInboxCount).toHaveBeenCalledTimes(1);
    apiRef.current!.cancelFollowTail('mf-0');
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp([[2, minimalInboxMessage({ createdAtOrder: 200 })]]),
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
      inboxRsp([[2, minimalInboxMessage({ createdAtOrder: 200 })]]),
    );

    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0', {
        scrollToEndAfterLoad: true,
        followGeneration: generation,
        explicitNavigation: true,
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
      inboxRsp([[2, minimalInboxMessage({ createdAtOrder: 200 })]]),
    );

    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0', {
        scrollToEndAfterLoad: true,
        followGeneration: generation,
      });
      await flushMicrotasks();
    });
    expect(fixture.queuedRafCount).toBe(1);
    runNextRaf();
    apiRef.current!.cancelFollowTail('mf-0');
    runNextRaf();
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it('does not let an obsolete RAF suppress a newer follow generation', async () => {
    const { apiRef, scrollToEnd } = await mountLoadedFeed();
    const firstGeneration = apiRef.current!.beginFollowTail('mf-0');
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp([[2, minimalInboxMessage({ createdAtOrder: 200 })]]),
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
      inboxRsp([[3, minimalInboxMessage({ createdAtOrder: 300 })]]),
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
    expect(scrollToEnd).toHaveBeenCalledWith('smooth', { intent: 'automatic-follow' });
  });

  it('#3360 lands an OFF arrow operation once after its target renders', async () => {
    const { apiRef, scrollToEnd } = await mountLoadedFeed(true);
    let handleArrowClick: ((feedId: string) => Promise<void>) | null = null;
    function ArrowActions() {
      const feedState = apiRef.current!;
      handleArrowClick = useRerDutyFeedInteractionActions({
        messageFeeds: feedState.messageFeeds,
        showArrowResult: feedState.showArrowResult,
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
        getExplicitScrollNavigation: feedState.getExplicitScrollNavigation,
        registerExplicitLoading: feedState.registerExplicitLoading,
        cancelExplicitNavigation: feedState.cancelExplicitNavigation,
        registerExplicitScheduledWork: feedState.registerExplicitScheduledWork,
        clearExplicitScheduledWork: feedState.clearExplicitScheduledWork,
      }).handleArrowClick;
      return null;
    }
    const host = document.createElement('div');
    const actionRoot = createRoot(host);
    document.body.appendChild(host);
    hoisted.fetchInboxCount.mockResolvedValueOnce({ quantity: 1, firstElementTs: null });
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp([[2, minimalInboxMessage({ createdAtOrder: 200 })]]),
    );

    try {
      await act(async () => actionRoot.render(<ArrowActions />));
      await act(async () => {
        await handleArrowClick!('mf-0');
        await flushMicrotasks();
      });
      expect(apiRef.current!.messageFeeds[0].readIds.has(2)).toBe(false);

      runNextRaf();
      expect(scrollToEnd).toHaveBeenCalledTimes(1);
      const navigation = scrollToEnd.mock.calls[0][1]?.navigation;
      expect(navigation).toMatchObject({ targetId: 2, feedId: 'mf-0' });
      expect(navigation?.isCurrent()).toBe(true);

      navigation?.onLanded();
      runNextRaf();
      runNextRaf();
      await act(async () => flushMicrotasks());

      expect(scrollToEnd).toHaveBeenCalledTimes(1);
      expect(apiRef.current!.messageFeeds[0].readIds.has(2)).toBe(true);
      expect(apiRef.current!.arrowResultByFeedId['mf-0']).toBe('Завантажено нові повідомлення');
    } finally {
      act(() => actionRoot.unmount());
      host.remove();
    }
  });

  it('restores available after a confirmed-tail request fails', async () => {
    const { apiRef } = await mountLoadedFeed();
    const newer = deferred<InboxMessagesRsp>('newer');
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
    expect(apiRef.current!.error).toBe('network down');
  });

  it('does not expose a blind background failure as available tail content', async () => {
    const { apiRef } = await mountLoadedFeed();
    const newer = deferred<InboxMessagesRsp>('newer');
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
    const tailCount = deferred<{ quantity: number; firstElementTs: number | null }>('tailCount');
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

  it('buffers available tail content after returning near bottom without changing loaded items', async () => {
    const { apiRef } = await mountLoadedFeed();
    const failedConfirmation = deferred<InboxMessagesRsp>('failedConfirmation');
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
    const newer = deferred<InboxMessagesRsp>('newer');
    hoisted.fetchInboxMessages.mockImplementationOnce(() => newer.promise);
    await startPoll();
    expect(apiRef.current!.tailAvailabilityByFeedId['mf-0']).toBe('loading');
    await act(async () => {
      newer.resolve(inboxRsp([[2, minimalInboxMessage({ createdAtOrder: 200 })]]));
      await flushMicrotasks();
    });
    const feed = apiRef.current!.messageFeeds[0];
    expect(feed.items.map(([id]) => id)).toEqual([1]);
    expect(feed.pendingNewerItems?.map(([id]) => id)).toEqual([2]);
    expect(
      feedIndicatorUnreadCount(feed, apiRef.current!.confirmedTailPreviewByFeedId['mf-0'], {
        includeBeyondTailResidual: false,
      }),
    ).toBe(1);
    expect(apiRef.current!.tailAvailabilityByFeedId['mf-0']).toBe('exhausted');
  });

  it('marks an available tail exhausted when retry returns no messages', async () => {
    const { apiRef } = await mountLoadedFeed();
    const failedConfirmation = deferred<InboxMessagesRsp>('failedConfirmation');
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
    const newer = deferred<InboxMessagesRsp>('newer');
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
    const newer = deferred<InboxMessagesRsp>('newer');
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
    const staleNewer = deferred<InboxMessagesRsp>('staleNewer');
    const reload = deferred<InboxMessagesRsp>('reload');
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
      reload.resolve(inboxRsp([[3, minimalInboxMessage({ createdAtOrder: 300 })]]));
      await flushMicrotasks();
    });
    expect(apiRef.current!.tailAvailabilityByFeedId['mf-0']).not.toBe('available');
  });

  it('upgrades an in-flight blind request when confirmed availability coalesces', async () => {
    const { apiRef } = await mountLoadedFeed();
    const newer = deferred<InboxMessagesRsp>('newer');
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
});
