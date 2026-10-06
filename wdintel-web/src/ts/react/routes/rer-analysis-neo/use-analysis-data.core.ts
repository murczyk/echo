import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { InboxMessage, InboxMessagesReq, InboxMessageTag } from '../../../../Bindings';
import { fetchMessageIdsMatchingFilters, fetchMessagesByIds } from '../../services/api/analysis';
import { combineDateTimeInputToMs, combineDateTimeToMs } from '../../utils/misc';
import { buildInboxReq, getFirstLoadedMessagesPageIndex, queryStateReloadKey } from './helpers';
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

function messageInboxDateTimeMs(
  message: InboxMessage,
  messageTimeBasis: AnalysisQueryState['messageTimeBasis'],
): number | null {
  if (messageTimeBasis === 'creation') {
    return message.createdAt != null && Number.isFinite(message.createdAt)
      ? message.createdAt
      : null;
  }
  if (message.date == null || message.time == null) return null;

  const timeMatch = message.time.match(/^(\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/);
  if (timeMatch == null) return null;

  const date = message.date.replace(/^(\d{2})\.(\d{2})\.(\d{4})$/, '$3-$2-$1');
  const baseMs = combineDateTimeToMs(date, timeMatch[1]);
  if (baseMs == null) return null;

  const seconds = timeMatch[2] == null ? 0 : Number(timeMatch[2]);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 59) return null;
  const fractionalMilliseconds = timeMatch[3] == null ? 0 : Number(`0.${timeMatch[3]}`) * 1000;

  return baseMs + seconds * 1000 + fractionalMilliseconds;
}

function messageMatchesDateRange(message: InboxMessage, queryState: AnalysisQueryState): boolean {
  const dateRange = getClientCheckableDateRange(queryState);
  if (dateRange === null) return true;
  if (dateRange === undefined) return false;
  const inboxDateTimeMs = messageInboxDateTimeMs(message, queryState.messageTimeBasis);
  if (inboxDateTimeMs == null) return false;

  return (
    inboxDateTimeMs >= dateRange.sinceDateInclusiveMs &&
    inboxDateTimeMs <= dateRange.tillDateNoninclusiveMs
  );
}

function hasActiveMapDateRange(dateRange: { startDate: number; endDate: number }): boolean {
  return dateRange.startDate > 0 && dateRange.endDate > 0;
}

function applyMapDateRangeToInboxReq(
  inboxReq: Partial<InboxMessagesReq>,
  dateRange: { startDate: number; endDate: number },
): Partial<InboxMessagesReq> {
  if (!hasActiveMapDateRange(dateRange)) return inboxReq;
  return {
    ...inboxReq,
    sinceDateInclusiveMs: dateRange.startDate,
    tillDateInclusiveMs: dateRange.endDate,
  };
}

function messageMatchesMapDateRange(
  message: InboxMessage,
  queryState: AnalysisQueryState,
  dateRange: { startDate: number; endDate: number },
): boolean {
  if (!hasActiveMapDateRange(dateRange)) return messageMatchesDateRange(message, queryState);
  const inboxDateTimeMs = messageInboxDateTimeMs(message, queryState.messageTimeBasis);
  return (
    inboxDateTimeMs != null &&
    inboxDateTimeMs >= dateRange.startDate &&
    inboxDateTimeMs <= dateRange.endDate
  );
}

function buildLiveRefreshInboxReq(
  queryState: AnalysisQueryState,
  allFrequencies: string[],
  includeOnlyWithMedia = true,
): Partial<InboxMessagesReq> {
  const inboxReq = buildInboxReq(queryState, allFrequencies, includeOnlyWithMedia);
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
    onlyWithMedia: includeOnlyWithMedia && queryState.onlyWithMedia,
  };
}

