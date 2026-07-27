/**
 * @vitest-environment happy-dom
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage } from '../../../../Bindings';
import { emptyQueryState } from './helpers';
import { useAnalysisData } from './use-analysis-data.core';

const hoisted = vi.hoisted(() => ({
  fetchMessagesByIds: vi.fn(),
  onInboxChangedMessageIds: vi.fn(),
  messages: [] as Array<[number, InboxMessage]>,
  mapOpenMessages: [] as Array<[number, InboxMessage]>,
  loadMissingNetworksForMessages: vi.fn(),
  loadMessageComments: vi.fn(),
  reload: vi.fn(),
  onError: vi.fn(),
  onUnauthorized: vi.fn().mockReturnValue(false),
}));

vi.mock('../../services/api/analysis', () => ({
  fetchMessagesByIds: hoisted.fetchMessagesByIds,
}));

vi.mock('../shared/useInboxChangedMessageIds', () => ({
  useInboxChangedMessageIds: ({
    onMessageIds,
  }: {
    onMessageIds: (messageIds: number[]) => void | Promise<void>;
  }) => {
    hoisted.onInboxChangedMessageIds = onMessageIds;
  },
}));

vi.mock('./use-analysis-data.wiring', () => ({
  buildAnalysisActionsParams: (input: unknown) => input,
  buildReloadOrchestratorParams: (input: unknown) => input,
}));

vi.mock('./use-analysis-data.support', () => ({
  useLoadMissingNetworksForMessages: () => hoisted.loadMissingNetworksForMessages,
  mergeNetworksById: vi.fn(),
  shouldSkipNewCallsignsLoad: vi.fn(),
}));

vi.mock('./use-analysis-reference-state', () => ({
  useAnalysisReferenceState: () => ({
    networksRef: { current: [] },
    unitsMapRef: { current: {} },
    summaryCallsignsInfoRef: { current: {} },
    optionsFreqsRef: { current: [] },
    shouldLoadNewCallsignsRef: { current: false },
    networkDisplayMap: {},
    setNetworkDisplayMap: vi.fn(),
    setNetworks: vi.fn(),
    unitsMap: {},
    setSummaryCallsignsInfo: vi.fn(),
    groupInfos: {},
    setGroupInfos: vi.fn(),
    options: { freqs: [] },
    setOptions: vi.fn(),
    setProfiles: vi.fn(),
    setTagsMap: vi.fn(),
    setTagsOrder: vi.fn(),
    profiles: {},
    networks: [],
  }),
}));

vi.mock('./use-analysis-message-list', () => ({
  useAnalysisMessageList: () => {
    const [messages, setMessages] = React.useState(hoisted.messages);
    return {
      counts: null,
      aorEntries: [],
      messagesLoading: false,
      hasLoadedInitialMessages: false,
      messagesPaging: false,
      messages,
      messageComments: {},
      messagesOverallCount: 0,
      messagesTotalCount: 0,
      messagesTotalLoading: false,
      noMoreToLoad: false,
      nolimitShown: false,
      pageIndex: 0,
      getCurrentMessagePageCursor: vi.fn(() => ({
        beforeIdNoninclusive: null,
        sinceIdNoninclusive: null,
      })),
      invalidateMessagePageRequests: vi.fn(),
      invalidateMessagePaging: vi.fn(),
      loadAllMessages: vi.fn(),
      loadMessageComments: hoisted.loadMessageComments,
      loadNextPage: vi.fn(),
      loadMoreMessages: vi.fn(),
      loadPrevPage: vi.fn(),
      setAorEntries: vi.fn(),
      setCounts: vi.fn(),
      setHasLoadedInitialMessages: vi.fn(),
      setMessageComments: vi.fn(),
      setMessages,
      setMessagesLoading: vi.fn(),
      setMessagesPaging: vi.fn(),
      setNoMoreToLoad: vi.fn(),
      setNolimitShown: vi.fn(),
      messageCommentsLoadVersionRef: { current: 0 },
    };
  },
}));

vi.mock('./use-analysis-map-data', () => ({
  useAnalysisMapData: () => {
    const [mapOpenMessages, setMapOpenMessages] = React.useState(hoisted.mapOpenMessages);
    return {
      mapLoading: false,
      mapDateRange: { startDate: 0, endDate: 0 },
      mapPoints: [],
      mapNetworkUnits: [],
      mapOpenMessages,
      mapPalitras: [],
      mapPalitrasLoaded: false,
      mapPalitrasLoadState: 'idle',
      mapMessagesLoadVersionRef: { current: 0 },
      mapDateRangeLoadVersionRef: { current: 0 },
      mapAttrs: { messages: mapOpenMessages },
      refreshMapDateRange: vi.fn(),
      loadMessagesForMap: vi.fn(),
      loadMapPalitras: vi.fn(),
      setMapLoading: vi.fn(),
      setMapDateRange: vi.fn(),
      setMapPoints: vi.fn(),
      setMapNetworkUnits: vi.fn(),
      setMapOpenMessages,
      setMapPalitras: vi.fn(),
      setMapPalitrasLoaded: vi.fn(),
      setMapPalitrasLoadState: vi.fn(),
    };
  },
}));

vi.mock('./use-analysis-sidebar-data', () => ({
  useAnalysisSidebarData: () => ({
    callsignGraph: null,
    callsignGraphLoading: false,
    callsignGraphLoadVersion: 0,
    callsignGraphLoadError: null,
    callsignGraphNolimit: false,
    correlatedFreqs: [],
    correlatedFreqsLoading: false,
    groupsActivityPeriod: 'selected',
    downloadGeojson: vi.fn(),
    downloadKmz: vi.fn(),
    downloadSummaryXlsx: vi.fn(),
    groupsActivity: null,
    groupsActivityLoadedFreq: null,
    groupsActivityLoadedPeriod: null,
    groupsActivityLoading: false,
    invalidateCallsignGraph: vi.fn(),
    invalidateCorrelatedFreqsCache: vi.fn(),
    invalidateRightSidebarData: vi.fn(),
    invalidateSummaryData: vi.fn(),
    loadCallsignGraph: vi.fn(),
    loadSummaryData: vi.fn(),
    loadTopSidebarData: vi.fn(),
    newCallsigns: null,
    newCallsignsLoading: false,
    newCallsignsLoadedKey: null,
    newCallsignsLoadedKeyRef: { current: null },
    newCallsignsPendingKeyRef: { current: null },
    newCallsignsRequestRef: { current: 0 },
    setNewCallsigns: vi.fn(),
    setNewCallsignsLoading: vi.fn(),
    setNewCallsignsLoadedKey: vi.fn(),
    setTopCallsigns: vi.fn(),
    setTopFreqs: vi.fn(),
    setTopLocations: vi.fn(),
    setTopUnits: vi.fn(),
    summaryLoading: false,
    summaryLoaded: false,
    summaryHasLoadedOnce: false,
    rightSidebarLoading: false,
    summaryRows: [],
    topCallsigns: [],
    topFreqs: [],
    topLocations: [],
    topUnits: [],
  }),
}));

vi.mock('./use-analysis-filter-sections', () => ({
  useAnalysisFilterSections: () => ({
    filterSectionLoadStates: {},
    isFilterSectionEmptyLoading: vi.fn(),
    isFilterSectionLoading: vi.fn(),
    isFilterSectionStale: vi.fn(),
    getLoadedFilterSections: vi.fn(),
    getReloadFilterSections: vi.fn(),
    invalidateFilterSectionLoads: vi.fn(),
    invalidateFilterSectionLoadsForPatch: vi.fn(),
    invalidateTagFacetLoad: vi.fn(),
    loadFilterSection: vi.fn(),
    loadInitialFilterSections: vi.fn(),
  }),
}));

vi.mock('./use-analysis-reload-orchestrator', () => ({
  useAnalysisReloadOrchestrator: () => ({ reload: hoisted.reload }),
}));

vi.mock('./use-analysis-actions', () => ({
  useAnalysisActions: () => ({
    clearAnalysisResults: vi.fn(),
    onUpdateLocalMessage: vi.fn(),
    messageActionState: { botTagAction: null, messageActionCount: 0 },
  }),
}));

type HookResult = ReturnType<typeof useAnalysisData>;
type PartialQueryState = Partial<ReturnType<typeof emptyQueryState>>;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: HookResult | null = null;

function renderHook(queryStateOverrides: PartialQueryState = {}) {
  if (container == null) throw new Error('container not initialized');
  const Harness = () => {
    latest = useAnalysisData({
      authUserName: null,
      currentUser: null,
      centerTab: 'messages',
      newestFirst: true,
      onError: hoisted.onError,
      onUnauthorized: hoisted.onUnauthorized,
      queryState: { ...emptyQueryState(), ...queryStateOverrides },
      rightSidebarVisible: false,
      rightSidebarTab: null,
      shouldLoadNewCallsigns: false,
      deferInitialLoad: false,
      rightPanelOpen: false,
    });
    return null;
  };

  root = createRoot(container);
  act(() => {
    root?.render(React.createElement(Harness));
  });
}

function inboxMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
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
    timestamp: null,
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
    tags: [],
    networkIds: [],
    inboxTags: [],
    metadata: [],
    ...overrides,
  } as InboxMessage;
}

function expectFetchMessagesByIdsCalledWith(messageIds: number[]) {
  expect(hoisted.fetchMessagesByIds).toHaveBeenCalledWith(
    messageIds,
    expect.objectContaining({
      highlightCallsigns: true,
      highlightKeywords: true,
      highlightPoints: true,
      highlightSearchres: true,
    }),
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  latest = null;
  hoisted.fetchMessagesByIds.mockReset();
  hoisted.loadMissingNetworksForMessages.mockReset();
  hoisted.loadMissingNetworksForMessages.mockResolvedValue(undefined);
  hoisted.loadMessageComments.mockReset();
  hoisted.loadMessageComments.mockResolvedValue(undefined);
  hoisted.reload.mockReset();
  hoisted.reload.mockResolvedValue(undefined);
  hoisted.onInboxChangedMessageIds = vi.fn();
  hoisted.onError.mockReset();
  hoisted.onUnauthorized.mockReturnValue(false);
  hoisted.messages = [];
  hoisted.mapOpenMessages = [];
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

describe('useAnalysisData inbox refreshes', () => {
  it('skips fetching when no visible ids overlap', async () => {
    hoisted.messages = [[1, inboxMessage({ text: 'one' })]];
    hoisted.mapOpenMessages = [[2, inboxMessage({ text: 'map' })]];

    renderHook();
    await act(async () => {
      await hoisted.onInboxChangedMessageIds([9]);
    });

    expect(hoisted.fetchMessagesByIds).not.toHaveBeenCalled();
    expect(hoisted.loadMissingNetworksForMessages).not.toHaveBeenCalled();
    expect(hoisted.loadMessageComments).not.toHaveBeenCalled();
    expect(hoisted.reload).not.toHaveBeenCalled();
  });

  it('refreshes visible ids and rendered text fields', async () => {
    const currentMessage = inboxMessage({
      text: 'current',
      pointTokens: [{ begin: 0, end: 3, etalon: 'old-point', text: 'old' }],
      keywordTokens: [{ text: 'keyword' }] as never,
      textMarked: [{ CNTextC: { text: 'marked' } }] as never,
      tags: [1],
      inboxTags: [{ id: 1, tagId: 1, confidence: 1, login: null, model: null, organismId: null }],
    });
    const currentMapMessage = inboxMessage({
      text: 'map-current',
      pointTokens: [{ begin: 0, end: 3, etalon: 'old-map-point', text: 'old' }],
      keywordTokens: [{ text: 'map-keyword' }] as never,
      textMarked: [{ CNTextC: { text: 'map-marked' } }] as never,
      tags: [1],
      inboxTags: [{ id: 1, tagId: 1, confidence: 1, login: null, model: null, organismId: null }],
    });
    const updatedMessage = inboxMessage({
      text: 'updated',
      pointTokens: [{ begin: 4, end: 9, etalon: 'new-point', text: 'new' }],
      keywordTokens: [{ text: 'new keyword' }] as never,
      textMarked: [{ CNTextC: { text: 'new marked' } }] as never,
      networkIds: [42],
      tags: [2],
      inboxTags: [{ id: 2, tagId: 2, confidence: 1, login: null, model: null, organismId: null }],
    });
    hoisted.messages = [
      [1, currentMessage],
      [2, currentMessage],
    ];
    hoisted.mapOpenMessages = [[2, currentMapMessage]];
    hoisted.fetchMessagesByIds.mockResolvedValueOnce([[2, updatedMessage]]);

    renderHook();
    await act(async () => {
      await hoisted.onInboxChangedMessageIds([2]);
    });

    expectFetchMessagesByIdsCalledWith([2]);
    expect(latest?.messages).toEqual([
      [1, currentMessage],
      [2, updatedMessage],
    ]);
    expect(latest?.mapAttrs.messages).toEqual([[2, updatedMessage]]);
    expect(latest?.messages[1][1].text).toBe(updatedMessage.text);
    expect(latest?.mapAttrs.messages[0][1].text).toBe(updatedMessage.text);
    expect(latest?.messages[1][1].pointTokens).toBe(updatedMessage.pointTokens);
    expect(latest?.mapAttrs.messages[0][1].pointTokens).toBe(updatedMessage.pointTokens);
    expect(latest?.messages[1][1].keywordTokens).toBe(updatedMessage.keywordTokens);
    expect(latest?.messages[1][1].textMarked).toBe(updatedMessage.textMarked);
    expect(latest?.mapAttrs.messages[0][1].keywordTokens).toBe(updatedMessage.keywordTokens);
    expect(latest?.mapAttrs.messages[0][1].textMarked).toBe(updatedMessage.textMarked);
    expect(hoisted.loadMissingNetworksForMessages).toHaveBeenCalledWith([[2, updatedMessage]]);
    expect(hoisted.loadMessageComments).toHaveBeenCalledWith([[2, updatedMessage]], true);
    expect(hoisted.onError).not.toHaveBeenCalled();
  });

  it('removes visible changed ids omitted from refreshed messages', async () => {
    const unchangedMessage = inboxMessage({ text: 'unchanged' });
    const deletedListMessage = inboxMessage({ text: 'deleted-list' });
    const deletedMapMessage = inboxMessage({ text: 'deleted-map' });
    const unchangedMapMessage = inboxMessage({ text: 'unchanged-map' });
    hoisted.messages = [
      [1, unchangedMessage],
      [2, deletedListMessage],
    ];
    hoisted.mapOpenMessages = [
      [2, deletedMapMessage],
      [3, unchangedMapMessage],
    ];
    hoisted.fetchMessagesByIds.mockResolvedValueOnce([]);

    renderHook();
    await act(async () => {
      await hoisted.onInboxChangedMessageIds([2]);
    });

    expectFetchMessagesByIdsCalledWith([2]);
    expect(latest?.messages).toEqual([[1, unchangedMessage]]);
    expect(latest?.mapAttrs.messages).toEqual([[3, unchangedMapMessage]]);
    expect(hoisted.loadMessageComments).toHaveBeenCalledWith([], true);
  });

  it('removes refreshed visible ids that no longer match selected tags', async () => {
    const currentMessage = inboxMessage({
      text: 'current',
      tags: [3],
      inboxTags: [{ id: 1, tagId: 3, confidence: 1, login: null, model: null, organismId: null }],
    });
    const updatedMessage = inboxMessage({
      text: 'updated',
      tags: [4],
      inboxTags: [{ id: 2, tagId: 4, confidence: 1, login: null, model: null, organismId: null }],
    });
    hoisted.messages = [[1, currentMessage]];
    hoisted.mapOpenMessages = [[1, currentMessage]];
    hoisted.fetchMessagesByIds.mockResolvedValueOnce([[1, updatedMessage]]);

    renderHook({ tags: [3] });
    await act(async () => {
      await hoisted.onInboxChangedMessageIds([1]);
    });

    expect(latest?.messages).toEqual([]);
    expect(latest?.mapAttrs.messages).toEqual([]);
    expect(hoisted.loadMessageComments).toHaveBeenCalledWith([], true);
  });

  it('removes refreshed visible ids that no longer match selected freqs', async () => {
    const currentMessage = inboxMessage({ text: 'current', freq: '100.0000' });
    const updatedMessage = inboxMessage({ text: 'updated', freq: '200.0000' });
    hoisted.messages = [[1, currentMessage]];
    hoisted.mapOpenMessages = [[1, currentMessage]];
    hoisted.fetchMessagesByIds.mockResolvedValueOnce([[1, updatedMessage]]);

    renderHook({ freqsSelected: ['100.0000'] });
    await act(async () => {
      await hoisted.onInboxChangedMessageIds([1]);
    });

    expect(latest?.messages).toEqual([]);
    expect(latest?.mapAttrs.messages).toEqual([]);
    expect(hoisted.loadMessageComments).toHaveBeenCalledWith([], true);
  });

  it('uses partial refresh when only a client-checkable date range is active', async () => {
    const currentMessage = inboxMessage({
      text: 'current',
      date: '2026-01-16',
      time: '12:00:00',
      timestamp: Date.UTC(2026, 0, 18, 12),
    });
    const updatedMessage = inboxMessage({
      text: 'updated',
      date: '2026-01-16',
      time: '13:00:30',
      timestamp: Date.UTC(2026, 0, 18, 13),
    });
    hoisted.messages = [[1, currentMessage]];
    hoisted.mapOpenMessages = [[1, currentMessage]];
    hoisted.fetchMessagesByIds.mockResolvedValueOnce([[1, updatedMessage]]);

    renderHook({
      fromDateTimeStr: '2026-01-16T00:00',
      toDateTimeStr: '2026-01-17T00:00',
    });
    await act(async () => {
      await hoisted.onInboxChangedMessageIds([1]);
    });

    expect(hoisted.reload).not.toHaveBeenCalled();
    expectFetchMessagesByIdsCalledWith([1]);
    expect(latest?.messages).toEqual([[1, updatedMessage]]);
    expect(latest?.mapAttrs.messages).toEqual([[1, updatedMessage]]);
    expect(hoisted.loadMessageComments).toHaveBeenCalledWith([[1, updatedMessage]], true);
  });

  it('removes refreshed visible ids outside the active date range', async () => {
    const currentMessage = inboxMessage({
      text: 'current',
      date: '2026-01-16',
      time: '12:00:00',
      timestamp: Date.UTC(2026, 0, 16, 12),
    });
    const updatedMessage = inboxMessage({
      text: 'updated',
      date: '2026-01-18',
      time: '12:00:00',
      timestamp: Date.UTC(2026, 0, 16, 12),
    });
    hoisted.messages = [[1, currentMessage]];
    hoisted.mapOpenMessages = [[1, currentMessage]];
    hoisted.fetchMessagesByIds.mockResolvedValueOnce([[1, updatedMessage]]);

    renderHook({
      fromDateTimeStr: '2026-01-16T00:00',
      toDateTimeStr: '2026-01-17T00:00',
    });
    await act(async () => {
      await hoisted.onInboxChangedMessageIds([1]);
    });

    expect(hoisted.reload).not.toHaveBeenCalled();
    expectFetchMessagesByIdsCalledWith([1]);
    expect(latest?.messages).toEqual([]);
    expect(latest?.mapAttrs.messages).toEqual([]);
    expect(hoisted.loadMessageComments).toHaveBeenCalledWith([], true);
  });

  it('keeps refreshed visible ids at the inclusive date range end', async () => {
    const currentMessage = inboxMessage({
      text: 'current',
      date: '2026-01-16',
      time: '11:59:00',
      timestamp: Date.UTC(2026, 0, 16, 11, 59),
    });
    const updatedMessage = inboxMessage({
      text: 'updated',
      date: '2026-01-16',
      time: '12:00:00',
      timestamp: Date.UTC(2026, 0, 16, 12),
    });
    hoisted.messages = [[1, currentMessage]];
    hoisted.mapOpenMessages = [[1, currentMessage]];
    hoisted.fetchMessagesByIds.mockResolvedValueOnce([[1, updatedMessage]]);

    renderHook({
      fromDateTimeStr: '2026-01-16T00:00',
      toDateTimeStr: '2026-01-16T12:00',
    });
    await act(async () => {
      await hoisted.onInboxChangedMessageIds([1]);
    });

    expect(hoisted.reload).not.toHaveBeenCalled();
    expectFetchMessagesByIdsCalledWith([1]);
    expect(latest?.messages).toEqual([[1, updatedMessage]]);
    expect(latest?.mapAttrs.messages).toEqual([[1, updatedMessage]]);
    expect(hoisted.loadMessageComments).toHaveBeenCalledWith([[1, updatedMessage]], true);
  });

  it('ignores invisible ids when server-only filters are active', async () => {
    hoisted.messages = [[1, inboxMessage({ text: 'current' })]];
    hoisted.mapOpenMessages = [[2, inboxMessage({ text: 'map-current' })]];

    renderHook({ search: 'needle' });
    await act(async () => {
      await hoisted.onInboxChangedMessageIds([9]);
    });

    expect(hoisted.reload).not.toHaveBeenCalled();
    expect(hoisted.fetchMessagesByIds).not.toHaveBeenCalled();
    expect(hoisted.loadMissingNetworksForMessages).not.toHaveBeenCalled();
    expect(hoisted.loadMessageComments).not.toHaveBeenCalled();
  });

  it('reloads once for a list-visible id when server-only filters are active', async () => {
    hoisted.messages = [[1, inboxMessage({ text: 'current' })]];

    renderHook({ search: 'needle' });
    await act(async () => {
      await hoisted.onInboxChangedMessageIds([1]);
    });

    expect(hoisted.reload).toHaveBeenCalledTimes(1);
    expect(hoisted.fetchMessagesByIds).not.toHaveBeenCalled();
    expect(hoisted.loadMissingNetworksForMessages).not.toHaveBeenCalled();
    expect(hoisted.loadMessageComments).not.toHaveBeenCalled();
  });

  it('reloads once for a map-only visible id when server-only filters are active', async () => {
    hoisted.mapOpenMessages = [[2, inboxMessage({ text: 'map-current' })]];

    renderHook({ search: 'needle' });
    await act(async () => {
      await hoisted.onInboxChangedMessageIds([2]);
    });

    expect(hoisted.reload).toHaveBeenCalledTimes(1);
    expect(hoisted.fetchMessagesByIds).not.toHaveBeenCalled();
    expect(hoisted.loadMissingNetworksForMessages).not.toHaveBeenCalled();
    expect(hoisted.loadMessageComments).not.toHaveBeenCalled();
  });

  it('reloads once for a mixed visible and invisible batch under server-only filters', async () => {
    hoisted.messages = [[1, inboxMessage({ text: 'current' })]];

    renderHook({ search: 'needle' });
    await act(async () => {
      await hoisted.onInboxChangedMessageIds([9, 1, 10]);
    });

    expect(hoisted.reload).toHaveBeenCalledTimes(1);
    expect(hoisted.fetchMessagesByIds).not.toHaveBeenCalled();
    expect(hoisted.loadMissingNetworksForMessages).not.toHaveBeenCalled();
    expect(hoisted.loadMessageComments).not.toHaveBeenCalled();
  });

  it('ignores all incoming ids when both visible collections are empty', async () => {
    renderHook({ search: 'needle' });
    await act(async () => {
      await hoisted.onInboxChangedMessageIds([1, 2, 3]);
    });

    expect(hoisted.reload).not.toHaveBeenCalled();
    expect(hoisted.fetchMessagesByIds).not.toHaveBeenCalled();
    expect(hoisted.loadMissingNetworksForMessages).not.toHaveBeenCalled();
    expect(hoisted.loadMessageComments).not.toHaveBeenCalled();
  });

  it('filters model tags again when withoutModelTags is enabled', async () => {
    const currentMessage = inboxMessage({
      text: 'current',
      tags: [3, 4],
      inboxTags: [
        { id: 1, tagId: 3, confidence: 1, login: null, model: null, organismId: null },
        { id: 2, tagId: 4, confidence: 1, login: null, model: 'bot', organismId: null },
      ],
    });
    const updatedMessage = inboxMessage({
      text: 'updated',
      tags: [3, 4, 5],
      inboxTags: [
        { id: 1, tagId: 3, confidence: 1, login: null, model: null, organismId: null },
        { id: 2, tagId: 4, confidence: 1, login: null, model: 'bot', organismId: null },
        { id: 3, tagId: 5, confidence: 1, login: null, model: null, organismId: null },
      ],
    });
    hoisted.messages = [[1, currentMessage]];
    hoisted.fetchMessagesByIds.mockResolvedValueOnce([[1, updatedMessage]]);

    renderHook({ withoutModelTags: true });
    await act(async () => {
      await hoisted.onInboxChangedMessageIds([1]);
    });

    expect(latest?.messages[0][1].inboxTags).toEqual([
      { id: 1, tagId: 3, confidence: 1, login: null, model: null, organismId: null },
      { id: 3, tagId: 5, confidence: 1, login: null, model: null, organismId: null },
    ]);
    expect(latest?.messages[0][1].tags).toEqual([3, 5]);
    expect(latest?.mapAttrs.messages).toEqual([]);
    expect(hoisted.loadMessageComments).toHaveBeenCalledWith([[1, updatedMessage]], true);
  });

  it('surfaces fetch failures and leaves state unchanged', async () => {
    hoisted.messages = [[1, inboxMessage({ text: 'current' })]];
    hoisted.mapOpenMessages = [[1, inboxMessage({ text: 'map-current' })]];
    hoisted.fetchMessagesByIds.mockRejectedValueOnce(new Error('boom'));

    renderHook();
    await act(async () => {
      await hoisted.onInboxChangedMessageIds([1]);
    });

    expect(hoisted.onError).toHaveBeenCalledWith('boom');
    expect(latest?.messages[0][1].text).toBe('current');
    expect(latest?.mapAttrs.messages[0][1].text).toBe('map-current');
    expect(hoisted.loadMissingNetworksForMessages).not.toHaveBeenCalled();
    expect(hoisted.loadMessageComments).not.toHaveBeenCalled();
  });
});
