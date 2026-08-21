import { useCallback, useMemo, useRef, useState } from 'react';

import type { InboxMessage, InboxMessagesReq, InboxMessageTag } from '../../../../Bindings';
import { fetchMessagesByIds } from '../../services/api/analysis';
import { combineDateTimeInputToMs, combineDateTimeToMs } from '../../utils/misc';
import { buildInboxReq, queryStateReloadKey } from './helpers';
import { useAnalysisFilterSections } from './use-analysis-data-filter-sections';
import { useLoadMissingNetworksForMessages } from './use-analysis-data.support';
import { useAnalysisReferenceState } from './use-analysis-reference-state';
import { useAnalysisMessageList } from './use-analysis-message-list';
import { useAnalysisMapData } from './use-analysis-map-data';
import { useAnalysisSidebarData } from './use-analysis-sidebar-data';
import { useAnalysisReloadOrchestrator } from './use-analysis-reload-orchestrator';
import { useAnalysisActions } from './use-analysis-actions';
import { toErrorMessage } from './use-analysis-data.shared';
import {
  buildAnalysisActionsParams,
  buildReloadOrchestratorParams,
} from './use-analysis-data.wiring';
import type { AnalysisQueryState, AnalysisReloadOptions } from './types';
import type { UseAnalysisDataProps, UseAnalysisDataResult } from './use-analysis-data.types';
import {
  useInboxChangedMessageIds,
  type InboxChangedEvent,
} from '../shared/useInboxChangedMessageIds';
import { useLocalInboxChangeOrigins } from './use-local-inbox-change-origins';
import { useTargetedInboxReconciliation } from './use-targeted-inbox-reconciliation';

export { mergeNetworksById, shouldSkipNewCallsignsLoad } from './use-analysis-data.support';

function normalizeMessageIds(messageIds: readonly unknown[]): number[] {
  return Array.from(
    new Set(messageIds.filter((messageId): messageId is number => Number.isInteger(messageId))),
  );
}

function relatedMessageIds(message: InboxMessage): number[] {
  return [
    ...(message.parentMessages ?? []).map(({ id }) => id),
    ...(message.intelligenceReports ?? []).map(({ id }) => id),
  ];
}

function collectVisibleInboxEventIds(
  messages: Array<[number, InboxMessage]>,
  mapOpenMessages: Array<[number, InboxMessage]>,
): Set<number> {
  return new Set(
    [...messages, ...mapOpenMessages].flatMap(([messageId, message]) => [
      messageId,
      ...relatedMessageIds(message),
    ]),
  );
}

function collectVisibleChangedMessageIds(
  changedMessageIds: readonly unknown[],
  messages: Array<[number, InboxMessage]>,
  mapOpenMessages: Array<[number, InboxMessage]>,
): number[] {
  const changedIds = new Set(normalizeMessageIds(changedMessageIds));
  return normalizeMessageIds(
    [...messages, ...mapOpenMessages]
      .filter(
        ([messageId, message]) =>
          changedIds.has(messageId) ||
          relatedMessageIds(message).some((relatedMessageId) => changedIds.has(relatedMessageId)),
      )
      .map(([messageId]) => messageId),
  );
}

function tagIdsFromInboxTags(inboxTags: InboxMessageTag[]): number[] {
  const tagIds: number[] = [];
  for (const inboxTag of inboxTags) {
    if (!tagIds.includes(inboxTag.tagId)) tagIds.push(inboxTag.tagId);
  }
  return tagIds;
}

function applyModelTagFilter(message: InboxMessage, withoutModelTags: boolean): InboxMessage {
  if (!withoutModelTags || message.inboxTags == null) return message;

  const inboxTags = message.inboxTags.filter((inboxTag) => inboxTag.model == null);
  return {
    ...message,
    inboxTags,
    tags: tagIdsFromInboxTags(inboxTags),
  };
}

