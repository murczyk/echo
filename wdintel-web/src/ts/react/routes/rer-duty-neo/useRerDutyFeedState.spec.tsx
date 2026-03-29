/**
 * @vitest-environment happy-dom
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage, InboxMessagesRsp } from '../../../../Bindings';
import { useRerDutyFeedState } from './useRerDutyFeedState';

const hoisted = vi.hoisted(() => ({
  fetchInboxMessages: vi.fn(),
  fetchInboxCount: vi.fn(),
}));

vi.mock('../../services/api/inbox', () => ({
  fetchInboxMessages: hoisted.fetchInboxMessages,
  fetchInboxCount: hoisted.fetchInboxCount,
}));

vi.mock('../../services/api/networks', () => ({
  getNetworksByIds: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../../services/api/units', () => ({
  getUnitsList: vi.fn(() => Promise.resolve([])),
}));

function minimalMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    messageUid: null,
    text: '',
    media: [],
    images: [],
    imageRecognized: [],
    date: null,
    time: null,
    freq: null,
    coords: null,
    callsigns: [],
    callsignsAlg2: [],
    checked: false,
    important: false,
    bookmarked: false,
    timestamp: 1,
    groupMasterKey: null,
    sender: null,
    extendedForm: null,
    post: null,
    postId: null,
    unit: null,
    callsignTokens: null,
    signalTokens: null,
    pointTokens: null,
    noHeadersBody: null,
    keywordTokens: null,
    textMarked: null,
    datasourceId: null,
    location: null,
    tags: null,
    networkIds: null,
    inboxTags: null,
    metadata: [],
    ...overrides,
  };
}

function inboxRsp(items: Array<[number, InboxMessage]>): InboxMessagesRsp {
  return {
    inboxItems: items,
    callsigns: [],
    signalProfiles: {},
    signalGroups: [],
    freqPelengsSummary: null,
  };
}

function TestHarness(props: {
  apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null>;
}) {
  const api = useRerDutyFeedState({
    freqs: [],
    setProfiles: vi.fn(),
    setGroupInfos: vi.fn(),
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
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/');
    hoisted.fetchInboxCount.mockResolvedValue({ quantity: 0, firstElementTs: null });
    hoisted.fetchInboxMessages.mockResolvedValue(inboxRsp([[1, minimalMessage({ timestamp: 100 })]]));
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

    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(apiRef.current?.messageFeeds[0]?.unreadCount).toBe(4);
    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(1);
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
      inboxRsp([[2, minimalMessage({ timestamp: 200, text: 'newer' })]]),
    );

    await act(async () => {
      apiRef.current!.nearBottomByFeedIdRef.current['mf-0'] = true;
    });

    hoisted.fetchInboxCount.mockResolvedValue({ quantity: 1, firstElementTs: null });

    vi.useFakeTimers();
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

    hoisted.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([[3, minimalMessage({ timestamp: 300 })]]));
    hoisted.fetchInboxCount.mockResolvedValue({ quantity: 1, firstElementTs: null });

    await act(async () => {
      apiRef.current!.setWatchModeByFeedId((prev) => ({ ...prev, 'mf-0': true }));
    });

    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(2);
    expect(apiRef.current!.messageFeeds[0].items.map(([id]) => id).sort()).toEqual([1, 3]);
  });

  it('does not call get-inbox for newer when column has no items (loadFeedNewerMessages no-op)', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([]));

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

    vi.useFakeTimers();
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

    vi.useFakeTimers();
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
});
