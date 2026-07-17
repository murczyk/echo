/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';

import { useAnalysisMessageList } from './use-analysis-message-list';
import { emptyQueryState } from './helpers';
import type { InboxMessage } from '../../../../Bindings';

const fetchInboxMessagesMock = vi.hoisted(() => vi.fn());
const fetchInboxCountMock = vi.hoisted(() => vi.fn());

vi.mock('../../services/api/analysis', () => ({
  fetchInboxCount: fetchInboxCountMock,
  fetchInboxMessages: fetchInboxMessagesMock,
}));

function buildMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    text: '',
    freq: '',
    sender: null,
    bookmarked: false,
    important: false,
    extendedForm: null,
    noHeadersBody: null,
    callsigns: [],
    groupMasterKey: null,
    networkIds: [],
    tags: [],
    ...overrides,
  } as InboxMessage;
}

function page(id: number): Array<[number, InboxMessage]> {
  return [[id, buildMessage()]];
}

function buildQueryState() {
  return {
    ...emptyQueryState(),
    fromDateTimeStr: '2026-04-01T00:00',
    toDateTimeStr: '2026-04-02T00:00',
  };
}

type Harness = {
  container: HTMLDivElement;
  root: Root;
  latest: ReturnType<typeof useAnalysisMessageList>;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function renderHook(
  queryState = buildQueryState(),
  loadMissingNetworksForMessages = vi.fn().mockResolvedValue(undefined),
): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const harness = { container, root } as Harness;

  function TestComponent() {
    harness.latest = useAnalysisMessageList({
      loadMissingNetworksForMessages,
      newestFirst: true,
      onError: vi.fn(),
      onUnauthorized: vi.fn().mockReturnValue(false),
      optionsFreqValues: [],
      queryState,
      setSummaryCallsignsInfo: vi.fn(),
    });
    return null;
  }

  act(() => {
    root.render(createElement(TestComponent));
  });

  return harness;
}