function expandSelectedFreqs(queryState: AnalysisQueryState, allFrequencies: string[]): string[] {
  if (queryState.adjacentFreqsRange <= 0 || queryState.freqsSelected.length === 0) {
    return queryState.freqsSelected;
  }

  return Array.from(
    new Set([
      ...queryState.freqsSelected,
      ...allFrequencies.filter((freq) => {
        if (queryState.freqsSelected.includes(freq)) return false;

        const freqNumber = parseFloat(freq);
        if (Number.isNaN(freqNumber)) return false;

        return queryState.freqsSelected.some((selectedFreq) => {
          const selectedFreqNumber = parseFloat(selectedFreq);
          if (Number.isNaN(selectedFreqNumber)) return false;
          return (
            freqNumber >= selectedFreqNumber - queryState.adjacentFreqsRange &&
            freqNumber <= selectedFreqNumber + queryState.adjacentFreqsRange
          );
        });
      }),
    ]),
  );
}

function messageMatchesSelectedFreqs(
  message: InboxMessage,
  selectedFreqs: readonly string[],
): boolean {
  if (selectedFreqs.length === 0) return true;

  return selectedFreqs.includes(message.freq ?? '');
}

function messageTagIds(message: InboxMessage): number[] {
  if (message.inboxTags != null && message.inboxTags.length > 0) {
    return tagIdsFromInboxTags(message.inboxTags);
  }
  return message.tags ?? [];
}

function messageMatchesSelectedTags(
  message: InboxMessage,
  queryState: AnalysisQueryState,
): boolean {
  if (queryState.tags.length === 0) return true;

  const tagIds = messageTagIds(message);
  const hasTag = (tagId: number) => tagIds.includes(tagId);

  if (queryState.tagsExcludeMode) return !queryState.tags.some(hasTag);
  if (queryState.filterTagsOption === 'AllTags') return queryState.tags.every(hasTag);
  return queryState.tags.some(hasTag);
}

function getClientCheckableDateRange(
  queryState: AnalysisQueryState,
): { sinceDateInclusiveMs: number; tillDateNoninclusiveMs: number } | null | undefined {
  const hasFromDate = hasSearchText(queryState.fromDateTimeStr);
  const hasToDate = hasSearchText(queryState.toDateTimeStr);
  if (!hasFromDate && !hasToDate) return null;
  if (!hasFromDate || !hasToDate) return undefined;

  const sinceDateInclusiveMs = combineDateTimeInputToMs(queryState.fromDateTimeStr);
  const tillDateNoninclusiveMs = combineDateTimeInputToMs(queryState.toDateTimeStr);
  if (
    sinceDateInclusiveMs == null ||
    tillDateNoninclusiveMs == null ||
    sinceDateInclusiveMs > tillDateNoninclusiveMs
  ) {
    return undefined;
  }

  return { sinceDateInclusiveMs, tillDateNoninclusiveMs };
}

function messageInboxDateTimeMs(message: InboxMessage): number | null {
  if (message.date == null || message.time == null) return null;

  const timeMatch = message.time.match(/^(\d{2}:\d{2})(?::(\d{2}))?$/);
  if (timeMatch == null) return null;

  const baseMs = combineDateTimeToMs(message.date, timeMatch[1]);
  if (baseMs == null) return null;

  const seconds = timeMatch[2] == null ? 0 : Number(timeMatch[2]);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 59) return null;

  return baseMs + seconds * 1000;
}

function messageMatchesDateRange(message: InboxMessage, queryState: AnalysisQueryState): boolean {
  const dateRange = getClientCheckableDateRange(queryState);
  if (dateRange === null) return true;
  if (dateRange === undefined) return false;
  const inboxDateTimeMs = messageInboxDateTimeMs(message);
  if (inboxDateTimeMs == null) return false;

  return (
    inboxDateTimeMs >= dateRange.sinceDateInclusiveMs &&
    inboxDateTimeMs <= dateRange.tillDateNoninclusiveMs
  );
}

function buildLiveRefreshInboxReq(
  queryState: AnalysisQueryState,
  allFrequencies: string[],
): Partial<InboxMessagesReq> {
  const inboxReq = buildInboxReq(queryState, allFrequencies);
  if (inboxReq != null) return inboxReq;

  return {
    highlightCallsigns: true,
    highlightKeywords: true,
    highlightKeywordSetId: null,
    highlightSearchres: true,
    highlightSignals: null,
    highlightPoints: true,
    search: hasSearchText(queryState.search) ? queryState.search.trim() : null,
    withoutModelTags: queryState.withoutModelTags,
  };
}

