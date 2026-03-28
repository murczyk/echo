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
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

describe('useRerDutyFeedState', () => {
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

  it('runs a single get-inbox initial load on mount (no duplicate poll bootstrap)', async () => {
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = { current: null };
    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(1);
    expect(apiRef.current?.messageFeeds[0]?.items[0]?.[0]).toBe(1);
  });

  it('supersedes an in-flight initial load so stale responses are not applied', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    hoisted.fetchInboxMessages
      .mockImplementationOnce(async (_req, signal) => {
        await firstGate;
        if (signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        return inboxRsp([[1, minimalMessage({ timestamp: 10, text: 'stale' })]]);
      })
      .mockResolvedValueOnce(inboxRsp([[2, minimalMessage({ timestamp: 20, text: 'fresh' })]]))
      .mockResolvedValue(inboxRsp([]));

    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = { current: null };
    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(1);

    await act(async () => {
      apiRef.current!.loadFeedInitialMessages('mf-0');
      await Promise.resolve();
    });

    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(2);

    await act(async () => {
      releaseFirst();
      await flushMicrotasks();
    });

    const row = apiRef.current!.messageFeeds[0];
    expect(row.items).toHaveLength(1);
    expect(row.items[0][0]).toBe(2);
    expect(row.items[0][1].text).toBe('fresh');
  });

  it('uses poll only to set loading; effect performs the extra get-inbox when empty column has new mail', async () => {
    hoisted.fetchInboxMessages
      .mockResolvedValueOnce(inboxRsp([]))
      .mockResolvedValueOnce(inboxRsp([[7, minimalMessage({ timestamp: 50 })]]))
      .mockResolvedValue(inboxRsp([]));

    hoisted.fetchInboxCount.mockResolvedValue({ quantity: 3, firstElementTs: null });

    vi.useFakeTimers();
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = { current: null };
    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(apiRef.current?.messageFeeds[0]?.loading).toBe(false);
    expect(apiRef.current?.messageFeeds[0]?.items).toHaveLength(0);
    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(1);

    hoisted.fetchInboxMessages.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(1);
    expect(apiRef.current?.messageFeeds[0]?.items[0]?.[0]).toBe(7);
  });

  it('starts a new poll tick even when the previous count round is still in flight (no whole-page stall)', async () => {
    hoisted.fetchInboxMessages.mockResolvedValue(inboxRsp([]));

    let startedCount = 0;
    hoisted.fetchInboxCount.mockImplementation(
      () =>
        new Promise<{ quantity: number; firstElementTs: number | null }>((resolve) => {
          startedCount++;
          setTimeout(() => resolve({ quantity: 0, firstElementTs: null }), 2000);
        }),
    );

    vi.useFakeTimers();
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = { current: null };
    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    const countBeforePolls = startedCount;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(startedCount).toBe(countBeforePolls + 1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(startedCount).toBe(countBeforePolls + 2);
  });
});
