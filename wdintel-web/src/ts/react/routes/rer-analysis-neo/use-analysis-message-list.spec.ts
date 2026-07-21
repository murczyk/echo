/**
 * @vitest-environment happy-dom
 */
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  setDeferInitialLoad: React.Dispatch<React.SetStateAction<boolean>>;
  setQueryState: React.Dispatch<React.SetStateAction<ReturnType<typeof buildQueryState>>>;
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
  newestFirst = true,
  initialDeferInitialLoad = false,
): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const harness = { container, root } as Harness;

  function TestComponent() {
    const [deferInitialLoad, setDeferInitialLoad] = useState(initialDeferInitialLoad);
    const [currentQueryState, setCurrentQueryState] = useState(queryState);
    harness.setDeferInitialLoad = setDeferInitialLoad;
    harness.setQueryState = setCurrentQueryState;
    harness.latest = useAnalysisMessageList({
      deferInitialLoad,
      loadMissingNetworksForMessages,
      newestFirst,
      onError: vi.fn(),
      onUnauthorized: vi.fn().mockReturnValue(false),
      optionsFreqValues: [],
      queryState: currentQueryState,
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

  it('defers message counts until initial loading is allowed', async () => {
    vi.useFakeTimers();
    const h = renderHook(buildQueryState(), undefined, true, true);
    harnesses.push(h);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(fetchInboxCountMock).not.toHaveBeenCalled();
    expect(h.latest.messagesTotalLoading).toBe(false);

    act(() => h.setDeferInitialLoad(false));
    expect(h.latest.messagesTotalLoading).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(fetchInboxCountMock).toHaveBeenCalledTimes(1);
    expect(h.latest.messagesTotalCount).toBe(42);
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

  it('marks counts as loading synchronously when the date range changes', async () => {
    vi.useFakeTimers();
    const h = renderHook();
    harnesses.push(h);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(h.latest.messagesTotalLoading).toBe(false);

    act(() => {
      h.setQueryState((current) => ({
        ...current,
        toDateTimeStr: '2026-04-03T00:00',
      }));
    });

    expect(h.latest.messagesTotalLoading).toBe(true);
    expect(fetchInboxCountMock).toHaveBeenCalledTimes(1);
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

  it('updates messages and pageIndex together before message hydration finishes', async () => {
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

    expect(h.latest.messages).toEqual(page(2));
    expect(h.latest.pageIndex).toBe(1);

    hydration.resolve();
    await act(async () => {
      await nextPagePromise;
    });
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

  it('jumps to the first page', async () => {
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

    fetchInboxMessagesMock.mockResolvedValueOnce({
      inboxItems: page(1),
      callsigns: [],
      pageLimit: 20,
    });
    await act(async () => {
      await h.latest.loadFirstPage();
    });

    expect(h.latest.pageIndex).toBe(0);
    expect(h.latest.messages).toEqual(page(1));
    expect(fetchInboxMessagesMock.mock.calls.at(-1)?.[0]).toMatchObject({
      beforeIdNoninclusive: null,
      sinceIdNoninclusive: null,
      newestFirst: true,
    });
  });

  it('jumps to the last partial page and preserves the selected ordering', async () => {
    vi.useFakeTimers();
    const h = renderHook();
    harnesses.push(h);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    const oldestMessages = Array.from({ length: 20 }, (_, index) => [
      index + 1,
      buildMessage(),
    ]) as Array<[number, InboxMessage]>;
    fetchInboxMessagesMock.mockResolvedValueOnce({
      inboxItems: oldestMessages,
      callsigns: [],
      pageLimit: 20,
    });

    await act(async () => {
      await h.latest.loadLastPage();
    });

    expect(h.latest.pageIndex).toBe(2);
    expect(h.latest.messages.map(([id]) => id)).toEqual([2, 1]);
    expect(h.latest.noMoreToLoad).toBe(true);
    expect(fetchInboxMessagesMock.mock.calls.at(-1)?.[0].newestFirst).toBe(false);
    expect(h.latest.getCurrentMessagePageCursor()).toMatchObject({
      requestNewestFirst: false,
      reverseResults: true,
      resultLimit: 2,
    });
  });

  it('loads the adjacent previous page after jumping to the end', async () => {
    vi.useFakeTimers();
    const h = renderHook();
    harnesses.push(h);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    fetchInboxMessagesMock.mockResolvedValueOnce({
      inboxItems: [page(1)[0], page(2)[0]],
      callsigns: [],
      pageLimit: 20,
    });
    await act(async () => {
      await h.latest.loadLastPage();
    });
    const previousMessages = Array.from({ length: 20 }, (_, index) => [
      index + 3,
      buildMessage(),
    ]) as Array<[number, InboxMessage]>;
    fetchInboxMessagesMock.mockResolvedValueOnce({
      inboxItems: previousMessages,
      callsigns: [],
      pageLimit: 20,
    });

    await act(async () => {
      await h.latest.loadPrevPage();
    });

    expect(h.latest.pageIndex).toBe(1);
    expect(h.latest.messages.map(([id]) => id)).toEqual(
      Array.from({ length: 20 }, (_, index) => 22 - index),
    );
    expect(fetchInboxMessagesMock.mock.calls.at(-1)?.[0]).toMatchObject({
      sinceIdNoninclusive: 2,
      newestFirst: false,
    });
  });

  it('keeps oldest-first ordering when loading the previous page after an end jump', async () => {
    vi.useFakeTimers();
    const h = renderHook(buildQueryState(), undefined, false);
    harnesses.push(h);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    fetchInboxMessagesMock.mockResolvedValueOnce({
      inboxItems: [page(42)[0], page(41)[0]],
      callsigns: [],
      pageLimit: 20,
    });
    await act(async () => {
      await h.latest.loadLastPage();
    });
    const previousMessages = Array.from({ length: 20 }, (_, index) => [
      40 - index,
      buildMessage(),
    ]) as Array<[number, InboxMessage]>;
    fetchInboxMessagesMock.mockResolvedValueOnce({
      inboxItems: previousMessages,
      callsigns: [],
      pageLimit: 20,
    });

    await act(async () => {
      await h.latest.loadPrevPage();
    });

    expect(h.latest.pageIndex).toBe(1);
    expect(h.latest.messages.map(([id]) => id)).toEqual(
      Array.from({ length: 20 }, (_, index) => 21 + index),
    );
    expect(fetchInboxMessagesMock.mock.calls.at(-1)?.[0]).toMatchObject({
      beforeIdNoninclusive: 41,
      newestFirst: false,
    });
    expect(h.latest.getCurrentMessagePageCursor()).toMatchObject({
      requestNewestFirst: false,
      reverseResults: true,
    });
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