function messageMatchesLiveRefreshFilters(
  message: InboxMessage,
  queryState: AnalysisQueryState,
  allFrequencies: string[],
): boolean {
  return (
    messageMatchesDateRange(message, queryState) &&
    messageMatchesSelectedFreqs(message, expandSelectedFreqs(queryState, allFrequencies)) &&
    messageMatchesSelectedTags(message, queryState)
  );
}

function hasSelectedValues(values: readonly unknown[]): boolean {
  return values.length > 0;
}

function hasSearchText(value: string): boolean {
  return value.trim() !== '';
}

function requiresServerFilteredInboxRefresh(queryState: AnalysisQueryState): boolean {
  return (
    getClientCheckableDateRange(queryState) === undefined ||
    queryState.includeOnlyNewFreqs ||
    hasSelectedValues(queryState.aorsSelected) ||
    hasSelectedValues(queryState.groupsSelected) ||
    hasSelectedValues(queryState.sendersSelected) ||
    hasSelectedValues(queryState.callsignsSelected) ||
    hasSelectedValues(queryState.unitsSelected) ||
    hasSelectedValues(queryState.locationsSelected) ||
    hasSelectedValues(queryState.postsSelected) ||
    hasSelectedValues(queryState.networksSelected) ||
    queryState.withoutNetwork ||
    queryState.orWithExtendedForm ||
    queryState.orBookmarked ||
    queryState.orImportant ||
    queryState.orWithCoords ||
    queryState.orWithoutCoords ||
    hasSearchText(queryState.search) ||
    hasSelectedValues(queryState.metadataCc) ||
    hasSelectedValues(queryState.metadataSender) ||
    hasSelectedValues(queryState.metadataReceiver) ||
    hasSelectedValues(queryState.metadataHash) ||
    queryState.onlyWithMetadata ||
    queryState.withoutMetadata ||
    queryState.reportTagsOnlyThisUnit ||
    queryState.onlyWithMedia
  );
}

function mergeRefreshedMessage(
  refreshedMessage: InboxMessage,
  withoutModelTags: boolean,
): InboxMessage {
  return applyModelTagFilter(refreshedMessage, withoutModelTags);
}

function mergeRefreshedMessages(
  currentMessages: Array<[number, InboxMessage]>,
  changedMessageIds: ReadonlySet<number>,
  refreshedMessages: Map<number, InboxMessage>,
  withoutModelTags: boolean,
  shouldKeepRefreshedMessage: (message: InboxMessage) => boolean,
): Array<[number, InboxMessage]> {
  const nextMessages: Array<[number, InboxMessage]> = [];
  for (const [messageId, currentMessage] of currentMessages) {
    const refreshedMessage = refreshedMessages.get(messageId);
    if (refreshedMessage == null) {
      if (!changedMessageIds.has(messageId)) nextMessages.push([messageId, currentMessage]);
    } else {
      const nextMessage = mergeRefreshedMessage(refreshedMessage, withoutModelTags);
      if (shouldKeepRefreshedMessage(nextMessage)) nextMessages.push([messageId, nextMessage]);
    }
  }
  return nextMessages;
}

