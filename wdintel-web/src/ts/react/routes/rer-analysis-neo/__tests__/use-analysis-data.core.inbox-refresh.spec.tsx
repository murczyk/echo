/**
 * @vitest-environment happy-dom
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage } from '../../../../../Bindings';
import { emptyQueryState } from '../helpers';
import { useAnalysisData } from '../use-analysis-data.core';

const hoisted = vi.hoisted(() => ({
  fetchMessagesByIds: vi.fn(),
  fetchMessageIdsMatchingFilters: vi.fn(),
  onInboxChangedMessageIds: vi.fn(),
  messages: [] as Array<[number, InboxMessage]>,
  mapOpenMessages: [] as Array<[number, InboxMessage]>,
  mapDateRange: { startDate: 0, endDate: 0 },
  mapMessagesLoadVersionRef: { current: 0 },
  setMapOpenMessages: null as ((messages: Array<[number, InboxMessage]>) => void) | null,
  loadMissingNetworksForMessages: vi.fn(),
  loadMessageComments: vi.fn(),
  refreshMessageCounts: vi.fn(),
  reload: vi.fn(),
  onError: vi.fn(),
  onUnauthorized: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../services/api/analysis', () => ({
  fetchMessagesByIds: hoisted.fetchMessagesByIds,
  fetchMessagesByIdsMatchingFilters: hoisted.fetchMessageIdsMatchingFilters,
}));

vi.mock('../../shared/useInboxChangedMessageIds', () => ({
  useInboxChangedMessageIds: ({
    onMessageIds,
  }: {
    onMessageIds: (messageIds: number[]) => void | Promise<void>;
  }) => {
    hoisted.onInboxChangedMessageIds = onMessageIds;
  },
}));

vi.mock('../use-analysis-data.wiring', () => ({
  buildAnalysisActionsParams: (input: unknown) => input,
  buildReloadOrchestratorParams: (input: unknown) => input,
}));

vi.mock('../use-analysis-data.support', () => ({
  useLoadMissingNetworksForMessages: () => hoisted.loadMissingNetworksForMessages,
  mergeNetworksById: vi.fn(),
  shouldSkipNewCallsignsLoad: vi.fn(),
}));

vi.mock('../use-analysis-reference-state', () => ({
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

vi.mock('../use-analysis-message-list', () => ({
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
      refreshMessageCounts: hoisted.refreshMessageCounts,
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

vi.mock('../use-analysis-map-data', () => ({
  useAnalysisMapData: () => {
    const [mapOpenMessages, setMapOpenMessages] = React.useState(hoisted.mapOpenMessages);
    hoisted.setMapOpenMessages = (messages) => setMapOpenMessages(messages);
    return {
      mapLoading: false,
      mapDateRange: hoisted.mapDateRange,
      mapPoints: [],
      mapNetworkUnits: [],
      mapOpenMessages,
      mapPalitras: [],
      mapPalitrasLoaded: false,
      mapPalitrasLoadState: 'idle',
      mapMessagesLoadVersionRef: hoisted.mapMessagesLoadVersionRef,
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

vi.mock('../use-analysis-sidebar-data', () => ({
  useAnalysisSidebarData: () => ({
    callsignGraph: null,
    callsignGraphLoading: false,
    callsignGraphLoadVersion: 0,
    callsignGraphLoadError: null,
    correlatedFreqs: [],
    correlatedFreqsLoaded: false,
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

vi.mock('../use-analysis-data-filter-sections', () => ({
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

vi.mock('../use-analysis-reload-orchestrator', () => ({
  useAnalysisReloadOrchestrator: () => ({ reload: hoisted.reload }),
}));

vi.mock('../use-analysis-actions', () => ({
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
  hoisted.fetchMessageIdsMatchingFilters.mockReset();
  hoisted.fetchMessageIdsMatchingFilters.mockResolvedValue([]);
  hoisted.loadMissingNetworksForMessages.mockReset();
  hoisted.loadMissingNetworksForMessages.mockResolvedValue(undefined);
  hoisted.loadMessageComments.mockReset();
  hoisted.loadMessageComments.mockResolvedValue(undefined);
  hoisted.refreshMessageCounts.mockReset();
  hoisted.reload.mockReset();
  hoisted.reload.mockResolvedValue(undefined);
  hoisted.onInboxChangedMessageIds = vi.fn();
  hoisted.onError.mockReset();
  hoisted.onUnauthorized.mockReturnValue(false);
  hoisted.messages = [];
  hoisted.mapOpenMessages = [];
  hoisted.mapDateRange = { startDate: 0, endDate: 0 };
  hoisted.mapMessagesLoadVersionRef.current = 0;
  hoisted.setMapOpenMessages = null;
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
  it('inserts an ordinary unseen message that matches the current filters', async () => {
    const currentMessage = inboxMessage({
      text: 'one',
      date: '16.01.2026',
      time: '11:00:00',
      tags: [3],
    });
    const newMessage = inboxMessage({
      text: 'new',
      date: '16.01.2026',
      time: '12:00:00',
      tags: [3],
    });
    hoisted.messages = [[1, currentMessage]];
    hoisted.mapOpenMessages = [[2, inboxMessage({ text: 'map' })]];
    hoisted.fetchMessageIdsMatchingFilters.mockResolvedValueOnce([[9, newMessage]]);

    renderHook({
      fromDateTimeStr: '2026-01-16T00:00',
      toDateTimeStr: '2026-01-17T00:00',
      tags: [3],
    });
    await act(async () => {
      await hoisted.onInboxChangedMessageIds(
        [9],
        [{ messageId: 9, origin: null, intelligenceReport: false }],
      );
    });

    expect(hoisted.fetchMessageIdsMatchingFilters).toHaveBeenCalledWith(
      [9],
      expect.objectContaining({ selectedTags: [3] }),
    );
    expect(hoisted.fetchMessagesByIds).not.toHaveBeenCalled();
    expect(latest?.messages).toEqual([
      [9, newMessage],
      [1, currentMessage],
    ]);
    expect(hoisted.loadMissingNetworksForMessages).toHaveBeenCalledWith([[9, newMessage]]);
    expect(hoisted.loadMessageComments).toHaveBeenCalledWith([[9, newMessage]], true);
    expect(hoisted.refreshMessageCounts).toHaveBeenCalledTimes(1);
    expect(hoisted.reload).not.toHaveBeenCalled();
  });

  it('inserts a newly created intelligence report that matches the current filters', async () => {
    const report = inboxMessage({ text: 'new report', groupMasterKey: 'group-2' });
    hoisted.fetchMessageIdsMatchingFilters.mockResolvedValueOnce([[91, report]]);

    renderHook({ groupsSelected: ['group-2'] });
    await act(async () => {
      await hoisted.onInboxChangedMessageIds(
        [91],
        [{ messageId: 91, origin: null, intelligenceReport: true }],
      );
    });

    expect(hoisted.fetchMessageIdsMatchingFilters).toHaveBeenCalledWith(
      [91],
      expect.objectContaining({ highlightPoints: true }),
    );
    expect(hoisted.fetchMessagesByIds).not.toHaveBeenCalled();
    expect(latest?.messages).toEqual([[91, report]]);
    expect(hoisted.refreshMessageCounts).toHaveBeenCalledTimes(1);
    expect(hoisted.reload).not.toHaveBeenCalled();
  });

  it('inserts a grouped report after its parent was refreshed first', async () => {
    const reportSummary = {
      id: 91,
      isAccessible: true,
      isDeleted: false,
      text: 'new report',
      attachmentsCount: 0,
      timestamp: null,
      date: null,
      time: null,
      groupName: 'Group 2',
      groupMasterKey: 'group-2',
    };
    const parent = inboxMessage({ text: 'parent', intelligenceReports: [] });
    const updatedParent = inboxMessage({
      text: 'parent',
      intelligenceReports: [reportSummary],
    });
    const report = inboxMessage({
      text: 'new report',
      groupMasterKey: 'group-2',
      parentMessages: [
        {
          id: 42,
          isAccessible: true,
          isDeleted: false,
          text: 'parent',
          attachmentsCount: 0,
          timestamp: null,
          date: null,
          time: null,
          groupName: 'Group 2',
          groupMasterKey: 'group-2',
        },
      ],
    });
    hoisted.messages = [[42, parent]];
    hoisted.fetchMessageIdsMatchingFilters.mockResolvedValueOnce([[91, report]]);
    hoisted.fetchMessagesByIds
      .mockResolvedValueOnce([[42, updatedParent]])
      .mockResolvedValueOnce([[42, updatedParent]]);

    renderHook();
    await act(async () => {
      await hoisted.onInboxChangedMessageIds(
        [42],
        [{ messageId: 42, origin: null, intelligenceReport: true }],
      );
    });
    await act(async () => {
      await hoisted.onInboxChangedMessageIds(
        [91],
        [{ messageId: 91, origin: null, intelligenceReport: true }],
      );
    });

    expect(hoisted.fetchMessageIdsMatchingFilters).toHaveBeenCalledWith(
      [91],
      expect.objectContaining({ highlightPoints: true }),
    );
    expectFetchMessagesByIdsCalledWith([42]);
    expect(latest?.messages.map(([messageId]) => messageId)).toEqual([91, 42]);
    expect(latest?.messages[1]?.[1].intelligenceReports).toEqual([reportSummary]);
    expect(hoisted.reload).not.toHaveBeenCalled();
  });

  it('does not reload for a new intelligence report the user cannot access', async () => {
    hoisted.fetchMessageIdsMatchingFilters.mockResolvedValueOnce([]);

    renderHook({ groupsSelected: ['group-2'] });
    await act(async () => {
      await hoisted.onInboxChangedMessageIds(
        [91],
        [{ messageId: 91, origin: null, intelligenceReport: true }],
      );
    });

    expect(hoisted.fetchMessageIdsMatchingFilters).toHaveBeenCalledWith(
      [91],
      expect.objectContaining({ highlightPoints: true }),
    );
    expect(hoisted.reload).not.toHaveBeenCalled();
  });

  it('refreshes a parent card when its intelligence report changes', async () => {
    const reportSummary = {
      id: 91,
      isAccessible: true,
      isDeleted: false,
      text: 'report',
      attachmentsCount: 1,
      timestamp: null,
      date: null,
      time: null,
      groupName: 'Group 2',
      groupMasterKey: 'group-2',
    };
    const parent = inboxMessage({ intelligenceReports: [reportSummary] });
    const updatedParent = inboxMessage({
      intelligenceReports: [{ ...reportSummary, attachmentsCount: 3 }],
    });
    hoisted.messages = [[42, parent]];
    hoisted.fetchMessagesByIds.mockResolvedValueOnce([[42, updatedParent]]);

    renderHook();
    await act(async () => {
      await hoisted.onInboxChangedMessageIds(
        [91],
        [{ messageId: 91, origin: null, intelligenceReport: true }],
      );
    });

    expectFetchMessagesByIdsCalledWith([42]);
    expect(latest?.messages[0][1].intelligenceReports).toEqual([
      { ...reportSummary, attachmentsCount: 3 },
    ]);
    expect(hoisted.reload).not.toHaveBeenCalled();
  });

  it('removes a deleted intelligence report preview from its parent card', async () => {
    const parent = inboxMessage({
      intelligenceReports: [
        {
          id: 91,
          isAccessible: true,
          isDeleted: false,
          text: 'report',
          attachmentsCount: 1,
          timestamp: null,
          date: null,
          time: null,
          groupName: 'Group 2',
          groupMasterKey: 'group-2',
        },
      ],
    });
    const updatedParent = inboxMessage({ intelligenceReports: [] });
    hoisted.messages = [[42, parent]];
    hoisted.fetchMessagesByIds.mockResolvedValueOnce([[42, updatedParent]]);

    renderHook();
    await act(async () => {
      await hoisted.onInboxChangedMessageIds(
        [91],
        [{ messageId: 91, origin: null, intelligenceReport: true }],
      );
    });

    expectFetchMessagesByIdsCalledWith([42]);
    expect(latest?.messages[0][1].intelligenceReports).toEqual([]);
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

  it('keeps a visible message with fractional seconds inside the active date range', async () => {
    const currentMessage = inboxMessage({
      text: 'current',
      date: '16.01.2026',
      time: '12:00:00.125',
    });
    const updatedMessage = inboxMessage({
      text: 'updated',
      date: '16.01.2026',
      time: '12:00:00.875',
    });
    hoisted.messages = [[1, currentMessage]];
    hoisted.fetchMessagesByIds.mockResolvedValueOnce([[1, updatedMessage]]);

    renderHook({
      fromDateTimeStr: '2026-01-16T00:00',
      toDateTimeStr: '2026-01-17T00:00',
    });
    await act(async () => {
      await hoisted.onInboxChangedMessageIds([1]);
    });

    expect(latest?.messages).toEqual([[1, updatedMessage]]);
    expect(hoisted.reload).not.toHaveBeenCalled();
  });

  it('reorders a visible message when its event time changes', async () => {
    const firstMessage = inboxMessage({
      text: 'first',
      date: '16.01.2026',
      time: '11:00:00',
    });
    const secondMessage = inboxMessage({
      text: 'second',
      date: '16.01.2026',
      time: '10:00:00',
    });
    const updatedSecondMessage = inboxMessage({
      text: 'second updated',
      date: '16.01.2026',
      time: '12:00:00',
    });
    hoisted.messages = [
      [1, firstMessage],
      [2, secondMessage],
    ];
    hoisted.fetchMessagesByIds.mockResolvedValueOnce([[2, updatedSecondMessage]]);

    renderHook({
      fromDateTimeStr: '2026-01-16T00:00',
      toDateTimeStr: '2026-01-17T00:00',
    });
    await act(async () => {
      await hoisted.onInboxChangedMessageIds([2]);
    });

    expect(latest?.messages).toEqual([
      [2, updatedSecondMessage],
      [1, firstMessage],
    ]);
    expect(hoisted.reload).not.toHaveBeenCalled();
  });

  it('keeps a visible message when its event time moves it past the loaded tail', async () => {
    const firstMessage = inboxMessage({
      text: 'first',
      date: '16.01.2026',
      time: '12:00:00',
    });
    const secondMessage = inboxMessage({
      text: 'second',
      date: '16.01.2026',
      time: '11:00:00',
    });
    const updatedFirstMessage = inboxMessage({
      text: 'first updated',
      date: '16.01.2026',
      time: '10:00:00',
    });
    hoisted.messages = [
      [1, firstMessage],
      [2, secondMessage],
    ];
    hoisted.fetchMessagesByIds.mockResolvedValueOnce([[1, updatedFirstMessage]]);

    renderHook({
      fromDateTimeStr: '2026-01-16T00:00',
      toDateTimeStr: '2026-01-17T00:00',
    });
    await act(async () => {
      await hoisted.onInboxChangedMessageIds([1]);
    });

    expect(latest?.messages).toEqual([
      [2, secondMessage],
      [1, updatedFirstMessage],
    ]);
    expect(hoisted.reload).not.toHaveBeenCalled();
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

  it('uses creation time when reconciling a visible message in creation-time mode', async () => {
    const currentMessage = inboxMessage({
      text: 'current',
      createdAt: Date.UTC(2026, 0, 16, 12),
      date: '2026-01-18',
      time: '12:00:00',
    });
    const updatedMessage = inboxMessage({
      text: 'updated',
      createdAt: Date.UTC(2026, 0, 16, 13),
      date: '2026-01-18',
      time: '13:00:00',
    });
    hoisted.messages = [[1, currentMessage]];
    hoisted.mapOpenMessages = [[1, currentMessage]];
    hoisted.fetchMessagesByIds.mockResolvedValueOnce([[1, updatedMessage]]);

    renderHook({
      fromDateTimeStr: '2026-01-16T00:00',
      toDateTimeStr: '2026-01-17T00:00',
      messageTimeBasis: 'creation',
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

  it('does not reload when an accessible unseen id does not match server-only filters', async () => {
    hoisted.messages = [[1, inboxMessage({ text: 'current' })]];
    hoisted.mapOpenMessages = [[2, inboxMessage({ text: 'map-current' })]];
    hoisted.fetchMessageIdsMatchingFilters.mockResolvedValueOnce([]);

    renderHook({ search: 'needle' });
    await act(async () => {
      await hoisted.onInboxChangedMessageIds(
        [9],
        [{ messageId: 9, origin: null, intelligenceReport: false }],
      );
    });

    expect(hoisted.reload).not.toHaveBeenCalled();
    expect(hoisted.fetchMessageIdsMatchingFilters).toHaveBeenCalledWith(
      [9],
      expect.objectContaining({ search: 'needle' }),
    );
    expect(hoisted.loadMissingNetworksForMessages).not.toHaveBeenCalled();
    expect(hoisted.loadMessageComments).not.toHaveBeenCalled();
    expect(hoisted.refreshMessageCounts).not.toHaveBeenCalled();
  });

  it('checks unseen ids against the messages-only media filter', async () => {
    hoisted.fetchMessageIdsMatchingFilters.mockResolvedValueOnce([]);

    renderHook({ onlyWithMedia: true });
    await act(async () => {
      await hoisted.onInboxChangedMessageIds([9]);
    });

    expect(hoisted.fetchMessageIdsMatchingFilters).toHaveBeenCalledWith(
      [9],
      expect.objectContaining({ onlyWithMedia: true }),
    );
    expect(hoisted.reload).not.toHaveBeenCalled();
  });

  it('keeps a map-open message without media when the messages-only media filter is active', async () => {
    const currentMessage = inboxMessage({ text: 'map current' });
    const updatedMessage = inboxMessage({ text: 'map updated' });
    hoisted.mapOpenMessages = [[2, currentMessage]];
    hoisted.fetchMessageIdsMatchingFilters.mockImplementation(async (_messageIds, inboxReq) =>
      inboxReq.onlyWithMedia ? [] : [[2, updatedMessage]],
    );

    renderHook({ onlyWithMedia: true, search: 'map' });
    await act(async () => {
      await hoisted.onInboxChangedMessageIds([2]);
    });

    expect(hoisted.fetchMessageIdsMatchingFilters).toHaveBeenCalledWith(
      [2],
      expect.objectContaining({ onlyWithMedia: false }),
    );
    expect(hoisted.fetchMessagesByIds).not.toHaveBeenCalled();
    expect(latest?.messages).toEqual([]);
    expect(latest?.mapAttrs.messages).toEqual([[2, updatedMessage]]);
    expect(hoisted.reload).not.toHaveBeenCalled();
  });

  it('uses the active map date range when refreshing a map-open message', async () => {
    const currentMessage = inboxMessage({
      text: 'map current',
      date: '18.01.2026',
      time: '11:00:00',
    });
    const updatedMessage = inboxMessage({
      text: 'map updated',
      date: '18.01.2026',
      time: '12:00:00',
    });
    hoisted.mapOpenMessages = [[2, currentMessage]];
    hoisted.mapDateRange = {
      startDate: Date.UTC(2026, 0, 18),
      endDate: Date.UTC(2026, 0, 19),
    };
    hoisted.fetchMessagesByIds.mockResolvedValueOnce([[2, updatedMessage]]);

    renderHook({
      fromDateTimeStr: '2026-01-16T00:00',
      toDateTimeStr: '2026-01-17T00:00',
    });
    await act(async () => {
      await hoisted.onInboxChangedMessageIds([2]);
    });

    expect(hoisted.fetchMessagesByIds).toHaveBeenCalledWith(
      [2],
      expect.objectContaining({
        sinceDateInclusiveMs: hoisted.mapDateRange.startDate,
        tillDateInclusiveMs: hoisted.mapDateRange.endDate,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(latest?.mapAttrs.messages).toEqual([[2, updatedMessage]]);
    expect(hoisted.reload).not.toHaveBeenCalled();
  });

  it('does not overwrite a reopened map message with an older realtime response', async () => {
    const currentMessage = inboxMessage({ text: 'map current' });
    const reopenedMessage = inboxMessage({ text: 'map reopened' });
    const staleMessage = inboxMessage({ text: 'map stale refresh' });
    hoisted.mapOpenMessages = [[2, currentMessage]];
    let resolveRefresh: ((messages: Array<[number, InboxMessage]>) => void) | undefined;
    const refresh = new Promise<Array<[number, InboxMessage]>>((resolve) => {
      resolveRefresh = resolve;
    });
    hoisted.fetchMessagesByIds.mockReturnValueOnce(refresh);

    renderHook();
    let refreshEvent: Promise<void> | undefined;
    await act(async () => {
      refreshEvent = hoisted.onInboxChangedMessageIds([2]);
      await vi.waitFor(() => expect(hoisted.fetchMessagesByIds).toHaveBeenCalledOnce());
    });
    act(() => {
      hoisted.mapMessagesLoadVersionRef.current += 1;
      hoisted.setMapOpenMessages?.([[2, reopenedMessage]]);
    });
    await act(async () => {
      resolveRefresh?.([[2, staleMessage]]);
      await refreshEvent;
    });

    expect(latest?.mapAttrs.messages).toEqual([[2, reopenedMessage]]);
    expect(hoisted.reload).not.toHaveBeenCalled();
  });

  it('refreshes a list-visible id after it passes server-only filters', async () => {
    const currentMessage = inboxMessage({ text: 'needle current' });
    const updatedMessage = inboxMessage({ text: 'needle updated' });
    hoisted.messages = [[1, currentMessage]];
    hoisted.fetchMessageIdsMatchingFilters.mockResolvedValueOnce([[1, updatedMessage]]);

    renderHook({ search: 'needle' });
    await act(async () => {
      await hoisted.onInboxChangedMessageIds([1]);
    });

    expect(hoisted.fetchMessageIdsMatchingFilters).toHaveBeenCalledWith(
      [1],
      expect.objectContaining({ search: 'needle' }),
    );
    expect(hoisted.fetchMessagesByIds).not.toHaveBeenCalled();
    expect(latest?.messages).toEqual([[1, updatedMessage]]);
    expect(hoisted.loadMissingNetworksForMessages).toHaveBeenCalledWith([[1, updatedMessage]]);
    expect(hoisted.loadMessageComments).toHaveBeenCalledWith([[1, updatedMessage]], true);
    expect(hoisted.refreshMessageCounts).toHaveBeenCalledTimes(1);
    expect(hoisted.reload).not.toHaveBeenCalled();
  });

  it('trusts exact server matching for tag filters combined with OR-important', async () => {
    const currentMessage = inboxMessage({
      text: 'current',
      date: '16.01.2026',
      time: '11:00:00',
      tags: [7],
    });
    const updatedMessage = inboxMessage({
      text: 'updated',
      date: '16.01.2026',
      time: '12:00:00',
      important: true,
      tags: [],
    });
    hoisted.messages = [[1, currentMessage]];
    hoisted.fetchMessageIdsMatchingFilters.mockResolvedValueOnce([[1, updatedMessage]]);

    renderHook({
      fromDateTimeStr: '2026-01-16T00:00',
      toDateTimeStr: '2026-01-17T00:00',
      tags: [7],
      orImportant: true,
    });
    await act(async () => {
      await hoisted.onInboxChangedMessageIds([1]);
    });

    expect(hoisted.fetchMessageIdsMatchingFilters).toHaveBeenCalledWith(
      [1],
      expect.objectContaining({ selectedTags: [7], orImportant: true }),
    );
    expect(hoisted.fetchMessagesByIds).not.toHaveBeenCalled();
    expect(latest?.messages).toEqual([[1, updatedMessage]]);
    expect(hoisted.reload).not.toHaveBeenCalled();
  });

  it('removes a visible id rejected by the active device filter', async () => {
    const currentMessage = inboxMessage({ text: 'current', deviceName: 'device-1' });
    const updatedMessage = inboxMessage({ text: 'updated', deviceName: 'device-2' });
    hoisted.messages = [[1, currentMessage]];
    hoisted.fetchMessagesByIds.mockResolvedValueOnce([[1, updatedMessage]]);

    renderHook({
      deviceNamesSelected: ['device-1'],
      fromDateTimeStr: '2026-01-01T00:00',
      toDateTimeStr: '2026-01-02T00:00',
    });
    await act(async () => {
      await hoisted.onInboxChangedMessageIds([1]);
    });

    expect(hoisted.fetchMessageIdsMatchingFilters).toHaveBeenCalledWith(
      [1],
      expect.objectContaining({ selectedDeviceNames: ['device-1'] }),
    );
    expect(hoisted.fetchMessagesByIds).not.toHaveBeenCalled();
    expect(latest?.messages).toEqual([]);
    expect(hoisted.refreshMessageCounts).toHaveBeenCalledTimes(1);
    expect(hoisted.reload).not.toHaveBeenCalled();
  });

  it('removes a map-only visible id rejected by server-only filters', async () => {
    hoisted.mapOpenMessages = [[2, inboxMessage({ text: 'needle map-current' })]];
    hoisted.fetchMessageIdsMatchingFilters.mockResolvedValueOnce([]);

    renderHook({ search: 'needle' });
    await act(async () => {
      await hoisted.onInboxChangedMessageIds([2]);
    });

    expect(hoisted.fetchMessageIdsMatchingFilters).toHaveBeenCalledWith(
      [2],
      expect.objectContaining({ search: 'needle' }),
    );
    expect(hoisted.fetchMessagesByIds).not.toHaveBeenCalled();
    expect(latest?.mapAttrs.messages).toEqual([]);
    expect(hoisted.loadMissingNetworksForMessages).not.toHaveBeenCalled();
    expect(hoisted.loadMessageComments).not.toHaveBeenCalled();
    expect(hoisted.refreshMessageCounts).toHaveBeenCalledTimes(1);
    expect(hoisted.reload).not.toHaveBeenCalled();
  });

  it('filters a mixed batch before removing visible nonmatches and inserting unseen matches', async () => {
    const currentMessage = inboxMessage({ text: 'current' });
    const newMessage = inboxMessage({ text: 'needle new' });
    hoisted.messages = [[1, currentMessage]];
    hoisted.fetchMessageIdsMatchingFilters.mockResolvedValueOnce([[9, newMessage]]);

    renderHook({ search: 'needle' });
    await act(async () => {
      await hoisted.onInboxChangedMessageIds([9, 1, 10]);
    });

    expect(hoisted.fetchMessageIdsMatchingFilters).toHaveBeenCalledWith(
      [9, 1, 10],
      expect.objectContaining({ search: 'needle' }),
    );
    expect(hoisted.fetchMessagesByIds).not.toHaveBeenCalled();
    expect(latest?.messages).toEqual([[9, newMessage]]);
    expect(hoisted.loadMissingNetworksForMessages).toHaveBeenCalledWith([[9, newMessage]]);
    expect(hoisted.loadMessageComments).toHaveBeenCalledWith([[9, newMessage]], true);
    expect(hoisted.refreshMessageCounts).toHaveBeenCalledTimes(1);
    expect(hoisted.reload).not.toHaveBeenCalled();
  });

  it('deduplicates ordinary unseen ids before checking their visibility', async () => {
    hoisted.fetchMessageIdsMatchingFilters.mockResolvedValueOnce([]);

    renderHook();
    await act(async () => {
      await hoisted.onInboxChangedMessageIds([1, 2, 1, 3, 2]);
    });

    expect(hoisted.reload).not.toHaveBeenCalled();
    expect(hoisted.fetchMessageIdsMatchingFilters).toHaveBeenCalledWith(
      [1, 2, 3],
      expect.objectContaining({ highlightPoints: true }),
    );
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
