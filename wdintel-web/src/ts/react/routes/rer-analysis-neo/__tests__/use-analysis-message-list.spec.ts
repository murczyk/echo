/**
 * @vitest-environment happy-dom
 */
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAnalysisMessageList } from '../use-analysis-message-list';
import { buildInboxReq, emptyQueryState } from '../helpers';
import type { CallsignInfoRes, InboxMessage, InboxMessagesRsp } from '../../../../../Bindings';

const fetchAnalysisCallsignInfosMock = vi.hoisted(() => vi.fn());
const fetchInboxMessagesMock = vi.hoisted(() => vi.fn());
const fetchInboxCountMock = vi.hoisted(() => vi.fn());

vi.mock('../../../services/api/analysis', () => ({
  fetchAnalysisCallsignInfos: fetchAnalysisCallsignInfosMock,
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

function pageRange(from: number, to: number): Array<[number, InboxMessage]> {
  const step = from <= to ? 1 : -1;
  return Array.from({ length: Math.abs(to - from) + 1 }, (_, index) => [
    from + index * step,
    buildMessage(),
  ]);
}

function inboxResponse(inboxItems: Array<[number, InboxMessage]>): InboxMessagesRsp {
  return {
    inboxItems,
    callsigns: [],
    signalGroups: [],
    signalProfiles: {},
    pollCursorId: null,
    freqPelengsSummary: null,
    pageLimit: 20,
  };
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
  summaryCallsignsInfo: Record<string, CallsignInfoRes>;
  onError: ReturnType<typeof vi.fn>;
  onUnauthorized: ReturnType<typeof vi.fn>;
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
  initialSummaryCallsignsInfo: Record<string, CallsignInfoRes> = {},
  focusedMessageId: number | null = null,
  focusedTargetMessageIndex: number | null = null,
  focusedHasMoreEarlier = true,
  focusedHasMoreLater = true,
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
    harness.onError ??= vi.fn();
    harness.onUnauthorized ??= vi.fn().mockReturnValue(false);
    const [summaryCallsignsInfo, setSummaryCallsignsInfo] = useState<
      Record<string, CallsignInfoRes>
    >(initialSummaryCallsignsInfo);
    const [, setGroupInfos] = useState({});
    const [, setProfiles] = useState({});
    harness.summaryCallsignsInfo = summaryCallsignsInfo;
    harness.latest = useAnalysisMessageList({
      deferInitialLoad,
      focusedMessageId,
      focusedTargetMessageIndex,
      focusedMessageActive: focusedMessageId != null,
      focusedHasMoreEarlier,
      focusedHasMoreLater,
      loadMissingNetworksForMessages,
      newestFirst,
      onError: harness.onError,
      onUnauthorized: harness.onUnauthorized,
      optionsFreqValues: [],
      queryState: currentQueryState,
      setGroupInfos,
      setProfiles,
      setSummaryCallsignsInfo,
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
    fetchAnalysisCallsignInfosMock.mockReset();
    fetchAnalysisCallsignInfosMock.mockResolvedValue([]);
    fetchInboxCountMock.mockReset();
    fetchInboxCountMock.mockResolvedValue({ quantity: 42, firstElementTs: null });
  });

  // Regression: https://github.com/echoua/echo/issues/2726
  it('keeps the selected period on both sides of a linked message', async () => {
    const queryState = buildQueryState();
    const h = renderHook(queryState, undefined, true, true, {}, 50);
    harnesses.push(h);
    act(() => h.latest.setMessages(page(50)));
    fetchInboxMessagesMock.mockResolvedValue({
      inboxItems: [],
      callsigns: [],
      signalGroups: [],
      signalProfiles: {},
      pageLimit: 20,
    });
    await act(async () => {
      await h.latest.loadFocusedEarlier();
    });
    await act(async () => {
      await h.latest.loadFocusedLater();
    });
    const period = buildInboxReq(queryState, [], true);
    expect(fetchInboxMessagesMock).toHaveBeenCalledTimes(2);
    expect(
      fetchInboxMessagesMock.mock.calls.map(([request]) => ({
        since: request.sinceDateInclusiveMs,
        till: request.tillDateInclusiveMs,
        before: request.beforeIdNoninclusive,
        after: request.sinceIdNoninclusive,
      })),
    ).toEqual([
      {
        since: period.sinceDateInclusiveMs,
        till: period.tillDateInclusiveMs,
        before: 50,
        after: null,
      },
      {
        since: period.sinceDateInclusiveMs,
        till: period.tillDateInclusiveMs,
        before: null,
        after: 50,
      },
    ]);
    expect(h.latest.focusedHasMoreEarlier).toBe(false);
    expect(h.latest.focusedHasMoreLater).toBe(false);
    expect(fetchInboxCountMock).not.toHaveBeenCalled();
  });

  it('enriches visible callsigns from marked content without blocking messages', async () => {
    const h = renderHook();
    harnesses.push(h);
    const response = {
      callsign: 'Wolf',
      res: [],
      networkHints: [],
    } satisfies CallsignInfoRes;
    fetchAnalysisCallsignInfosMock.mockResolvedValueOnce([response]);

    act(() => {
      h.latest.setMessages([
        [
          1,
          buildMessage({
            callsigns: ['fallback'],
            textMarked: [
              { CNHighlightC: { text: 'ignored', begin: 0, end: 7 } },
              { CNCallsignC: { text: '  WOLF ', begin: 0, end: 7, etalon: 'WOLF' } },
              { CNCallsignC: { text: 'wolf', begin: 8, end: 12, etalon: 'wolf' } },
            ] as never,
          }),
        ],
      ]);
    });

    expect(h.latest.messages).toHaveLength(1);
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchAnalysisCallsignInfosMock).toHaveBeenCalledWith(['wolf']);
    expect(h.summaryCallsignsInfo.wolf).toEqual(response);
  });

  it('falls back to message callsigns when marked content has no callsign nodes', async () => {
    const h = renderHook();
    harnesses.push(h);
    act(() => {
      h.latest.setMessages([
        [1, buildMessage({ callsigns: ['  Alpha ', 'alpha'], textMarked: [] as never })],
      ]);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchAnalysisCallsignInfosMock).toHaveBeenCalledWith(['alpha']);
  });
  it('does not merge a stale enrichment response or remove a newer owner', async () => {
    const h = renderHook();
    harnesses.push(h);
    const oldRequest = deferred<CallsignInfoRes[]>();
    const newRequest = deferred<CallsignInfoRes[]>();
    fetchAnalysisCallsignInfosMock
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise);

    act(() => {
      h.latest.setMessages([[1, buildMessage({ callsigns: ['old'] })]]);
    });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      h.latest.invalidateMessagePaging();
      h.latest.setMessages([[2, buildMessage({ callsigns: ['old'] })]]);
    });
    await act(async () => {
      await Promise.resolve();
    });
    oldRequest.resolve([{ callsign: 'old', res: [], networkHints: [] }]);
    await act(async () => {
      await Promise.resolve();
    });
    expect(h.summaryCallsignsInfo).toEqual({});
    newRequest.resolve([{ callsign: 'old', res: [], networkHints: [] }]);
    await act(async () => {
      await Promise.resolve();
    });
    expect(h.summaryCallsignsInfo.old).toBeDefined();
  });
  it('deduplicates completed and in-flight enrichment requests', async () => {
    const h = renderHook();
    harnesses.push(h);
    const pending = deferred<CallsignInfoRes[]>();
    fetchAnalysisCallsignInfosMock.mockReturnValueOnce(pending.promise).mockResolvedValue([]);
    act(() => h.latest.setMessages([[1, buildMessage({ callsigns: [' Wolf '] })]]));
    await act(async () => Promise.resolve());
    act(() => h.latest.setMessages([[2, buildMessage({ callsigns: ['wolf'] })]]));
    await act(async () => Promise.resolve());
    expect(fetchAnalysisCallsignInfosMock).toHaveBeenCalledTimes(1);
    pending.resolve([{ callsign: 'wolf', res: [], networkHints: [] }]);
    await act(async () => Promise.resolve());
    act(() => h.latest.setMessages([[3, buildMessage({ callsigns: ['WOLF'] })]]));
    await act(async () => Promise.resolve());
    expect(fetchAnalysisCallsignInfosMock).toHaveBeenCalledTimes(1);
  });

  it('preserves unrelated callsign entries when merging enrichment results', async () => {
    const alpha = { callsign: 'alpha', res: [], networkHints: [] } satisfies CallsignInfoRes;
    const h = renderHook(buildQueryState(), undefined, true, false, { alpha });
    harnesses.push(h);
    const wolf = { callsign: 'wolf', res: [], networkHints: [] } satisfies CallsignInfoRes;
    fetchAnalysisCallsignInfosMock.mockResolvedValueOnce([wolf]);
    act(() => h.latest.setMessages([[1, buildMessage({ callsigns: ['wolf'] })]]));
    await act(async () => Promise.resolve());
    expect(h.summaryCallsignsInfo).toEqual({ alpha, wolf });
  });
  it('does not let scoped data suppress unscoped callsign enrichment', async () => {
    const scoped = {
      callsign: 'WOLF',
      res: [],
      networkHints: [{ id: 10, networkId: 10, position: 'scoped', formation: '' }],
    } satisfies CallsignInfoRes;
    const unscoped = {
      callsign: 'wolf',
      res: [
        {
          id: 7,
          callsign: 'wolf',
          position: 'ТЮМЕНЬ',
          comment: '',
          unit1: '',
          unit2: '',
          unitId: null,
          networkIdsReportedIn: [20],
        },
      ],
      networkHints: [
        { id: 10, networkId: 10, position: 'scoped', formation: '' },
        { id: 20, networkId: 20, position: 'other', formation: '' },
      ],
    } satisfies CallsignInfoRes;
    const h = renderHook(buildQueryState(), undefined, true, false, { wolf: scoped });
    harnesses.push(h);
    fetchAnalysisCallsignInfosMock.mockResolvedValueOnce([unscoped]);

    act(() => {
      h.latest.setMessages([
        [
          1,
          buildMessage({
            networkIds: [10],
            textMarked: [
              { CNCallsignC: { text: 'WOLF', begin: 0, end: 4, etalon: 'wolf' } },
            ] as never,
          }),
        ],
      ]);
    });
    await act(async () => Promise.resolve());

    expect(fetchAnalysisCallsignInfosMock).toHaveBeenCalledTimes(1);
    expect(fetchAnalysisCallsignInfosMock).toHaveBeenCalledWith(['wolf']);
    expect(Object.keys(h.summaryCallsignsInfo)).toEqual(['wolf']);
    expect(h.summaryCallsignsInfo.wolf.networkHints).toHaveLength(2);
    expect(h.summaryCallsignsInfo.wolf.res).toHaveLength(1);
    expect(h.summaryCallsignsInfo.wolf.networkHints.map(({ id }) => id)).toEqual([10, 20]);
    expect(h.summaryCallsignsInfo.wolf.res.map(({ id }) => id)).toEqual([7]);
  });
  it('releases failed enrichment ownership for a later legitimate list update', async () => {
    const h = renderHook();
    harnesses.push(h);
    const response = {
      callsign: 'wolf',
      res: [],
      networkHints: [{ id: 20, networkId: 20, position: 'other', formation: '' }],
    } satisfies CallsignInfoRes;
    h.onError.mockReset();
    h.onUnauthorized.mockReset();
    h.onUnauthorized.mockReturnValue(false);
    fetchAnalysisCallsignInfosMock.mockRejectedValueOnce(new Error('temporary failure'));

    act(() => h.latest.setMessages([[1, buildMessage({ callsigns: [' WOLF '] })]]));
    await act(async () => Promise.resolve());
    expect(fetchAnalysisCallsignInfosMock).toHaveBeenCalledTimes(1);
    expect(h.onError).toHaveBeenCalledWith('temporary failure');

    fetchAnalysisCallsignInfosMock.mockResolvedValueOnce([response]);
    act(() => h.latest.setMessages([[2, buildMessage({ callsigns: ['wolf'] })]]));
    await act(async () => Promise.resolve());

    expect(fetchAnalysisCallsignInfosMock).toHaveBeenCalledTimes(2);
    expect(fetchAnalysisCallsignInfosMock).toHaveBeenLastCalledWith(['wolf']);
    expect(h.summaryCallsignsInfo.wolf).toEqual(response);
  });

  it('reports unauthorized and ordinary enrichment failures through existing handlers', async () => {
    const unauthorized = renderHook();
    harnesses.push(unauthorized);
    unauthorized.onError.mockReset();
    unauthorized.onUnauthorized.mockReset();
    unauthorized.onUnauthorized.mockReturnValue(true);
    fetchAnalysisCallsignInfosMock.mockRejectedValueOnce(new Error('unauthorized'));
    act(() => unauthorized.latest.setMessages([[1, buildMessage({ callsigns: ['wolf'] })]]));
    await act(async () => Promise.resolve());
    expect(unauthorized.onUnauthorized).toHaveBeenCalled();
    expect(unauthorized.onError).not.toHaveBeenCalled();

    const ordinary = renderHook();
    harnesses.push(ordinary);
    ordinary.onError.mockReset();
    ordinary.onUnauthorized.mockReset();
    ordinary.onUnauthorized.mockReturnValue(false);
    fetchAnalysisCallsignInfosMock.mockRejectedValueOnce(new Error('failed'));
    act(() => ordinary.latest.setMessages([[2, buildMessage({ callsigns: ['fox'] })]]));
    await act(async () => Promise.resolve());
    expect(ordinary.onUnauthorized).toHaveBeenCalled();
    expect(ordinary.onError).toHaveBeenCalledWith('failed');
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

  it('defers and coalesces ambiguous realtime events', async () => {
    vi.useFakeTimers();
    fetchInboxCountMock
      .mockResolvedValueOnce({ quantity: 42, firstElementTs: null })
      .mockResolvedValueOnce({ quantity: 137, firstElementTs: null });
    const h = renderHook({ ...buildQueryState(), search: 'filtered' });
    harnesses.push(h);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    fetchInboxCountMock.mockClear();
    fetchInboxCountMock
      .mockResolvedValueOnce({ quantity: 43, firstElementTs: null })
      .mockResolvedValueOnce({ quantity: 138, firstElementTs: null })
      .mockResolvedValueOnce({ quantity: 47, firstElementTs: null })
      .mockResolvedValueOnce({ quantity: 142, firstElementTs: null });

    for (let eventIndex = 0; eventIndex < 5; eventIndex += 1) {
      act(() => h.latest.scheduleOverallMessageCountRefresh('deferred'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(550);
      });
    }
    expect(fetchInboxCountMock).not.toHaveBeenCalled();
    expect(h.latest.messagesTotalCount).toBe(42);
    expect(h.latest.messagesOverallCount).toBe(137);
    expect(h.latest.messagesTotalLoading).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_200);
    });

    expect(fetchInboxCountMock).toHaveBeenCalledTimes(2);
    expect(fetchInboxCountMock).toHaveBeenCalledWith(
      expect.objectContaining({ nolimit: true, search: 'filtered' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchInboxCountMock).toHaveBeenCalledWith(
      expect.objectContaining({ nolimit: true, search: null }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(h.latest.messagesTotalCount).toBe(43);
    expect(h.latest.messagesOverallCount).toBe(138);
  });

  it('#3780 shares one coalesced system count when no filters are active', async () => {
    vi.useFakeTimers();
    const h = renderHook();
    harnesses.push(h);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    fetchInboxCountMock.mockClear();
    fetchInboxCountMock
      .mockResolvedValueOnce({ quantity: 43, firstElementTs: null })
      .mockResolvedValueOnce({ quantity: 44, firstElementTs: null });

    act(() => {
      h.latest.scheduleOverallMessageCountRefresh();
      h.latest.scheduleOverallMessageCountRefresh();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_200);
    });

    expect(fetchInboxCountMock).toHaveBeenCalledTimes(1);
    expect(h.latest.messagesTotalCount).toBe(43);
    expect(h.latest.messagesOverallCount).toBe(43);
  });

  // Regression: https://github.com/echoua/echo/issues/3780
  it('waits for both slow counts before draining a pending system refresh', async () => {
    vi.useFakeTimers();
    const selected = deferred<{ quantity: number; firstElementTs: null }>();
    const overall = deferred<{ quantity: number; firstElementTs: null }>();
    fetchInboxCountMock.mockReturnValueOnce(selected.promise).mockReturnValueOnce(overall.promise);
    const h = renderHook({ ...buildQueryState(), search: 'filtered' });
    harnesses.push(h);
    await act(async () => vi.advanceTimersByTimeAsync(200));
    const signals = fetchInboxCountMock.mock.calls.map(([, options]) => options?.signal);
    act(() => h.latest.scheduleOverallMessageCountRefresh());
    await act(async () => vi.advanceTimersByTimeAsync(35_000));
    expect(fetchInboxCountMock).toHaveBeenCalledTimes(2);
    expect(signals.every((signal) => signal?.aborted === false)).toBe(true);
    await act(async () => {
      selected.resolve({ quantity: 42, firstElementTs: null });
      await Promise.resolve();
    });
    expect(fetchInboxCountMock).toHaveBeenCalledTimes(2);
    expect(h.latest.messagesTotalLoading).toBe(true);
    fetchInboxCountMock
      .mockResolvedValueOnce({ quantity: 43, firstElementTs: null })
      .mockResolvedValueOnce({ quantity: 138, firstElementTs: null });
    await act(async () => {
      overall.resolve({ quantity: 137, firstElementTs: null });
      await Promise.resolve();
    });
    expect(fetchInboxCountMock).toHaveBeenCalledTimes(4);
    expect(h.latest.messagesTotalCount).toBe(43);
    expect(h.latest.messagesOverallCount).toBe(138);
    expect(h.latest.messagesTotalLoading).toBe(false);
  });

  it('#3780 keeps user counts when an obsolete shared request resolves later', async () => {
    vi.useFakeTimers();
    const initialCountRequest = deferred<{ quantity: number; firstElementTs: null }>();
    fetchInboxCountMock.mockReturnValueOnce(initialCountRequest.promise);
    const h = renderHook();
    harnesses.push(h);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    fetchInboxCountMock.mockResolvedValueOnce({ quantity: 43, firstElementTs: null });
    act(() => h.latest.refreshMessageCounts());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(h.latest.messagesTotalCount).toBe(43);
    expect(h.latest.messagesOverallCount).toBe(43);

    await act(async () => {
      initialCountRequest.resolve({ quantity: 42, firstElementTs: null });
      await Promise.resolve();
    });

    expect(h.latest.messagesTotalCount).toBe(43);
    expect(h.latest.messagesOverallCount).toBe(43);
  });

  it('ignores a stale initial count failure while a newer user request is pending', async () => {
    vi.useFakeTimers();
    let rejectInitialCountRequest!: (reason?: unknown) => void;
    const initialCountRequest = new Promise<{ quantity: number; firstElementTs: null }>(
      (_, reject) => {
        rejectInitialCountRequest = reject;
      },
    );
    const backgroundCountRequest = deferred<{ quantity: number; firstElementTs: null }>();
    fetchInboxCountMock
      .mockReturnValueOnce(initialCountRequest)
      .mockReturnValueOnce(backgroundCountRequest.promise);
    const h = renderHook();
    harnesses.push(h);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    act(() => h.latest.refreshMessageCounts());
    await act(async () => vi.advanceTimersByTimeAsync(200));

    await act(async () => {
      rejectInitialCountRequest(new Error('stale failure'));
      await Promise.resolve();
    });

    expect(h.onError).not.toHaveBeenCalled();
    expect(h.latest.messagesTotalLoading).toBe(true);

    await act(async () => {
      backgroundCountRequest.resolve({ quantity: 43, firstElementTs: null });
      await Promise.resolve();
    });

    expect(h.latest.messagesTotalCount).toBe(43);
    expect(h.latest.messagesOverallCount).toBe(43);
    expect(h.latest.messagesTotalLoading).toBe(false);
  });

  // Regression: https://github.com/echoua/echo/issues/3780
  it('queues an event during the initial debounce without racing initial counts', async () => {
    vi.useFakeTimers();
    const h = renderHook();
    harnesses.push(h);
    act(() => h.latest.scheduleOverallMessageCountRefresh());
    expect(fetchInboxCountMock).not.toHaveBeenCalled();
    expect(h.latest.messagesTotalLoading).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(fetchInboxCountMock).toHaveBeenCalledTimes(1);
    expect(h.latest.messagesTotalCount).toBe(42);
    expect(h.latest.messagesTotalLoading).toBe(false);
    fetchInboxCountMock.mockResolvedValueOnce({ quantity: 43, firstElementTs: null });
    await act(async () => vi.advanceTimersByTimeAsync(29_999));
    expect(fetchInboxCountMock).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetchInboxCountMock).toHaveBeenCalledTimes(2);
    expect(h.latest.messagesTotalCount).toBe(43);
  });

  it('#3780 ignores a stale system count failure after a user refresh starts', async () => {
    vi.useFakeTimers();
    let rejectBackgroundCountRequest!: (reason?: unknown) => void;
    const backgroundCountRequest = new Promise<{ quantity: number; firstElementTs: null }>(
      (_, reject) => {
        rejectBackgroundCountRequest = reject;
      },
    );
    const initialCountRequest = deferred<{ quantity: number; firstElementTs: null }>();
    fetchInboxCountMock
      .mockResolvedValueOnce({ quantity: 42, firstElementTs: null })
      .mockReturnValueOnce(backgroundCountRequest)
      .mockReturnValueOnce(initialCountRequest.promise);
    const h = renderHook();
    harnesses.push(h);

    await act(async () => vi.advanceTimersByTimeAsync(200));
    act(() => h.latest.scheduleOverallMessageCountRefresh());
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    act(() => h.latest.refreshMessageCounts());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
      initialCountRequest.resolve({ quantity: 44, firstElementTs: null });
      await Promise.resolve();
    });
    await act(async () => {
      rejectBackgroundCountRequest(new Error('stale background failure'));
      await Promise.resolve();
    });

    expect(h.onError).not.toHaveBeenCalled();
    expect(h.latest.messagesTotalCount).toBe(44);
    expect(h.latest.messagesOverallCount).toBe(44);
    expect(h.latest.messagesTotalLoading).toBe(false);
  });

  // Regression: https://github.com/echoua/echo/issues/3780
  it('keeps a quiet pending event until thirty seconds after a two-second count start', async () => {
    vi.useFakeTimers();
    const initial = deferred<{ quantity: number; firstElementTs: null }>();
    fetchInboxCountMock.mockReturnValueOnce(initial.promise);
    const h = renderHook();
    harnesses.push(h);
    await act(async () => vi.advanceTimersByTimeAsync(200));
    act(() => h.latest.scheduleOverallMessageCountRefresh());
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    await act(async () => {
      initial.resolve({ quantity: 41, firstElementTs: null });
      await Promise.resolve();
    });
    expect(h.latest.messagesTotalCount).toBe(41);
    await act(async () => vi.advanceTimersByTimeAsync(27_999));
    expect(fetchInboxCountMock).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetchInboxCountMock).toHaveBeenCalledTimes(2);
    expect(h.latest.messagesTotalCount).toBe(42);
  });

  // Regression: https://github.com/echoua/echo/issues/3780
  it('releases a failed cycle only after its peer count settles', async () => {
    vi.useFakeTimers();
    const peer = deferred<{ quantity: number; firstElementTs: null }>();
    fetchInboxCountMock
      .mockRejectedValueOnce(new Error('count failed'))
      .mockReturnValueOnce(peer.promise);
    const h = renderHook({ ...buildQueryState(), search: 'filtered' });
    harnesses.push(h);
    await act(async () => vi.advanceTimersByTimeAsync(200));
    act(() => h.latest.scheduleOverallMessageCountRefresh());
    await act(async () => vi.advanceTimersByTimeAsync(35_000));
    expect(fetchInboxCountMock).toHaveBeenCalledTimes(2);
    expect(h.onError).toHaveBeenCalledOnce();
    expect(h.onError).toHaveBeenCalledWith('count failed');
    await act(async () => {
      peer.resolve({ quantity: 41, firstElementTs: null });
      await Promise.resolve();
    });
    expect(h.onError).toHaveBeenCalledWith('count failed');
    expect(fetchInboxCountMock).toHaveBeenCalledTimes(4);
    expect(h.latest.messagesTotalCount).toBe(42);
  });

  it('#3780 handles an unauthorized peer immediately without waiting for a stuck count', async () => {
    vi.useFakeTimers();
    const peer = deferred<{ quantity: number; firstElementTs: null }>();
    const unauthorized = new Error('unauthorized');
    fetchInboxCountMock.mockReturnValueOnce(peer.promise).mockRejectedValueOnce(unauthorized);
    const h = renderHook({ ...buildQueryState(), search: 'filtered' });
    harnesses.push(h);
    h.onUnauthorized.mockReturnValue(true);
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(h.onUnauthorized).toHaveBeenCalledWith(unauthorized);
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.latest.messagesTotalLoading).toBe(true);
    await act(async () => {
      peer.resolve({ quantity: 41, firstElementTs: null });
      await Promise.resolve();
    });
    expect(h.latest.messagesTotalLoading).toBe(false);
    expect(h.onUnauthorized).toHaveBeenCalledOnce();
  });

  // Regression: https://github.com/echoua/echo/issues/3780
  it('reports a stuck count deadline and drains pending events without accepting late data', async () => {
    vi.useFakeTimers();
    const stuck = deferred<{ quantity: number; firstElementTs: null }>();
    fetchInboxCountMock.mockReturnValueOnce(stuck.promise);
    const h = renderHook();
    harnesses.push(h);
    await act(async () => vi.advanceTimersByTimeAsync(200));
    const signal = fetchInboxCountMock.mock.calls[0][1]?.signal;
    act(() => h.latest.scheduleOverallMessageCountRefresh());
    await act(async () => vi.advanceTimersByTimeAsync(65_000));
    expect(signal?.aborted).toBe(true);
    expect(h.onError).toHaveBeenCalledWith('Сервер не відповів вчасно. Спробуйте ще раз.');
    expect(fetchInboxCountMock).toHaveBeenCalledTimes(2);
    expect(h.latest.messagesTotalCount).toBe(42);
    await act(async () => {
      stuck.resolve({ quantity: 999, firstElementTs: null });
      await Promise.resolve();
    });
    expect(h.latest.messagesTotalCount).toBe(42);
    expect(h.latest.messagesTotalLoading).toBe(false);
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

  it('loadMoreMessages appends messages and increments pageIndex', async () => {
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
      await h.latest.loadMoreMessages();
    });

    expect(h.latest.pageIndex).toBe(1);
    expect(h.latest.messages).toEqual([...page(1), ...page(2)]);
  });

  it.each([
    {
      newestFirst: true,
      first: pageRange(60, 41),
      second: pageRange(40, 21),
      third: pageRange(20, 1),
    },
    {
      newestFirst: false,
      first: pageRange(1, 20),
      second: pageRange(21, 40),
      third: pageRange(41, 60),
    },
  ])(
    'keeps a bounded window and refetches an evicted page when newestFirst=$newestFirst',
    async ({ newestFirst, first, second, third }) => {
      const h = renderHook(buildQueryState(), undefined, newestFirst);
      harnesses.push(h);
      act(() => h.latest.setMessages(first));
      fetchInboxMessagesMock
        .mockResolvedValueOnce({ inboxItems: second, callsigns: [], pageLimit: 20 })
        .mockResolvedValueOnce({ inboxItems: third, callsigns: [], pageLimit: 20 })
        .mockResolvedValueOnce({ inboxItems: [...first].reverse(), callsigns: [], pageLimit: 20 });

      await act(async () => {
        await h.latest.loadMoreMessages();
      });
      await act(async () => {
        await h.latest.loadMoreMessages();
      });

      expect(h.latest.messages.map(([id]) => id)).toEqual([...second, ...third].map(([id]) => id));
      expect(h.latest.firstLoadedMessageIndex).toBe(20);
      expect(h.latest.pageIndex).toBe(2);
      expect(h.latest.hasMoreBeforeWindow).toBe(true);

      await act(async () => {
        await h.latest.loadPreviousMessages();
      });

      expect(h.latest.messages.map(([id]) => id)).toEqual([...first, ...second].map(([id]) => id));
      expect(h.latest.firstLoadedMessageIndex).toBe(0);
      expect(h.latest.pageIndex).toBe(1);
      expect(h.latest.hasMoreAfterWindow).toBe(true);
    },
  );

  it('does not evict a bounded row for an overlapping next page', async () => {
    const h = renderHook();
    harnesses.push(h);
    act(() => h.latest.setMessages(pageRange(40, 21)));
    fetchInboxMessagesMock.mockResolvedValueOnce({
      inboxItems: pageRange(21, 3),
      callsigns: [],
      pageLimit: 20,
    });

    await act(async () => {
      await h.latest.loadMoreMessages();
    });

    expect(h.latest.messages.map(([id]) => id)).toEqual(pageRange(40, 3).map(([id]) => id));
    expect(h.latest.firstLoadedMessageIndex).toBe(0);
  });

  it('clears bounded edge loading after a failed fetch without changing the window', async () => {
    const h = renderHook();
    harnesses.push(h);
    const first = pageRange(60, 41);
    act(() => h.latest.setMessages(first));
    fetchInboxMessagesMock.mockRejectedValueOnce(new Error('offline'));

    await act(async () => {
      await h.latest.loadMoreMessages();
    });

    expect(h.latest.messages).toEqual(first);
    expect(h.latest.loadingAfterWindow).toBe(false);
    expect(h.latest.hasMoreAfterWindow).toBe(true);
    expect(h.onError).toHaveBeenCalled();
  });

  it.each([true, false])(
    'keeps a bounded focused context in display order when newestFirst=%s',
    async (newestFirst) => {
      const h = renderHook(buildQueryState(), undefined, newestFirst, true, {}, 50);
      harnesses.push(h);
      act(() => h.latest.setMessages(pageRange(41, 60)));
      fetchInboxMessagesMock
        .mockResolvedValueOnce({ inboxItems: pageRange(40, 21), callsigns: [], pageLimit: 20 })
        .mockResolvedValueOnce({ inboxItems: pageRange(61, 80), callsigns: [], pageLimit: 20 });

      await act(async () => {
        await h.latest.loadFocusedEarlier();
      });
      await act(async () => {
        await h.latest.loadFocusedLater();
      });

      expect(h.latest.messages.map(([id]) => id)).toEqual(
        (newestFirst ? pageRange(80, 41) : pageRange(41, 80)).map(([id]) => id),
      );
      expect(h.latest.messages).toHaveLength(40);
    },
  );

  // Regression: https://github.com/echoua/echo/issues/3689
  it.each([true, false])(
    'keeps the trimmed older edge reachable in a full linked context when newestFirst=%s',
    async (newestFirst) => {
      const h = renderHook(
        buildQueryState(),
        undefined,
        newestFirst,
        true,
        {},
        21,
        20,
        false,
        false,
      );
      harnesses.push(h);
      act(() => h.latest.setMessages(pageRange(1, 41)));

      expect(h.latest.messages.map(([id]) => id)).toEqual(
        (newestFirst ? pageRange(41, 2) : pageRange(2, 41)).map(([id]) => id),
      );
      expect(h.latest.firstLoadedMessageIndex).toBe(newestFirst ? 0 : 1);
      expect(h.latest.focusedHasMoreEarlier).toBe(true);

      fetchInboxMessagesMock.mockResolvedValueOnce({
        inboxItems: page(1),
        callsigns: [],
        signalGroups: [],
        signalProfiles: {},
        pageLimit: 20,
      });
      await act(async () => {
        await h.latest.loadFocusedEarlier();
      });
      expect(h.latest.messages.some(([id]) => id === 1)).toBe(true);
    },
  );

  // Regression: https://github.com/echoua/echo/issues/3689
  it.each(['earlier', 'later'] as const)(
    'retains both focused chunks when the %s request finishes first',
    async (firstCompleted) => {
      const h = renderHook(buildQueryState(), undefined, true, true, {}, 50);
      harnesses.push(h);
      act(() => h.latest.setMessages(pageRange(41, 60)));
      const earlier = deferred<InboxMessagesRsp>();
      const later = deferred<InboxMessagesRsp>();
      fetchInboxMessagesMock.mockImplementation((request) =>
        request.beforeIdNoninclusive != null ? earlier.promise : later.promise,
      );

      let earlierLoad!: Promise<boolean>;
      let laterLoad!: Promise<boolean>;
      act(() => {
        earlierLoad = h.latest.loadFocusedEarlier();
        laterLoad = h.latest.loadFocusedLater();
      });
      const finishEarlier = async () => {
        await act(async () => {
          earlier.resolve(inboxResponse(pageRange(40, 36)));
          await earlierLoad;
        });
      };
      const finishLater = async () => {
        await act(async () => {
          later.resolve(inboxResponse(pageRange(61, 65)));
          await laterLoad;
        });
      };
      if (firstCompleted === 'earlier') {
        await finishEarlier();
        await finishLater();
      } else {
        await finishLater();
        await finishEarlier();
      }

      expect(h.latest.messages.map(([id]) => id)).toEqual(pageRange(65, 36).map(([id]) => id));
    },
  );

  // Regression: https://github.com/echoua/echo/issues/3689
  it('keeps the linked window unchanged after an empty newest-first edge request', async () => {
    const h = renderHook(buildQueryState(), undefined, true, true, {}, 50);
    harnesses.push(h);
    act(() => h.latest.setMessages(pageRange(41, 60)));
    const originalMessages = h.latest.messages;
    fetchInboxMessagesMock.mockResolvedValueOnce(inboxResponse([]));

    await act(async () => {
      await h.latest.loadFocusedEarlier();
    });

    expect(h.latest.messages).toBe(originalMessages);
    expect(h.latest.focusedHasMoreEarlier).toBe(false);
  });

  it.each([true, false])(
    'keeps bounded focused coordinates after the target is evicted when newestFirst=%s',
    async (newestFirst) => {
      const h = renderHook(
        buildQueryState(),
        undefined,
        newestFirst,
        true,
        {},
        50,
        newestFirst ? 50 : 49,
      );
      harnesses.push(h);
      act(() => h.latest.setMessages(pageRange(41, 60)));
      fetchInboxMessagesMock
        .mockResolvedValueOnce({ inboxItems: pageRange(40, 21), callsigns: [], pageLimit: 20 })
        .mockResolvedValueOnce({ inboxItems: pageRange(61, 80), callsigns: [], pageLimit: 20 })
        .mockResolvedValueOnce({ inboxItems: pageRange(81, 100), callsigns: [], pageLimit: 20 });

      await act(async () => {
        await h.latest.loadFocusedEarlier();
      });
      await act(async () => {
        await h.latest.loadFocusedLater();
      });
      await act(async () => {
        await h.latest.loadFocusedLater();
      });

      expect(h.latest.messages).toHaveLength(40);
      expect(h.latest.messages.some(([id]) => id === 50)).toBe(false);
      expect(h.latest.messages.map(([id]) => id)).toEqual(
        (newestFirst ? pageRange(100, 61) : pageRange(61, 100)).map(([id]) => id),
      );
      expect(h.latest.firstLoadedMessageIndex).toBe(newestFirst ? 0 : 60);
      expect(h.latest.focusedHasMoreEarlier).toBe(true);
    },
  );

  it('keeps a bounded feed after local or realtime insertion', () => {
    const h = renderHook();
    harnesses.push(h);
    act(() => h.latest.setMessages(pageRange(60, 21)));

    act(() => h.latest.setMessages((current) => [[61, buildMessage()], ...current]));

    expect(h.latest.messages.map(([id]) => id)).toEqual(pageRange(61, 22).map(([id]) => id));
    expect(h.latest.messages).toHaveLength(40);
  });

  it('replaces only the current page while preserving loaded history', async () => {
    const h = renderHook();
    harnesses.push(h);
    const firstPage = Array.from(
      { length: 20 },
      (_, index) => [40 - index, buildMessage()] as [number, InboxMessage],
    );
    const secondPage = Array.from(
      { length: 20 },
      (_, index) => [20 - index, buildMessage()] as [number, InboxMessage],
    );

    await act(async () => {
      await h.latest.setMessages(firstPage);
    });
    fetchInboxMessagesMock.mockResolvedValueOnce({
      inboxItems: secondPage,
      callsigns: [],
      pageLimit: 20,
    });
    await act(async () => {
      await h.latest.loadMoreMessages();
    });
    const refreshedPage = secondPage.map(
      ([id, message]) => [id, { ...message, text: `refreshed-${id}` }] as [number, InboxMessage],
    );

    act(() => {
      h.latest.replaceCurrentMessagePage(refreshedPage);
    });

    expect(h.latest.messages).toEqual([...firstPage, ...refreshedPage]);
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

    let loaded: unknown;
    await act(async () => {
      loaded = await h.latest.loadNextPage();
    });

    expect(loaded).toBe(false);
    expect(h.latest.messages).toEqual(currentMessages);
    expect(h.latest.pageIndex).toBe(0);
    expect(h.latest.noMoreToLoad).toBe(true);
  });

  // Regression: https://github.com/echoua/echo/issues/3689
  it.each(['loadFirstPage', 'loadLastPage', 'loadPrevPage'] as const)(
    'reports failure without changing the loaded page when %s fails',
    async (action) => {
      if (action === 'loadLastPage') vi.useFakeTimers();
      const h = renderHook();
      harnesses.push(h);
      act(() => h.latest.setMessages(page(100)));
      if (action === 'loadLastPage') {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(200);
        });
        expect(h.latest.messagesTotalCount).toBe(42);
      } else {
        fetchInboxMessagesMock.mockResolvedValueOnce(inboxResponse(page(99)));
        await act(async () => {
          await h.latest.loadNextPage();
        });
      }
      const currentMessages = h.latest.messages;
      const currentPageIndex = h.latest.pageIndex;
      fetchInboxMessagesMock.mockRejectedValueOnce(new Error('offline'));

      let loaded: unknown;
      await act(async () => {
        loaded = await h.latest[action]();
      });

      expect(loaded).toBe(false);
      expect(h.latest.messages).toBe(currentMessages);
      expect(h.latest.pageIndex).toBe(currentPageIndex);
    },
  );

  // Regression: https://github.com/echoua/echo/issues/3689
  it.each(['loadFirstPage', 'loadLastPage', 'loadPrevPage'] as const)(
    'keeps newer-page navigation available when %s returns an empty page',
    async (action) => {
      if (action === 'loadLastPage') vi.useFakeTimers();
      const h = renderHook();
      harnesses.push(h);
      act(() => h.latest.setMessages(pageRange(100, 81)));
      if (action === 'loadLastPage') {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(200);
        });
        expect(h.latest.messagesTotalCount).toBe(42);
      } else {
        fetchInboxMessagesMock.mockResolvedValueOnce(inboxResponse(pageRange(80, 61)));
        await act(async () => {
          await h.latest.loadNextPage();
        });
      }
      const currentMessages = h.latest.messages;
      const currentPageIndex = h.latest.pageIndex;
      expect(h.latest.noMoreToLoad).toBe(false);
      fetchInboxMessagesMock.mockResolvedValueOnce(inboxResponse([]));

      let loaded: unknown;
      await act(async () => {
        loaded = await h.latest[action]();
      });

      expect(loaded).toBe(false);
      expect(h.latest.messages).toBe(currentMessages);
      expect(h.latest.pageIndex).toBe(currentPageIndex);
      expect(h.latest.noMoreToLoad).toBe(false);
    },
  );

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
  it('re-enriches preserved-page messages after page-request invalidation', async () => {
    const h = renderHook();
    harnesses.push(h);
    const firstResponse = {
      callsign: 'wolf',
      res: [],
      networkHints: [{ id: 1, networkId: 10, position: 'first', formation: '' }],
    } satisfies CallsignInfoRes;
    const freshResponse = {
      callsign: 'wolf',
      res: [],
      networkHints: [{ id: 2, networkId: 20, position: 'fresh', formation: '' }],
    } satisfies CallsignInfoRes;
    fetchAnalysisCallsignInfosMock.mockResolvedValueOnce([firstResponse]);
    await act(async () => {
      h.latest.setMessages([[1, buildMessage({ callsigns: ['wolf'] })]]);
      await Promise.resolve();
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

    act(() => h.latest.invalidateMessagePageRequests());
    expect(h.latest.pageIndex).toBe(1);
    expect(h.latest.getCurrentMessagePageCursor()).toEqual({
      beforeIdNoninclusive: 1,
      sinceIdNoninclusive: null,
    });

    fetchAnalysisCallsignInfosMock.mockResolvedValueOnce([freshResponse]);
    act(() => h.latest.setMessages([[3, buildMessage({ callsigns: [' WOLF '] })]]));
    await act(async () => Promise.resolve());

    expect(fetchAnalysisCallsignInfosMock).toHaveBeenCalledTimes(2);
    expect(h.summaryCallsignsInfo.wolf.networkHints).toEqual([
      firstResponse.networkHints[0],
      freshResponse.networkHints[0],
    ]);
  });
  it('ignores an in-flight enrichment response after page-request invalidation', async () => {
    const h = renderHook();
    harnesses.push(h);
    const oldRequest = deferred<CallsignInfoRes[]>();
    const newRequest = deferred<CallsignInfoRes[]>();
    fetchAnalysisCallsignInfosMock
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise);

    act(() => h.latest.setMessages([[1, buildMessage({ callsigns: ['wolf'] })]]));
    await act(async () => Promise.resolve());
    act(() => h.latest.invalidateMessagePageRequests());
    act(() => h.latest.setMessages([[2, buildMessage({ callsigns: ['wolf'] })]]));
    await act(async () => Promise.resolve());

    oldRequest.resolve([{ callsign: 'wolf', res: [], networkHints: [] }]);
    await act(async () => Promise.resolve());
    expect(h.summaryCallsignsInfo).toEqual({});

    const freshResponse = { callsign: 'wolf', res: [], networkHints: [] } satisfies CallsignInfoRes;
    newRequest.resolve([freshResponse]);
    await act(async () => Promise.resolve());
    expect(h.summaryCallsignsInfo.wolf).toEqual(freshResponse);
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