export function useAnalysisData({
  authUserName,
  currentUser,
  deferInitialLoad = false,
  centerTab,
  leftPanelOpen = true,
  newestFirst,
  onError,
  onUnauthorized,
  queryState,
  rightSidebarVisible,
  rightSidebarTab,
  shouldLoadNewCallsigns,
}: UseAnalysisDataProps): UseAnalysisDataResult {
  const referenceState = useAnalysisReferenceState({ shouldLoadNewCallsigns });
  const optionsFreqValues = useMemo(
    () => referenceState.options.freqs.map((option) => option.value),
    [referenceState.options.freqs],
  );
  const reloadTriggerKey = useMemo(
    () =>
      `${queryStateReloadKey(queryState, optionsFreqValues) ?? 'invalid'}|${newestFirst ? 'desc' : 'asc'}|media=${queryState.onlyWithMedia ? 1 : 0}`,
    [newestFirst, optionsFreqValues, queryState],
  );
  const [filtersLoading, setFiltersLoading] = useState(false);
  const [countsLoading, setCountsLoading] = useState(false);
  const reloadRef = useRef<(options?: AnalysisReloadOptions) => Promise<void>>(
    async () => undefined,
  );
  const localInboxChangeOrigins = useLocalInboxChangeOrigins();

  const loadMissingNetworksForMessages = useLoadMissingNetworksForMessages({
    networksRef: referenceState.networksRef,
    onError,
    onUnauthorized,
    setNetworkDisplayMap: referenceState.setNetworkDisplayMap,
    setNetworks: referenceState.setNetworks,
    unitsMap: referenceState.unitsMap,
  });

  const messageList = useAnalysisMessageList({
    deferInitialLoad,
    loadMissingNetworksForMessages,
    newestFirst,
    onError,
    onUnauthorized,
    optionsFreqValues,
    queryState,
    setSummaryCallsignsInfo: referenceState.setSummaryCallsignsInfo,
  });

  const {
    filterSectionLoadStates,
    isFilterSectionEmptyLoading,
    isFilterSectionLoading,
    isFilterSectionStale,
    getLoadedFilterSections,
    getReloadFilterSections,
    invalidateFilterSectionLoads,
    invalidateFilterSectionLoadsForPatch,
    loadFilterSection,
    loadInitialFilterSections,
    refreshTagFacet,
  } = useAnalysisFilterSections({
    queryState,
    optionsFreqValues,
    unitsMapRef: referenceState.unitsMapRef,
    onError,
    onUnauthorized,
    setAorEntries: messageList.setAorEntries,
    setGroupInfos: referenceState.setGroupInfos,
    setNetworks: referenceState.setNetworks,
    setOptions: referenceState.setOptions,
    setProfiles: referenceState.setProfiles,
    setTagsMap: referenceState.setTagsMap,
    setTagsOrder: referenceState.setTagsOrder,
  });

  const mapData = useAnalysisMapData({
    canShowSettlements: currentUser?.roles.includes('Admin') ?? false,
    loadMissingNetworksForMessages,
    newestFirst,
    onError,
    onUnauthorized,
    optionsFreqValues,
    queryState,
  });

  const sidebarData = useAnalysisSidebarData({
    onError,
    onUnauthorized,
    optionsFreqValues,
    queryState,
    summaryCallsignsInfoRef: referenceState.summaryCallsignsInfoRef,
    setSummaryCallsignsInfo: referenceState.setSummaryCallsignsInfo,
  });

  const reconcileVisibleChangedMessagesBatch = useCallback(
    async (
      changedMessageIds: number[],
      shouldApply: (messageId: number) => boolean,
      signal: AbortSignal,
    ) => {
      const messageIds = collectVisibleChangedMessageIds(
        changedMessageIds,
        messageList.messages,
        mapData.mapOpenMessages,
      );
      if (messageIds.length === 0) return;

      try {
        const refreshedMessageItems = await fetchMessagesByIds(
          messageIds,
          buildLiveRefreshInboxReq(queryState, optionsFreqValues),
          { signal },
        );
        const applicableMessageIds = messageIds.filter(shouldApply);
        if (applicableMessageIds.length === 0) return;
        const refreshedMessages = new Map(
          refreshedMessageItems
            .filter(([messageId]) => shouldApply(messageId))
            .map(([id, message]) => [id, message]),
        );
        const changedMessageIdSet = new Set(applicableMessageIds);
        const shouldKeepRefreshedMessage = (message: InboxMessage) =>
          messageMatchesLiveRefreshFilters(message, queryState, optionsFreqValues);
        messageList.setMessages((currentMessages) =>
          mergeRefreshedMessages(
            currentMessages,
            changedMessageIdSet,
            refreshedMessages,
            queryState.withoutModelTags,
            shouldKeepRefreshedMessage,
          ),
        );
        mapData.setMapOpenMessages((currentMessages) =>
          mergeRefreshedMessages(
            currentMessages,
            changedMessageIdSet,
            refreshedMessages,
            queryState.withoutModelTags,
            shouldKeepRefreshedMessage,
          ),
        );
        const keptRefreshedMessageItems = refreshedMessageItems.filter(
          ([messageId, message]) =>
            shouldApply(messageId) &&
            shouldKeepRefreshedMessage(applyModelTagFilter(message, queryState.withoutModelTags)),
        );
        if (signal.aborted) return;
        await loadMissingNetworksForMessages(keptRefreshedMessageItems);
        if (signal.aborted) return;
        await messageList.loadMessageComments(keptRefreshedMessageItems, true);
      } catch (loadError) {
        if (signal.aborted) return;
        if (!onUnauthorized(loadError)) onError(toErrorMessage(loadError));
      }
    },
    [
      loadMissingNetworksForMessages,
      mapData,
      messageList,
      onError,
      onUnauthorized,
      optionsFreqValues,
      queryState,
    ],
  );
  const refreshVisibleChangedMessagesTargeted = useTargetedInboxReconciliation(
    reconcileVisibleChangedMessagesBatch,
  );

  const refreshVisibleChangedMessages = useCallback(
    async (changedMessageIds: number[], events: InboxChangedEvent[] = []) => {
      const visibleMessageIds = collectVisibleChangedMessageIds(
        changedMessageIds,
        messageList.messages,
        mapData.mapOpenMessages,
      );
      const visibleInboxEventIds = collectVisibleInboxEventIds(
        messageList.messages,
        mapData.mapOpenMessages,
      );
      const undisplayedReportIds = events
        .filter((event) => event.intelligenceReport && !visibleInboxEventIds.has(event.messageId))
        .map((event) => event.messageId);

      if (visibleMessageIds.length > 0) {
        if (requiresServerFilteredInboxRefresh(queryState)) {
          try {
            await reloadRef.current();
          } catch (loadError) {
            if (!onUnauthorized(loadError)) onError(toErrorMessage(loadError));
          }
          return;
        }

        await refreshVisibleChangedMessagesTargeted(visibleMessageIds);
      }

      if (undisplayedReportIds.length === 0) return;

      try {
        const discoveredReports = await fetchMessagesByIds(
          undisplayedReportIds,
          buildLiveRefreshInboxReq(queryState, optionsFreqValues),
        );
        const shouldReload = requiresServerFilteredInboxRefresh(queryState)
          ? discoveredReports.length > 0
          : discoveredReports.some(([, message]) =>
              messageMatchesLiveRefreshFilters(message, queryState, optionsFreqValues),
            );
        if (shouldReload) await reloadRef.current();
      } catch (loadError) {
        if (!onUnauthorized(loadError)) onError(toErrorMessage(loadError));
      }
    },
    [
      mapData.mapOpenMessages,
      messageList.messages,
      onError,
      onUnauthorized,
      optionsFreqValues,
      queryState,
      refreshVisibleChangedMessagesTargeted,
    ],
  );

  const { clearAnalysisResults, onUpdateLocalMessage, messageActionState } = useAnalysisActions(
    buildAnalysisActionsParams({
      authUserName,
      currentUser,
      optionsFreqValues,
      onError,
      onUnauthorized,
      queryState,
      completeLocalInboxChangeOrigin: localInboxChangeOrigins.completeOrigin,
      failLocalInboxChangeOrigin: localInboxChangeOrigins.failOrigin,
      reconcileTagMutation: (messageId) => refreshVisibleChangedMessagesTargeted([messageId]),
      registerLocalInboxChangeOrigin: localInboxChangeOrigins.registerOrigin,
      refreshTagFacet,
      reloadRef,
      referenceState,
      messageList,
      mapData,
      sidebarData,
    }),
  );

  const { reload } = useAnalysisReloadOrchestrator(
    buildReloadOrchestratorParams({
      centerTab,
      deferInitialLoad,
      leftPanelOpen,
      newestFirst,
      onError,
      onUnauthorized,
      queryState,
      rightSidebarTab,
      rightSidebarVisible,
      reloadTriggerKey,
      shouldLoadNewCallsigns: referenceState.shouldLoadNewCallsignsRef.current,
      optionsFreqValuesRef: referenceState.optionsFreqsRef,
      getLoadedFilterSections,
      getReloadFilterSections,
      invalidateFilterSectionLoads,
      invalidateFilterSectionLoadsForPatch,
      loadInitialFilterSections,
      invalidateCallsignGraph: sidebarData.invalidateCallsignGraph,
      invalidateCorrelatedFreqsCache: sidebarData.invalidateCorrelatedFreqsCache,
      invalidateRightSidebarData: sidebarData.invalidateRightSidebarData,
      invalidateSummaryData: sidebarData.invalidateSummaryData,
      loadMapPalitras: mapData.loadMapPalitras,
      loadSummaryData: sidebarData.loadSummaryData,
      loadTopSidebarData: sidebarData.loadTopSidebarData,
      clearAnalysisResults,
      loadMessageComments: messageList.loadMessageComments,
      invalidateMessagePaging: messageList.invalidateMessagePaging,
      invalidateMessagePageRequests: messageList.invalidateMessagePageRequests,
      getCurrentMessagePageCursor: messageList.getCurrentMessagePageCursor,
      refreshMessageCounts: messageList.refreshMessageCounts,
      setAorEntries: messageList.setAorEntries,
      setCounts: messageList.setCounts,
      setCountsLoading,
      setFiltersLoading,
      setGroupInfos: referenceState.setGroupInfos,
      setMapLoading: mapData.setMapLoading,
      setMapDateRange: mapData.setMapDateRange,
      setMapNetworkUnits: mapData.setMapNetworkUnits,
      applyMapSettlements: mapData.applyMapSettlements,
      setMapOpenMessages: mapData.setMapOpenMessages,
      setMapPoints: mapData.setMapPoints,
      showSettlements: mapData.showSettlements,
      setMessages: messageList.setMessages,
      setMessagesLoading: messageList.setMessagesLoading,
      setNetworks: referenceState.setNetworks,
      setNewCallsigns: sidebarData.setNewCallsigns,
      setNewCallsignsLoading: sidebarData.setNewCallsignsLoading,
      setNewCallsignsLoadedKey: sidebarData.setNewCallsignsLoadedKey,
      newCallsignsRequestRef: sidebarData.newCallsignsRequestRef,
      newCallsignsLoadedKeyRef: sidebarData.newCallsignsLoadedKeyRef,
      newCallsignsPendingKeyRef: sidebarData.newCallsignsPendingKeyRef,
      setNoMoreToLoad: messageList.setNoMoreToLoad,
      setNolimitShown: messageList.setNolimitShown,
      setOptions: referenceState.setOptions,
      setProfiles: referenceState.setProfiles,
      setSummaryCallsignsInfo: referenceState.setSummaryCallsignsInfo,
      setTagsMap: referenceState.setTagsMap,
      setTagsOrder: referenceState.setTagsOrder,
      setTopCallsigns: sidebarData.setTopCallsigns,
      setTopFreqs: sidebarData.setTopFreqs,
      setTopLocations: sidebarData.setTopLocations,
      setTopUnits: sidebarData.setTopUnits,
      setUnitsMap: referenceState.setUnitsMap,
      setHasLoadedInitialMessages: messageList.setHasLoadedInitialMessages,
    }),
  );

  useInboxChangedMessageIds({
    ignoreEvent: (event) => {
      if (event.origin == null) return false;
      const disposition = localInboxChangeOrigins.classifyOrigin(event.origin);
      if (disposition === 'reconcile') {
        void refreshVisibleChangedMessagesTargeted([event.messageId]);
      }
      return disposition !== 'unmatched';
    },
    onMessageIds: refreshVisibleChangedMessages,
  });

  reloadRef.current = reload;

  return {
    callsignGraph: sidebarData.callsignGraph,
    callsignGraphLoading: sidebarData.callsignGraphLoading,
    callsignGraphLoadVersion: sidebarData.callsignGraphLoadVersion,
    callsignGraphLoadError: sidebarData.callsignGraphLoadError,
    correlatedFreqs: sidebarData.correlatedFreqs,
    correlatedFreqsLoaded: sidebarData.correlatedFreqsLoaded,
    correlatedFreqsLoading: sidebarData.correlatedFreqsLoading,
    counts: messageList.counts,
    countsLoading,
    aorEntries: messageList.aorEntries,
    filtersLoading,
    filterSectionLoadStates,
    isFilterSectionLoading,
    isFilterSectionEmptyLoading,
    isFilterSectionStale,
    groupsActivityPeriod: sidebarData.groupsActivityPeriod,
    downloadGeojson: sidebarData.downloadGeojson,
    downloadKmz: sidebarData.downloadKmz,
    downloadSummaryXlsx: sidebarData.downloadSummaryXlsx,
    groupsActivity: sidebarData.groupsActivity,
    groupsActivityLoadedFreq: sidebarData.groupsActivityLoadedFreq,
    groupsActivityLoadedPeriod: sidebarData.groupsActivityLoadedPeriod,
    groupsActivityLoading: sidebarData.groupsActivityLoading,
    hasLoadedInitialMessages: messageList.hasLoadedInitialMessages,
    // Exposed for map/report flows; `onlyWithMedia` is message-list-only and is applied at message fetch call sites.
    inboxReq: buildInboxReq(queryState, optionsFreqValues),
    botTagAction: messageActionState.botTagAction,
    loadCallsignGraph: sidebarData.loadCallsignGraph,
    loadAllMessages: messageList.loadAllMessages,
    loadFilterSection,
    invalidateFilterSectionLoads,
    invalidateFilterSectionLoadsForPatch,
    getReloadFilterSections,
    loadCorrelatedFreqs: sidebarData.loadCorrelatedFreqs,
    loadGroupsActivity: sidebarData.loadGroupsActivity,
    loadNewCallsigns: sidebarData.loadNewCallsigns,
    loadFirstPage: messageList.loadFirstPage,
    loadLastPage: messageList.loadLastPage,
    loadNextPage: messageList.loadNextPage,
    loadMoreMessages: messageList.loadMoreMessages,
    loadPrevPage: messageList.loadPrevPage,
    loadMessagesForMap: mapData.loadMessagesForMap,
    mapAttrs: mapData.mapAttrs,
    messageActionLoading: messageActionState.messageActionCount > 0,
    messagesLoading: messageList.messagesLoading,
    messagesPaging: messageList.messagesPaging,
    messageComments: messageList.messageComments,
    messages: messageList.messages,
    messagesOverallCount: messageList.messagesOverallCount,
    messagesTotalCount: messageList.messagesTotalCount,
    messagesTotalLoading: messageList.messagesTotalLoading,
    networkDisplayMap: referenceState.networkDisplayMap,
    networks: referenceState.networks,
    newCallsigns: sidebarData.newCallsigns,
    newCallsignsLoading: sidebarData.newCallsignsLoading,
    noMoreToLoad: messageList.noMoreToLoad,
    nolimitShown: messageList.nolimitShown,
    pageIndex: messageList.pageIndex,
    onPrependLocalMessage: useCallback(
      (messageId: number, message: InboxMessage) => {
        messageList.setMessages((current) => [[messageId, message], ...current]);
      },
      [messageList.setMessages],
    ),
    onUpdateLocalMessage,
    onDeleteMessage: messageActionState.onDeleteMessage,
    onCancelBotTagAction: messageActionState.onCancelBotTagAction,
    onMarkBotTagWrong: messageActionState.onMarkBotTagWrong,
    onToggleMessageBookmark: messageActionState.onToggleMessageBookmark,
    onToggleMessageImportant: messageActionState.onToggleMessageImportant,
    onToggleMessageTag: messageActionState.onToggleMessageTag,
    onAddPointHighlightBlacklist: messageActionState.onAddPointHighlightBlacklist,
    options: referenceState.options,
    profiles: referenceState.profiles,
    refreshMapDateRange: mapData.refreshMapDateRange,
    setShowSettlements: mapData.setShowSettlements,
    reload,
    summaryLoading: sidebarData.summaryLoading,
    summaryLoaded: sidebarData.summaryLoaded,
    summaryHasLoadedOnce: sidebarData.summaryHasLoadedOnce,
    rightSidebarLoading: sidebarData.rightSidebarLoading,
    summaryRows: sidebarData.summaryRows,
    summaryCallsignsInfo: referenceState.summaryCallsignsInfo,
    unitsMap: referenceState.unitsMap,
    tagsMap: referenceState.tagsMap,
    tagsOrder: referenceState.tagsOrder,
    topCallsigns: sidebarData.topCallsigns,
    topFreqs: sidebarData.topFreqs,
    groupInfos: referenceState.groupInfos,
    topLocations: sidebarData.topLocations,
    topUnits: sidebarData.topUnits,
    renameSummaryUnit: messageActionState.renameSummaryUnit,
  };
}
