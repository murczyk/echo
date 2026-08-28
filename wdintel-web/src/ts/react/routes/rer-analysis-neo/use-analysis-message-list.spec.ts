/**
 * @vitest-environment happy-dom
 */
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAnalysisMessageList } from './use-analysis-message-list';
import { emptyQueryState } from './helpers';
import type {
  CallsignInfoRes,
  InboxMessage,
  SignalGroupEntry,
  SignalProfileEntry,
} from '../../../../Bindings';

const fetchAnalysisCallsignInfosMock = vi.hoisted(() => vi.fn());
const fetchInboxMessagesMock = vi.hoisted(() => vi.fn());
const fetchInboxCountMock = vi.hoisted(() => vi.fn());

vi.mock('../../services/api/analysis', () => ({
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
  setNewestFirst: React.Dispatch<React.SetStateAction<boolean>>;
  setQueryState: React.Dispatch<React.SetStateAction<ReturnType<typeof buildQueryState>>>;
  summaryCallsignsInfo: Record<string, CallsignInfoRes>;
  groupInfos: Record<string, SignalGroupEntry>;
  profiles: Record<string, SignalProfileEntry | null>;
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
  focusedMessage: { id: number; active: boolean } = { id: 0, active: false },
): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const harness = { container, root } as Harness;

  function TestComponent() {
    const [deferInitialLoad, setDeferInitialLoad] = useState(initialDeferInitialLoad);
    const [currentNewestFirst, setNewestFirst] = useState(newestFirst);
    const [currentQueryState, setCurrentQueryState] = useState(queryState);
    harness.setDeferInitialLoad = setDeferInitialLoad;
    harness.setNewestFirst = setNewestFirst;
    harness.setQueryState = setCurrentQueryState;
    harness.onError ??= vi.fn();
    harness.onUnauthorized ??= vi.fn().mockReturnValue(false);
    const [summaryCallsignsInfo, setSummaryCallsignsInfo] = useState<
      Record<string, CallsignInfoRes>
    >(initialSummaryCallsignsInfo);
    harness.summaryCallsignsInfo = summaryCallsignsInfo;
    const [groupInfos, setGroupInfos] = useState<Record<string, SignalGroupEntry>>({});
    const [profiles, setProfiles] = useState<Record<string, SignalProfileEntry | null>>({});
    harness.groupInfos = groupInfos;
    harness.profiles = profiles;
    harness.latest = useAnalysisMessageList({
      deferInitialLoad,
      focusedMessageId: focusedMessage.id,
      focusedMessageActive: focusedMessage.active,
      loadMissingNetworksForMessages,
      newestFirst: currentNewestFirst,
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

  it('paginates direct-link messages in both directions without date limits', async () => {
    const queryState = {
      ...buildQueryState(),
      groupsSelected: ['group-1'],
      networksSelected: ['17'],
      freqsSelected: ['123.45'],
    };
    const h = renderHook(
      queryState,
      vi.fn().mockResolvedValue(undefined),
      false,
      false,
      {},
      { id: 50, active: true },
    );
    harnesses.push(h);
    act(() => h.latest.setMessages(page(50)));
    const earlierResponse = {
      inboxItems: [...page(49), ...page(48)],
      callsigns: [],
      signalGroups: [{ masterKey: 'group-1', name: 'Група Альфа' }],
      signalProfiles: {
        'sender-1': { givenName: 'Іван', familyName: 'Петренко' },
      },
      pageLimit: 2,
    };
    const laterResponse = {
      inboxItems: [...page(51), ...page(52)],
      callsigns: [],
      pageLimit: 20,
    };
    const earlierLoad = deferred<typeof earlierResponse>();
    const laterLoad = deferred<typeof laterResponse>();
    fetchInboxMessagesMock
      .mockReturnValueOnce(earlierLoad.promise)
      .mockReturnValueOnce(laterLoad.promise);

    let earlierPromise!: Promise<boolean>;
    let laterPromise!: Promise<boolean>;
    act(() => {
      earlierPromise = h.latest.loadFocusedEarlier();
      laterPromise = h.latest.loadFocusedLater();
    });

    expect(fetchInboxMessagesMock).toHaveBeenCalledTimes(2);
    expect(h.latest.focusedLoadingEarlier).toBe(true);
    expect(h.latest.focusedLoadingLater).toBe(true);

    await act(async () => {
      laterLoad.resolve(laterResponse);
      earlierLoad.resolve(earlierResponse);
      await Promise.all([earlierPromise, laterPromise]);
    });

    expect(h.latest.messages.map(([id]) => id)).toEqual([48, 49, 50, 51, 52]);
    expect(fetchInboxMessagesMock.mock.calls[0][0]).toMatchObject({
      beforeIdNoninclusive: 50,
      sinceIdNoninclusive: null,
      sinceDateInclusiveMs: null,
      tillDateInclusiveMs: null,
      newestFirst: true,
      selectedGroups: ['group-1'],
      selectedNetworks: [17],
      selectedFreqs: ['123.45'],
    });
    expect(fetchInboxMessagesMock.mock.calls[1][0]).toMatchObject({
      beforeIdNoninclusive: null,
      sinceIdNoninclusive: 50,
      sinceDateInclusiveMs: null,
      tillDateInclusiveMs: null,
      newestFirst: false,
    });
    expect(h.latest.focusedHasMoreEarlier).toBe(true);
    expect(h.latest.focusedHasMoreLater).toBe(false);
    expect(h.latest.focusedLoadingEarlier).toBe(false);
    expect(h.latest.focusedLoadingLater).toBe(false);
    expect(h.groupInfos['group-1']?.name).toBe('Група Альфа');
    expect(h.profiles['sender-1']).toEqual({ givenName: 'Іван', familyName: 'Петренко' });
  });

  it('reverses messages around the direct-link target without moving its list index', async () => {
    const h = renderHook(
      buildQueryState(),
      vi.fn().mockResolvedValue(undefined),
      false,
      false,
      {},
      { id: 50, active: true },
    );
    harnesses.push(h);
    act(() =>
      h.latest.setMessages([...page(48), ...page(49), ...page(50), ...page(51), ...page(52)]),
    );
    expect(h.latest.messages.map(([id]) => id)).toEqual([48, 49, 50, 51, 52]);

    act(() => h.setNewestFirst(true));

    expect(h.latest.messages.map(([id]) => id)).toEqual([52, 51, 50, 49, 48]);
    expect(fetchInboxMessagesMock).not.toHaveBeenCalled();
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
