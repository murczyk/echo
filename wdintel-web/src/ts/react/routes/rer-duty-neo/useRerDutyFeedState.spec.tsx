/**
 * @vitest-environment happy-dom
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage, InboxMessagesRsp } from '../../../../Bindings';
import { minimalInboxMessage } from './inbox-message-mocks';
import { emptyFilter } from './utils';
import { useRerDutyFeedState } from './useRerDutyFeedState';

const hoisted = vi.hoisted(() => ({
  fetchInboxMessages: vi.fn(),
  fetchInboxCount: vi.fn(),
  rerDutyShortStateCreate: vi.fn(),
  rerDutyShortStateGet: vi.fn(),
  fetchServerInfo: vi.fn(),
}));

vi.mock('../../services/api/inbox', () => ({
  fetchInboxMessages: hoisted.fetchInboxMessages,
  fetchInboxCount: hoisted.fetchInboxCount,
  rerDutyShortStateCreate: hoisted.rerDutyShortStateCreate,
  rerDutyShortStateGet: hoisted.rerDutyShortStateGet,
}));

vi.mock('../../services/api/server-info', () => ({
  fetchServerInfo: hoisted.fetchServerInfo,
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

describe('useRerDutyFeedState — loading', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    hoisted.fetchInboxMessages.mockReset();
    hoisted.fetchInboxCount.mockReset();
    window.history.replaceState({}, '', '/');
    hoisted.fetchInboxCount.mockResolvedValue({ quantity: 0, firstElementTs: null });
    hoisted.fetchInboxMessages.mockResolvedValue(inboxRsp([[1, minimalInboxMessage({ timestamp: 100 })]]));
    hoisted.fetchServerInfo.mockResolvedValue({
      mode: '',
      publicHost: '',
      grafanaAddress: '',
      featureDelta: false,
      featureAnalysisMap: false,
      featureRerDutyShortState: false,
      featureStrictNetworks: false,
      version: '',
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
  });

  it('runs a single get-inbox initial load per feed on mount', async () => {
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = { current: null };
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

  it('sets error and clears loading when initial get-inbox fails', async () => {
    hoisted.fetchInboxMessages.mockRejectedValueOnce(new Error('network down'));

    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = { current: null };
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

  it('updates unreadCount from poll when count > 0 and column has items', async () => {
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = { current: null };
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

    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = { current: null };
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
    hoisted.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([[10, minimalInboxMessage({ timestamp: null })]]));

    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = { current: null };
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
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = { current: null };
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

  it('calls get-inbox for newer mail when watch mode is on', async () => {
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = { current: null };
    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    hoisted.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([[3, minimalInboxMessage({ timestamp: 300 })]]));
    hoisted.fetchInboxCount.mockResolvedValue({ quantity: 1, firstElementTs: null });

    await act(async () => {
      apiRef.current!.setWatchModeByFeedId((prev) => ({ ...prev, 'mf-0': true }));
      apiRef.current!.atBottomByFeedIdRef.current['mf-0'] = true;
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
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = { current: null };
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

  it('does not call get-inbox for newer when column has no items (loadFeedNewerMessages no-op)', async () => {
    hoisted.fetchInboxMessages.mockResolvedValue(inboxRsp([]));

    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = { current: null };
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

  it('does not start a second get-inbox-count for a feed while the first is still in flight', async () => {
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = { current: null };
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
      hoisted.fetchServerInfo.mockResolvedValueOnce({
        mode: '',
        publicHost: '',
        grafanaAddress: '',
        featureDelta: false,
        featureAnalysisMap: false,
        featureRerDutyShortState: true,
        featureStrictNetworks: false,
        version: '',
      });
      hoisted.rerDutyShortStateCreate.mockResolvedValue({ id: 'short-123' });

      const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = { current: null };
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
      hoisted.fetchServerInfo.mockResolvedValueOnce({
        mode: '',
        publicHost: '',
        grafanaAddress: '',
        featureDelta: false,
        featureAnalysisMap: false,
        featureRerDutyShortState: true,
        featureStrictNetworks: false,
        version: '',
      });
      hoisted.rerDutyShortStateCreate.mockRejectedValue(new Error('create failed'));

      const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = { current: null };
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
      const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = { current: null };
      await act(async () => {
        root.render(<TestHarness apiRef={apiRef} />);
      });
      await act(async () => {
        await flushMicrotasks();
      });

      hoisted.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([[2, minimalInboxMessage({ timestamp: 200 })]]));
      hoisted.fetchInboxCount.mockResolvedValue({ quantity: 1, firstElementTs: null });

      await act(async () => {
        apiRef.current!.setWatchModeByFeedId((prev) => ({ ...prev, 'mf-0': true }));
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
      expect(feed.readIds.has(1) && feed.readIds.has(2)).toBe(true);
      expect(feed.unreadCount).toBe(0);
    });

    it('does not mark-all-read on newer mail when watch mode but not at pixel bottom (autoscroll off)', async () => {
      const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = { current: null };
      await act(async () => {
        root.render(<TestHarness apiRef={apiRef} />);
      });
      await act(async () => {
        await flushMicrotasks();
      });

      hoisted.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([[2, minimalInboxMessage({ timestamp: 200 })]]));
      hoisted.fetchInboxCount.mockResolvedValue({ quantity: 1, firstElementTs: null });

      await act(async () => {
        apiRef.current!.setWatchModeByFeedId((prev) => ({ ...prev, 'mf-0': true }));
        apiRef.current!.atBottomByFeedIdRef.current['mf-0'] = false;
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
      const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = { current: null };
      await act(async () => {
        root.render(<TestHarness apiRef={apiRef} disableAutoScroll />);
      });
      await act(async () => {
        await flushMicrotasks();
      });

      hoisted.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([[2, minimalInboxMessage({ timestamp: 200 })]]));
      hoisted.fetchInboxCount.mockResolvedValue({ quantity: 1, firstElementTs: null });

      await act(async () => {
        apiRef.current!.setWatchModeByFeedId((prev) => ({ ...prev, 'mf-0': true }));
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

    it('does not mark-all-read when only near-bottom (range) is true without watch mode', async () => {
      const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = { current: null };
      await act(async () => {
        root.render(<TestHarness apiRef={apiRef} />);
      });
      await act(async () => {
        await flushMicrotasks();
      });

      hoisted.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([[2, minimalInboxMessage({ timestamp: 200 })]]));
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
  });
});