describe('useAnalysisMessageList pagination', () => {
  const harnesses: Harness[] = [];

  beforeEach(() => {
    fetchInboxMessagesMock.mockReset();
    fetchInboxCountMock.mockReset();
    fetchInboxCountMock.mockResolvedValue({ quantity: 42, firstElementTs: null });
  });

  afterEach(() => {
    for (const h of harnesses.splice(0)) {
      act(() => h.root.unmount());
      h.container.remove();
    }
    vi.useRealTimers();
  });

  it('starts at pageIndex 0', () => {
    const h = renderHook();
    harnesses.push(h);
    expect(h.latest.pageIndex).toBe(0);
  });

  it('loads the total count using the same inbox filters', async () => {
    vi.useFakeTimers();
    const h = renderHook();
    harnesses.push(h);

    expect(fetchInboxCountMock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(h.latest.messagesTotalCount).toBe(42);
    expect(h.latest.messagesOverallCount).toBe(42);
    expect(h.latest.messagesTotalLoading).toBe(false);
    expect(fetchInboxCountMock).toHaveBeenCalledWith(
      expect.objectContaining({ nolimit: true, onlyWithMedia: false, newestFirst: true }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('loads separate selected and overall counts when filters are active', async () => {
    vi.useFakeTimers();
    fetchInboxCountMock
      .mockResolvedValueOnce({ quantity: 42, firstElementTs: null })
      .mockResolvedValueOnce({ quantity: 137, firstElementTs: null });
    const h = renderHook({ ...buildQueryState(), search: 'filtered' });
    harnesses.push(h);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(fetchInboxCountMock).toHaveBeenCalledTimes(2);
    expect(h.latest.messagesTotalCount).toBe(42);
    expect(h.latest.messagesOverallCount).toBe(137);
  });

  it('loadNextPage replaces messages, increments pageIndex, and cursors from the last message', async () => {
    const h = renderHook();
    harnesses.push(h);

    await act(async () => {
      await h.latest.setMessages(page(1));
    });

    fetchInboxMessagesMock.mockResolvedValueOnce({
      inboxItems: page(2),
      callsigns: [],
      pageLimit: 20,
    });
    await act(async () => {
      await h.latest.loadNextPage();
    });

    expect(h.latest.pageIndex).toBe(1);
    expect(h.latest.messages).toEqual(page(2));
    const lastCall = fetchInboxMessagesMock.mock.calls.at(-1)?.[0];
    expect(lastCall.beforeIdNoninclusive).toBe(1);
  });

  it('does not advance a stale page request after message hydration', async () => {
    const hydration = deferred<void>();
    const h = renderHook(
      buildQueryState(),
      vi.fn(() => hydration.promise),
    );
    harnesses.push(h);
    await act(async () => {
      h.latest.setMessages(page(1));
    });
    fetchInboxMessagesMock.mockResolvedValueOnce({
      inboxItems: page(2),
      callsigns: [],
      pageLimit: 20,
    });

    let nextPagePromise!: Promise<void>;
    await act(async () => {
      nextPagePromise = h.latest.loadNextPage();
      await Promise.resolve();
    });
    act(() => {
      h.latest.invalidateMessagePaging();
    });
    hydration.resolve();
    await act(async () => {
      await nextPagePromise;
    });

    expect(h.latest.pageIndex).toBe(0);
    expect(h.latest.noMoreToLoad).toBe(false);
  });

  it('keeps the current page when the next page is empty', async () => {
    const currentMessages = Array.from({ length: 20 }, (_, index) => [
      100 - index,
      buildMessage(),
    ]) as Array<[number, InboxMessage]>;
    const h = renderHook();
    harnesses.push(h);
    await act(async () => {
      h.latest.setMessages(currentMessages);
    });
    fetchInboxMessagesMock.mockResolvedValueOnce({
      inboxItems: [],
      callsigns: [],
      pageLimit: 20,
    });

    await act(async () => {
      await h.latest.loadNextPage();
    });

    expect(h.latest.messages).toEqual(currentMessages);
    expect(h.latest.pageIndex).toBe(0);
    expect(h.latest.noMoreToLoad).toBe(true);
  });

  it('loadPrevPage is a no-op at pageIndex 0', async () => {
    const h = renderHook();
    harnesses.push(h);

    await act(async () => {
      await h.latest.loadPrevPage();
    });

    expect(fetchInboxMessagesMock).not.toHaveBeenCalled();
    expect(h.latest.pageIndex).toBe(0);
  });

  it('loadPrevPage re-fetches page 0 using the remembered cursor after going to page 1', async () => {
    const h = renderHook();
    harnesses.push(h);

    await act(async () => {
      await h.latest.setMessages(page(1));
    });

    fetchInboxMessagesMock.mockResolvedValueOnce({
      inboxItems: page(2),
      callsigns: [],
      pageLimit: 20,
    });
    await act(async () => {
      await h.latest.loadNextPage();
    });

    fetchInboxMessagesMock.mockResolvedValueOnce({
      inboxItems: page(1),
      callsigns: [],
      pageLimit: 20,
    });
    await act(async () => {
      await h.latest.loadPrevPage();
    });

    expect(h.latest.pageIndex).toBe(0);
    expect(h.latest.messages).toEqual(page(1));
    const lastCall = fetchInboxMessagesMock.mock.calls.at(-1)?.[0];
    expect(lastCall.beforeIdNoninclusive).toBeNull();
    expect(lastCall.sinceIdNoninclusive).toBeNull();
  });

  it('invalidateMessagePaging resets pageIndex to 0', async () => {
    const h = renderHook();
    harnesses.push(h);

    await act(async () => {
      await h.latest.setMessages(page(1));
    });
    fetchInboxMessagesMock.mockResolvedValueOnce({
      inboxItems: page(2),
      callsigns: [],
      pageLimit: 20,
    });
    await act(async () => {
      await h.latest.loadNextPage();
    });
    expect(h.latest.pageIndex).toBe(1);

    act(() => {
      h.latest.invalidateMessagePaging();
    });

    expect(h.latest.pageIndex).toBe(0);
  });

  it('invalidates current page requests without resetting its cursor', async () => {
    const h = renderHook();
    harnesses.push(h);
    await act(async () => {
      h.latest.setMessages(page(1));
    });
    fetchInboxMessagesMock.mockResolvedValueOnce({
      inboxItems: page(2),
      callsigns: [],
      pageLimit: 20,
    });
    await act(async () => {
      await h.latest.loadNextPage();
    });

    act(() => {
      h.latest.invalidateMessagePageRequests();
    });

    expect(h.latest.pageIndex).toBe(1);
    expect(h.latest.getCurrentMessagePageCursor()).toEqual({
      beforeIdNoninclusive: 1,
      sinceIdNoninclusive: null,
    });
  });

  it('refreshes counts only when explicitly requested', async () => {
    vi.useFakeTimers();
    const h = renderHook();
    harnesses.push(h);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(fetchInboxCountMock).toHaveBeenCalledTimes(1);

    act(() => {
      h.latest.invalidateMessagePaging();
    });
    expect(fetchInboxCountMock).toHaveBeenCalledTimes(1);

    fetchInboxCountMock.mockResolvedValueOnce({ quantity: 43, firstElementTs: null });
    act(() => {
      h.latest.refreshMessageCounts();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(fetchInboxCountMock).toHaveBeenCalledTimes(2);
    expect(h.latest.messagesTotalCount).toBe(43);
  });

  it('sets noMoreToLoad when the fetched page is shorter than pageLimit', async () => {
    const h = renderHook();
    harnesses.push(h);

    await act(async () => {
      await h.latest.setMessages(page(1));
    });
    fetchInboxMessagesMock.mockResolvedValueOnce({
      inboxItems: page(2),
      callsigns: [],
      pageLimit: 20,
    });
    await act(async () => {
      await h.latest.loadNextPage();
    });

    expect(h.latest.noMoreToLoad).toBe(true);
  });
});