function messageMatchesLiveRefreshFilters(
  message: InboxMessage,
  queryState: AnalysisQueryState,
  allFrequencies: string[],
  mapDateRange?: { startDate: number; endDate: number },
): boolean {
  return (
    (mapDateRange == null
      ? messageMatchesDateRange(message, queryState)
      : messageMatchesMapDateRange(message, queryState, mapDateRange)) &&
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

function requiresServerFilteredInboxRefresh(
  queryState: AnalysisQueryState,
  includeOnlyWithMedia = true,
): boolean {
  return (
    getClientCheckableDateRange(queryState) === undefined ||
    queryState.includeOnlyNewFreqs ||
    hasSelectedValues(queryState.aorsSelected) ||
    hasSelectedValues(queryState.groupsSelected) ||
    hasSelectedValues(queryState.sendersSelected) ||
    hasSelectedValues(queryState.callsignsSelected) ||
    hasSelectedValues(queryState.unitsSelected) ||
    hasSelectedValues(queryState.deviceNamesSelected) ||
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
    (includeOnlyWithMedia && queryState.onlyWithMedia)
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
  shouldKeepRefreshedMessage: (messageId: number, message: InboxMessage) => boolean,
): Array<[number, InboxMessage]> {
  const nextMessages: Array<[number, InboxMessage]> = [];
  for (const [messageId, currentMessage] of currentMessages) {
    const refreshedMessage = refreshedMessages.get(messageId);
    if (refreshedMessage == null) {
      if (!changedMessageIds.has(messageId)) nextMessages.push([messageId, currentMessage]);
    } else {
      const nextMessage = mergeRefreshedMessage(refreshedMessage, withoutModelTags);
      if (shouldKeepRefreshedMessage(messageId, nextMessage)) {
        nextMessages.push([messageId, nextMessage]);
      }
    }
  }
  return nextMessages;
}

function messageRealtimeOrderValue(
  message: InboxMessage,
  messageTimeBasis: AnalysisQueryState['messageTimeBasis'],
): number | null {
  if (messageTimeBasis === 'creation') {
    if (message.createdAtOrder != null && Number.isFinite(message.createdAtOrder)) {
      return message.createdAtOrder;
    }
    return message.createdAt != null && Number.isFinite(message.createdAt)
      ? message.createdAt * 1000
      : null;
  }

  const dateTimeMs = messageInboxDateTimeMs(message, messageTimeBasis);
  if (dateTimeMs != null) return dateTimeMs;
  return message.timestamp != null && Number.isFinite(message.timestamp) ? message.timestamp : null;
}

function compareRealtimeMessageItems(
  [leftId, leftMessage]: [number, InboxMessage],
  [rightId, rightMessage]: [number, InboxMessage],
  messageTimeBasis: AnalysisQueryState['messageTimeBasis'],
  newestFirst: boolean,
): number {
  const leftOrder = messageRealtimeOrderValue(leftMessage, messageTimeBasis);
  const rightOrder = messageRealtimeOrderValue(rightMessage, messageTimeBasis);
  let comparison = 0;
  if (leftOrder == null && rightOrder != null) comparison = 1;
  else if (leftOrder != null && rightOrder == null) comparison = -1;
  else if (leftOrder != null && rightOrder != null) comparison = leftOrder - rightOrder;
  if (comparison === 0) comparison = leftId - rightId;
  return newestFirst ? -comparison : comparison;
}

function hasRealtimeMessageOrderChanged(
  currentMessage: InboxMessage,
  refreshedMessage: InboxMessage,
  messageTimeBasis: AnalysisQueryState['messageTimeBasis'],
): boolean {
  return (
    messageRealtimeOrderValue(currentMessage, messageTimeBasis) !==
    messageRealtimeOrderValue(refreshedMessage, messageTimeBasis)
  );
}

function canDiscoverUnseenMessages({
  focusedMessageActive,
  messages,
  newestFirst,
  noMoreToLoad,
  nolimitShown,
  pageIndex,
}: {
  focusedMessageActive: boolean;
  messages: Array<[number, InboxMessage]>;
  newestFirst: boolean;
  noMoreToLoad: boolean;
  nolimitShown: boolean;
  pageIndex: number;
}): boolean {
  if (focusedMessageActive) return false;
  if (nolimitShown) return true;
  if (!newestFirst) return noMoreToLoad;
  return getFirstLoadedMessagesPageIndex(pageIndex, messages.length) === 0;
}

function insertDiscoveredMessages(
  currentMessages: Array<[number, InboxMessage]>,
  discoveredMessages: Array<[number, InboxMessage]>,
  {
    messageTimeBasis,
    newestFirst,
    noMoreToLoad,
    nolimitShown,
    pageIndex,
    preserveMessageIds,
  }: {
    messageTimeBasis: AnalysisQueryState['messageTimeBasis'];
    newestFirst: boolean;
    noMoreToLoad: boolean;
    nolimitShown: boolean;
    pageIndex: number;
    preserveMessageIds?: ReadonlySet<number>;
  },
): Array<[number, InboxMessage]> {
  if (discoveredMessages.length === 0) return currentMessages;

  const nextMessages = [...currentMessages];
  const firstLoadedPageIndex = getFirstLoadedMessagesPageIndex(pageIndex, nextMessages.length);
  const compareItems = (left: [number, InboxMessage], right: [number, InboxMessage]): number =>
    compareRealtimeMessageItems(left, right, messageTimeBasis, newestFirst);

  [...discoveredMessages].sort(compareItems).forEach((messageItem) => {
    const preserveMessage = preserveMessageIds?.has(messageItem[0]) ?? false;
    const existingIndex = nextMessages.findIndex(([messageId]) => messageId === messageItem[0]);
    if (existingIndex >= 0) {
      nextMessages[existingIndex] = messageItem;
      return;
    }

    const orderedIndex = nextMessages.findIndex(
      (currentItem) => compareItems(messageItem, currentItem) < 0,
    );
    const insertionIndex = orderedIndex < 0 ? nextMessages.length : orderedIndex;
    if (nextMessages.length === 0) {
      if (preserveMessage || pageIndex === 0 || noMoreToLoad || nolimitShown) {
        nextMessages.push(messageItem);
      }
      return;
    }
    if (insertionIndex === 0 && firstLoadedPageIndex > 0 && !preserveMessage) return;
    if (
      insertionIndex === nextMessages.length &&
      !noMoreToLoad &&
      !nolimitShown &&
      !preserveMessage
    )
      return;
    nextMessages.splice(insertionIndex, 0, messageItem);
  });

  return nextMessages;
}

function sameMessageItems(
  left: Array<[number, InboxMessage]>,
  right: Array<[number, InboxMessage]>,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      ([messageId, message], index) =>
        right[index]?.[0] === messageId && right[index]?.[1] === message,
    )
  );
}

export function useAnalysisData({
  authUserName,
  currentUser,
  deferInitialLoad = false,
  focusedWindow = null,
  focusedMessageActive = false,
  centerTab,
  leftPanelOpen = true,
  newestFirst,
  onBeforeRealtimeMessageListChange,
  onError,
  onUnauthorized,
  queryState,
  rightSidebarVisible,
  rightSidebarTab,
  shouldLoadNewCallsigns,
}: UseAnalysisDataProps): UseAnalysisDataResult {
  const focusedMessage = useMemo(
    () =>
      focusedWindow?.inbox.inboxItems.find(
        ([messageId]) => messageId === focusedWindow.targetMessageId,
      ) ?? null,
    [focusedWindow],
  );
  const referenceState = useAnalysisReferenceState({ shouldLoadNewCallsigns });
  const optionsFreqValues = useMemo(
    () => referenceState.options.freqs.map((option) => option.value),
    [referenceState.options.freqs],
  );
  const reloadTriggerKey = useMemo(
    () =>
      `${queryStateReloadKey(queryState, optionsFreqValues) ?? 'invalid'}|${focusedMessageActive ? 'focused' : newestFirst ? 'desc' : 'asc'}|media=${queryState.onlyWithMedia ? 1 : 0}|focus=${focusedMessageActive ? (focusedMessage?.[0] ?? 'pending') : 'off'}`,
    [focusedMessage, focusedMessageActive, newestFirst, optionsFreqValues, queryState],
  );
  const realtimeScopeKeyRef = useRef(reloadTriggerKey);
  realtimeScopeKeyRef.current = reloadTriggerKey;
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
    focusedMessageId: focusedMessage?.[0] ?? null,
    focusedMessageActive,
    focusedHasMoreEarlier: focusedWindow?.hasMoreBefore ?? false,
    focusedHasMoreLater: focusedWindow?.hasMoreAfter ?? false,
    loadMissingNetworksForMessages,
    newestFirst,
    onError,
    onUnauthorized,
    optionsFreqValues,
    queryState,
    setGroupInfos: referenceState.setGroupInfos,
    setProfiles: referenceState.setProfiles,
    setSummaryCallsignsInfo: referenceState.setSummaryCallsignsInfo,
  });
  const realtimeMessageWindowRef = useRef({
    messages: messageList.messages,
    noMoreToLoad: messageList.noMoreToLoad,
    nolimitShown: messageList.nolimitShown,
    pageIndex: messageList.pageIndex,
  });
  realtimeMessageWindowRef.current = {
    messages: messageList.messages,
    noMoreToLoad: messageList.noMoreToLoad,
    nolimitShown: messageList.nolimitShown,
    pageIndex: messageList.pageIndex,
  };
  const refreshChangedMessagesTargetedRef = useRef<(messageIds: number[]) => Promise<void>>(
    async () => undefined,
  );

  useEffect(() => {
    if (focusedWindow == null) return;
    void loadMissingNetworksForMessages(focusedWindow.inbox.inboxItems);
  }, [focusedWindow, loadMissingNetworksForMessages]);

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
  const realtimeMapWindowRef = useRef({
    mapDateRange: mapData.mapDateRange,
    mapOpenMessages: mapData.mapOpenMessages,
  });
  realtimeMapWindowRef.current = {
    mapDateRange: mapData.mapDateRange,
    mapOpenMessages: mapData.mapOpenMessages,
  };

  const sidebarData = useAnalysisSidebarData({
    onError,
    onUnauthorized,
    optionsFreqValues,
    queryState,
    summaryCallsignsInfoRef: referenceState.summaryCallsignsInfoRef,
    setSummaryCallsignsInfo: referenceState.setSummaryCallsignsInfo,
  });

  const reconcileChangedMessagesBatch = useCallback(
    async (
      changedMessageIds: number[],
      shouldApply: (messageId: number) => boolean,
      signal: AbortSignal,
    ) => {
      const requestScopeKey = reloadTriggerKey;
      const requestMessageWindow = realtimeMessageWindowRef.current;
      const requestMapWindow = realtimeMapWindowRef.current;
      const requestMapMessagesLoadVersion = mapData.mapMessagesLoadVersionRef.current;
      const isScopeStale = () => signal.aborted || realtimeScopeKeyRef.current !== requestScopeKey;
      const isMapWindowStale = () => {
        const currentMapWindow = realtimeMapWindowRef.current;
        return (
          mapData.mapMessagesLoadVersionRef.current !== requestMapMessagesLoadVersion ||
          currentMapWindow.mapDateRange.startDate !== requestMapWindow.mapDateRange.startDate ||
          currentMapWindow.mapDateRange.endDate !== requestMapWindow.mapDateRange.endDate
        );
      };
      const isMessageWindowStale = () => {
        const currentMessageWindow = realtimeMessageWindowRef.current;
        return (
          currentMessageWindow.messages !== requestMessageWindow.messages ||
          currentMessageWindow.noMoreToLoad !== requestMessageWindow.noMoreToLoad ||
          currentMessageWindow.nolimitShown !== requestMessageWindow.nolimitShown ||
          currentMessageWindow.pageIndex !== requestMessageWindow.pageIndex
        );
      };
      const candidateMessageIds = normalizeMessageIds(changedMessageIds);
      if (candidateMessageIds.length === 0) return;
      const retryForLatestMessageWindow = () => {
        if (!isMessageWindowStale()) return false;
        const retryMessageIds = candidateMessageIds.filter(shouldApply);
        if (!isScopeStale() && retryMessageIds.length > 0) {
          void refreshChangedMessagesTargetedRef.current(retryMessageIds);
        }
        return true;
      };

      const visibleMessageIds = collectVisibleChangedMessageIds(
        candidateMessageIds,
        requestMessageWindow.messages,
        [],
      );
      const visibleMapMessageIds = collectVisibleChangedMessageIds(
        candidateMessageIds,
        [],
        requestMapWindow.mapOpenMessages,
      );
      const visibleInboxEventIds = collectVisibleInboxEventIds(requestMessageWindow.messages, []);
      const undisplayedMessageIds = candidateMessageIds.filter(
        (messageId) => !visibleInboxEventIds.has(messageId),
      );
      const needsServerFilter = requiresServerFilteredInboxRefresh(queryState, true);
      const mapNeedsServerFilter = requiresServerFilteredInboxRefresh(queryState, false);
      const visibleMessageIdSet = new Set(visibleMessageIds);
      const undisplayedMessageIdSet = new Set(undisplayedMessageIds);
      const exactFilterMessageIds = candidateMessageIds.filter(
        (messageId) =>
          undisplayedMessageIdSet.has(messageId) ||
          (needsServerFilter && visibleMessageIdSet.has(messageId)),
      );
      const exactMapFilterMessageIds = mapNeedsServerFilter ? visibleMapMessageIds : [];

      try {
        const inboxReq = buildLiveRefreshInboxReq(queryState, optionsFreqValues, true);
        const mapInboxReq = applyMapDateRangeToInboxReq(
          buildLiveRefreshInboxReq(queryState, optionsFreqValues, false),
          requestMapWindow.mapDateRange,
        );
        const requestsCanBeShared =
          !queryState.onlyWithMedia && !hasActiveMapDateRange(requestMapWindow.mapDateRange);
        let matchingMessageIds: number[];
        let matchingMapMessageIds: number[];
        if (requestsCanBeShared) {
          const exactMessageIds = normalizeMessageIds([
            ...exactFilterMessageIds,
            ...exactMapFilterMessageIds,
          ]);
          const matchingIds =
            exactMessageIds.length === 0
              ? []
              : await fetchMessageIdsMatchingFilters(exactMessageIds, inboxReq);
          matchingMessageIds = matchingIds;
          matchingMapMessageIds = matchingIds;
        } else {
          [matchingMessageIds, matchingMapMessageIds] = await Promise.all([
            exactFilterMessageIds.length === 0
              ? []
              : fetchMessageIdsMatchingFilters(exactFilterMessageIds, inboxReq),
            exactMapFilterMessageIds.length === 0
              ? []
              : fetchMessageIdsMatchingFilters(exactMapFilterMessageIds, mapInboxReq),
          ]);
        }
        if (isScopeStale() || retryForLatestMessageWindow()) return;

        const matchingMessageIdSet = new Set(
          matchingMessageIds.filter(
            (messageId) => exactFilterMessageIds.includes(messageId) && shouldApply(messageId),
          ),
        );
        const matchingMapMessageIdSet = new Set(
          matchingMapMessageIds.filter(
            (messageId) => exactMapFilterMessageIds.includes(messageId) && shouldApply(messageId),
          ),
        );
        const discoverUnseenMessages = canDiscoverUnseenMessages({
          focusedMessageActive,
          messages: requestMessageWindow.messages,
          newestFirst,
          noMoreToLoad: requestMessageWindow.noMoreToLoad,
          nolimitShown: requestMessageWindow.nolimitShown,
          pageIndex: requestMessageWindow.pageIndex,
        });
        const messageIdsToHydrate = normalizeMessageIds([
          ...(needsServerFilter
            ? visibleMessageIds.filter((messageId) => matchingMessageIdSet.has(messageId))
            : visibleMessageIds),
          ...(discoverUnseenMessages
            ? undisplayedMessageIds.filter((messageId) => matchingMessageIdSet.has(messageId))
            : []),
        ]).filter(shouldApply);
        const mapMessageIdsToHydrate = isMapWindowStale()
          ? []
          : (mapNeedsServerFilter
              ? visibleMapMessageIds.filter((messageId) => matchingMapMessageIdSet.has(messageId))
              : visibleMapMessageIds
            ).filter(shouldApply);
        let refreshedMessageItems: Array<[number, InboxMessage]>;
        let refreshedMapMessageItems: Array<[number, InboxMessage]>;
        if (requestsCanBeShared) {
          const messageIds = normalizeMessageIds([
            ...messageIdsToHydrate,
            ...mapMessageIdsToHydrate,
          ]);
          const refreshedItems =
            messageIds.length === 0
              ? []
              : await fetchMessagesByIds(messageIds, inboxReq, { signal });
          const messageIdSet = new Set(messageIdsToHydrate);
          const mapMessageIdSet = new Set(mapMessageIdsToHydrate);
          refreshedMessageItems = refreshedItems.filter(([messageId]) =>
            messageIdSet.has(messageId),
          );
          refreshedMapMessageItems = refreshedItems.filter(([messageId]) =>
            mapMessageIdSet.has(messageId),
          );
        } else {
          [refreshedMessageItems, refreshedMapMessageItems] = await Promise.all([
            messageIdsToHydrate.length === 0
              ? []
              : fetchMessagesByIds(messageIdsToHydrate, inboxReq, { signal }),
            mapMessageIdsToHydrate.length === 0
              ? []
              : fetchMessagesByIds(mapMessageIdsToHydrate, mapInboxReq, { signal }),
          ]);
        }
        if (isScopeStale() || retryForLatestMessageWindow()) return;

        const applicableVisibleMessageIds = visibleMessageIds.filter(shouldApply);
        const applicableVisibleMapMessageIds = isMapWindowStale()
          ? []
          : visibleMapMessageIds.filter(shouldApply);
        const applicableUndisplayedMessageIdSet = new Set(
          discoverUnseenMessages ? undisplayedMessageIds.filter(shouldApply) : [],
        );
        const shouldKeepRefreshedMessage = (messageId: number, message: InboxMessage) =>
          needsServerFilter
            ? matchingMessageIdSet.has(messageId)
            : messageMatchesLiveRefreshFilters(message, queryState, optionsFreqValues);
        const keptRefreshedMessageItems = refreshedMessageItems.filter(
          ([messageId, message]) =>
            shouldApply(messageId) &&
            shouldKeepRefreshedMessage(
              messageId,
              applyModelTagFilter(message, queryState.withoutModelTags),
            ),
        );
        const shouldKeepRefreshedMapMessage = (messageId: number, message: InboxMessage) =>
          mapNeedsServerFilter
            ? matchingMapMessageIdSet.has(messageId)
            : messageMatchesLiveRefreshFilters(
                message,
                queryState,
                optionsFreqValues,
                requestMapWindow.mapDateRange,
              );
        const keptRefreshedMapMessageItems = isMapWindowStale()
          ? []
          : refreshedMapMessageItems.filter(
              ([messageId, message]) =>
                shouldApply(messageId) &&
                shouldKeepRefreshedMapMessage(
                  messageId,
                  applyModelTagFilter(message, queryState.withoutModelTags),
                ),
            );
        const refreshedMessages = new Map(
          keptRefreshedMessageItems.map(([messageId, message]) => [messageId, message]),
        );
        const refreshedMapMessages = new Map(
          keptRefreshedMapMessageItems.map(([messageId, message]) => [messageId, message]),
        );
        const changedMessageIdSet = new Set(applicableVisibleMessageIds);
        const changedMapMessageIdSet = new Set(applicableVisibleMapMessageIds);
        const discoveredMessageItems = keptRefreshedMessageItems
          .filter(([messageId]) => applicableUndisplayedMessageIdSet.has(messageId))
          .map(
            ([messageId, message]) =>
              [messageId, applyModelTagFilter(message, queryState.withoutModelTags)] as [
                number,
                InboxMessage,
              ],
          );
        const reconcileListMessages = (currentMessages: Array<[number, InboxMessage]>) => {
          const reorderedMessageIds = new Set(
            currentMessages.flatMap(([messageId, currentMessage]) => {
              const refreshedMessage = refreshedMessages.get(messageId);
              return refreshedMessage != null &&
                changedMessageIdSet.has(messageId) &&
                hasRealtimeMessageOrderChanged(
                  currentMessage,
                  refreshedMessage,
                  queryState.messageTimeBasis,
                )
                ? [messageId]
                : [];
            }),
          );
          const stationaryRefreshedMessages = new Map(
            [...refreshedMessages].filter(([messageId]) => !reorderedMessageIds.has(messageId)),
          );
          const reorderedMessageItems = [...reorderedMessageIds].flatMap((messageId) => {
            const refreshedMessage = refreshedMessages.get(messageId);
            if (refreshedMessage == null) return [];
            const nextMessage = applyModelTagFilter(refreshedMessage, queryState.withoutModelTags);
            return shouldKeepRefreshedMessage(messageId, nextMessage)
              ? ([[messageId, nextMessage]] as Array<[number, InboxMessage]>)
              : [];
          });

          return insertDiscoveredMessages(
            mergeRefreshedMessages(
              currentMessages,
              changedMessageIdSet,
              stationaryRefreshedMessages,
              queryState.withoutModelTags,
              shouldKeepRefreshedMessage,
            ),
            [...discoveredMessageItems, ...reorderedMessageItems],
            {
              messageTimeBasis: queryState.messageTimeBasis,
              newestFirst,
              noMoreToLoad: requestMessageWindow.noMoreToLoad,
              nolimitShown: requestMessageWindow.nolimitShown,
              pageIndex: requestMessageWindow.pageIndex,
              preserveMessageIds: reorderedMessageIds,
            },
          );
        };
        const currentMessageItems = requestMessageWindow.messages;
        const nextMessageItems = reconcileListMessages(currentMessageItems);
        if (!sameMessageItems(currentMessageItems, nextMessageItems)) {
          onBeforeRealtimeMessageListChange?.();
          messageList.setMessages((currentMessages) =>
            currentMessages === currentMessageItems
              ? nextMessageItems
              : reconcileListMessages(currentMessages),
          );
        }
        if (applicableVisibleMapMessageIds.length > 0 && !isMapWindowStale()) {
          mapData.setMapOpenMessages((currentMessages) =>
            isMapWindowStale()
              ? currentMessages
              : mergeRefreshedMessages(
                  currentMessages,
                  changedMapMessageIdSet,
                  refreshedMapMessages,
                  queryState.withoutModelTags,
                  shouldKeepRefreshedMapMessage,
                ),
          );
        }
        if (messageIdsToHydrate.length === 0 && mapMessageIdsToHydrate.length === 0) return;
        const keptMessageItems = [
          ...new Map(
            [...keptRefreshedMessageItems, ...keptRefreshedMapMessageItems].map(
              ([messageId, message]) => [messageId, message],
            ),
          ),
        ];
        await loadMissingNetworksForMessages(keptMessageItems);
        if (isScopeStale()) return;
        await messageList.loadMessageComments(keptMessageItems, true);
      } catch (loadError) {
        if (signal.aborted) return;
        if (!onUnauthorized(loadError)) onError(toErrorMessage(loadError));
      } finally {
        if (!isScopeStale()) messageList.refreshMessageCounts();
      }
    },
    [
      focusedMessageActive,
      loadMissingNetworksForMessages,
      mapData,
      messageList,
      newestFirst,
      onBeforeRealtimeMessageListChange,
      onError,
      onUnauthorized,
      optionsFreqValues,
      queryState,
      reloadTriggerKey,
    ],
  );
  const refreshChangedMessagesTargeted = useTargetedInboxReconciliation(
    reconcileChangedMessagesBatch,
  );
  refreshChangedMessagesTargetedRef.current = refreshChangedMessagesTargeted;

  const refreshChangedMessages = useCallback(
    async (changedMessageIds: number[], _events: InboxChangedEvent[] = []) => {
      const reconciliationMessageIds = normalizeMessageIds(
        normalizeMessageIds(changedMessageIds).flatMap((messageId) => {
          const visibleMessageIds = collectVisibleChangedMessageIds(
            [messageId],
            messageList.messages,
            mapData.mapOpenMessages,
          );
          return visibleMessageIds.length === 0 ? [messageId] : visibleMessageIds;
        }),
      );
      await refreshChangedMessagesTargeted(reconciliationMessageIds);
    },
    [mapData.mapOpenMessages, messageList.messages, refreshChangedMessagesTargeted],
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
      reconcileTagMutation: (messageId) => refreshChangedMessagesTargeted([messageId]),
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
      focusedWindow,
      focusedMessageActive,
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
      replaceCurrentMessagePage: messageList.replaceCurrentMessagePage,
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
        void refreshChangedMessagesTargeted([event.messageId]);
      }
      return disposition !== 'unmatched';
    },
    onMessageIds: refreshChangedMessages,
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
    loadFocusedEarlier: messageList.loadFocusedEarlier,
    loadFocusedLater: messageList.loadFocusedLater,
    loadLastPage: messageList.loadLastPage,
    loadNextPage: messageList.loadNextPage,
    loadMoreMessages: messageList.loadMoreMessages,
    loadPrevPage: messageList.loadPrevPage,
    loadMessagesForMap: mapData.loadMessagesForMap,
    loadSettlementMessagesForMap: mapData.loadSettlementMessagesForMap,
    mapAttrs: mapData.mapAttrs,
    messageActionLoading: messageActionState.messageActionCount > 0,
    messagesLoading: messageList.messagesLoading,
    messagesPaging: messageList.messagesPaging,
    messageComments: messageList.messageComments,
    messages: messageList.messages,
    messagesOverallCount: messageList.messagesOverallCount,
    messagesTotalCount: messageList.messagesTotalCount,
    messagesTotalLoading: messageList.messagesTotalLoading,
    focusedHasMoreEarlier: messageList.focusedHasMoreEarlier,
    focusedHasMoreLater: messageList.focusedHasMoreLater,
    focusedLoadingEarlier: messageList.focusedLoadingEarlier,
    focusedLoadingLater: messageList.focusedLoadingLater,
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
