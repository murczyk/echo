import type {
  CallsignInfoRes,
  CorrelatedFreq,
  CountStatsRsp,
  FreqDailyActivityCount,
  FreqDetailedPoint,
  InboxMessage,
  MessageComment,
  NetJsonGraphAndMeta,
  Network,
  NetworkUnit,
  NewCallsignsRes,
  PalitraReadV2,
  SignalGroupEntry,
  SignalProfileEntry,
  SummaryTableFreqRow,
  Tag,
  User,
  Unit,
} from '../../../../Bindings';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { fetchInboxMessages } from '../../services/api/analysis';
import { buildInboxReq, queryStateComparisonKey } from './helpers';
import { buildMapAttrs } from './helpers-map';
import { buildNetworkDisplayMap } from './message-utils';
import { mergeAnalysisCallsignInfoMap } from './use-analysis-data.callsigns';
import { useAnalysisFilterSections } from './use-analysis-data-filter-sections';
import { useAnalysisDataLoaders } from './use-analysis-data.loaders';
import { useAnalysisDataMessageActions } from './use-analysis-data.message-actions';
import { reloadAnalysisData } from './use-analysis-data.reload';
import { emptyNewCallsigns, emptyOptions, isAnalysisInboxPageExhausted, toErrorMessage } from './use-analysis-data.shared';
import { useAnalysisDataStateUtils } from './use-analysis-data.state-utils';
import { loadMissingMessageCommentsForMessages } from './use-analysis-data.comments';
import {
  useLoadMissingNetworksForMessages,
  useLoadNewCallsigns,
  mergeNetworksById,
  shouldSkipNewCallsignsLoad,
} from './use-analysis-data.support';
import type { UseAnalysisDataProps, UseAnalysisDataResult } from './use-analysis-data.types';
import type {
  AnalysisAorEntry,
  AnalysisCountItem,
  AnalysisFilterOptions,
  AnalysisGroupsActivityPeriod,
  AnalysisPalitrasLoadState,
} from './types';

export { mergeNetworksById, shouldSkipNewCallsignsLoad } from './use-analysis-data.support';

export function useAnalysisData({
  currentUser,
  centerTab,
  newestFirst,
  onError,
  onUnauthorized,
  queryState,
  rightPanelOpen,
  rightSidebarVisible,
  rightSidebarTab,
  shouldLoadNewCallsigns,
}: UseAnalysisDataProps): UseAnalysisDataResult {
  const [countsLoading, setCountsLoading] = useState(false);
  const [filtersLoading, setFiltersLoading] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [hasLoadedInitialMessages, setHasLoadedInitialMessages] = useState(false);
  const [messagesPaging, setMessagesPaging] = useState(false);
  const [counts, setCounts] = useState<CountStatsRsp | null>(null);
  const [aorEntries, setAorEntries] = useState<AnalysisAorEntry[]>([]);
  const [messages, setMessages] = useState<Array<[number, InboxMessage]>>([]);
  const [messageComments, setMessageComments] = useState<Record<number, MessageComment[]>>({});
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryRows, setSummaryRows] = useState<SummaryTableFreqRow[]>([]);
  const [rightSidebarLoading, setRightSidebarLoading] = useState(false);
  const [newCallsignsLoading, setNewCallsignsLoading] = useState(false);
  const [newCallsigns, setNewCallsigns] = useState<NewCallsignsRes>(emptyNewCallsigns);
  const [noMoreToLoad, setNoMoreToLoad] = useState(false);
  const [nolimitShown, setNolimitShown] = useState(false);
  const [options, setOptions] = useState<AnalysisFilterOptions>(emptyOptions);
  const [topFreqs, setTopFreqs] = useState<AnalysisCountItem[]>([]);
  const [topCallsigns, setTopCallsigns] = useState<AnalysisCountItem[]>([]);
  const [topUnits, setTopUnits] = useState<AnalysisCountItem[]>([]);
  const [topLocations, setTopLocations] = useState<AnalysisCountItem[]>([]);
  const [mapLoading, setMapLoading] = useState(false);
  const [mapDateRange, setMapDateRange] = useState({ startDate: 0, endDate: 0 });
  const [mapPoints, setMapPoints] = useState<FreqDetailedPoint[]>([]);
  const [mapNetworkUnits, setMapNetworkUnits] = useState<NetworkUnit[]>([]);
  const [mapOpenMessages, setMapOpenMessages] = useState<Array<[number, InboxMessage]>>([]);
  const [mapPalitras, setMapPalitras] = useState<PalitraReadV2[]>([]);
  const [mapPalitrasLoaded, setMapPalitrasLoaded] = useState(false);
  const [mapPalitrasLoadState, setMapPalitrasLoadState] = useState<AnalysisPalitrasLoadState>('idle');
  const [correlatedFreqs, setCorrelatedFreqs] = useState<CorrelatedFreq[]>([]);
  const [correlatedFreqsLoading, setCorrelatedFreqsLoading] = useState(false);
  const [callsignGraph, setCallsignGraph] = useState<NetJsonGraphAndMeta | null>(null);
  const [callsignGraphLoading, setCallsignGraphLoading] = useState(false);
  const [callsignGraphLoadVersion, setCallsignGraphLoadVersion] = useState(0);
  const [callsignGraphNolimit, setCallsignGraphNolimit] = useState(false);
  const [groupsActivity, setGroupsActivity] = useState<FreqDailyActivityCount | null>(null);
  const [groupsActivityLoadedFreq, setGroupsActivityLoadedFreq] = useState<string | null>(null);
  const [groupsActivityLoadedPeriod, setGroupsActivityLoadedPeriod] = useState<AnalysisGroupsActivityPeriod | null>(null);
  const [groupsActivityLoading, setGroupsActivityLoading] = useState(false);
  const [groupsActivityPeriod, setGroupsActivityPeriod] = useState<AnalysisGroupsActivityPeriod>('selected');
  const [profiles, setProfiles] = useState<Record<string, SignalProfileEntry | null>>({});
  const [groupInfos, setGroupInfos] = useState<Record<string, SignalGroupEntry>>({});
  const [users, setUsers] = useState<Record<string, User | null>>({});
  const [tagsMap, setTagsMap] = useState<Record<number, Tag>>({});
  const [networkDisplayMap, setNetworkDisplayMap] = useState<Record<number, string>>({});
  const [networks, setNetworks] = useState<Network[]>([]);
  const networksRef = useRef(networks);
  const currentUserRef = useRef(currentUser);
  const messageCommentsRef = useRef(messageComments);
  const usersRef = useRef(users);
  const mapMessagesLoadVersionRef = useRef(0);
  const mapDateRangeLoadVersionRef = useRef(0);
  const messageCommentsLoadVersionRef = useRef(0);
  const [summaryCallsignsInfo, setSummaryCallsignsInfo] = useState<Record<string, CallsignInfoRes>>({});
  const [unitsMap, setUnitsMap] = useState<Record<number, Unit>>({});
  const optionsFreqsRef = useRef<string[]>([]);
  const reloadTriggerKey = useMemo(
    () => `${queryStateComparisonKey(queryState) ?? 'invalid'}|${newestFirst ? 'desc' : 'asc'}`,
    [newestFirst, queryState],
  );
  const callsignGraphRequestRef = useRef(0);
  const reloadRequestRef = useRef(0);
  const lastReloadTriggerKeyRef = useRef<string | null>(null);
  const loadMoreMessagesRequestRef = useRef(0);
  const newCallsignsRequestRef = useRef(0);
  const shouldLoadNewCallsignsRef = useRef(shouldLoadNewCallsigns);
  const newCallsignsLoadedKeyRef = useRef<string | null>(null);
  const newCallsignsPendingKeyRef = useRef<string | null>(null);
  const unitsMapRef = useRef(unitsMap);
  const optionsFreqValues = useMemo(() => options.freqs.map((option) => option.value), [options.freqs]);

  useEffect(() => {
    optionsFreqsRef.current = optionsFreqValues;
  }, [optionsFreqValues]);

  useEffect(() => {
    shouldLoadNewCallsignsRef.current = shouldLoadNewCallsigns;
  }, [shouldLoadNewCallsigns]);

  useEffect(() => {
    setNetworkDisplayMap(buildNetworkDisplayMap(networks, unitsMap));
  }, [networks, unitsMap]);

  useEffect(() => {
    // Async network hydration reads the latest snapshot from here to avoid stale closure races.
    networksRef.current = networks;
  }, [networks]);

  useEffect(() => {
    unitsMapRef.current = unitsMap;
  }, [unitsMap]);

  useEffect(() => {
    currentUserRef.current = currentUser;
  }, [currentUser]);

  useEffect(() => {
    messageCommentsRef.current = messageComments;
  }, [messageComments]);

  useEffect(() => {
    usersRef.current = users;
  }, [users]);

  const invalidateMessagePaging = useCallback(() => {
    loadMoreMessagesRequestRef.current += 1;
    setMessagesPaging(false);
  }, []);

  const { invalidateFilterSectionLoads, loadFilterSection, loadInitialFilterSections } = useAnalysisFilterSections({
    queryState,
    optionsFreqValues,
    unitsMapRef,
    onError,
    onUnauthorized,
    setAorEntries,
    setGroupInfos,
    setNetworkDisplayMap,
    setNetworks,
    setOptions,
    setProfiles,
    setTagsMap,
  });

  const {
    downloadGeojson,
    downloadKmz,
    downloadSummaryXlsx,
    invalidateCorrelatedFreqsCache,
    invalidateCallsignGraph,
    loadCallsignGraph,
    loadCorrelatedFreqs,
    loadGroupsActivity,
    loadMapPalitras,
    loadMessagesForMap,
    loadSummaryData,
    loadTopSidebarData,
    refreshMapDateRange,
    invalidateSummaryData,
    invalidateRightSidebarData,
    toggleCallsignGraphNolimit,
  } = useAnalysisDataLoaders({
    callsignGraphNolimit,
    callsignGraphRequestRef,
    groupsActivityPeriod,
    mapDateRangeLoadVersionRef,
    mapMessagesLoadVersionRef,
    newestFirst,
    onError,
    onUnauthorized,
    optionsFreqs: optionsFreqValues,
    queryState,
    setCallsignGraph,
    setCallsignGraphLoading,
    setCallsignGraphLoadVersion,
    setCallsignGraphNolimit,
    setCorrelatedFreqs,
    setCorrelatedFreqsLoading,
    setGroupsActivity,
    setGroupsActivityLoadedFreq,
    setGroupsActivityLoadedPeriod,
    setGroupsActivityLoading,
    setGroupsActivityPeriod,
    setMapDateRange,
    setMapLoading,
    setMapNetworkUnits,
    setMapOpenMessages,
    setMapPalitras,
    setMapPalitrasLoaded,
    setMapPalitrasLoadState,
    setMapPoints,
    setSummaryCallsignsInfo,
    setSummaryLoading,
    setSummaryRows,
    setTopCallsigns,
    setTopFreqs,
    setTopLocations,
    setRightSidebarLoading,
    setTopUnits,
  });

  const loadNewCallsigns = useLoadNewCallsigns({
    onError,
    onUnauthorized,
    optionsFreqValues,
    queryState,
    setNewCallsigns,
    setNewCallsignsLoading,
    newCallsignsRequestRef,
    newCallsignsLoadedKeyRef,
    newCallsignsPendingKeyRef,
  });

  const loadMissingNetworksForMessages = useLoadMissingNetworksForMessages({
    networksRef,
    onError,
    onUnauthorized,
    setNetworkDisplayMap,
    setNetworks,
    unitsMap,
  });

  const { clearAnalysisResults, onUpdateLocalMessage, patchMessages } = useAnalysisDataStateUtils({
    emptyNewCallsigns,
    emptyOptions,
    invalidateCallsignGraph,
    optionsFreqsRef,
    setAorEntries,
    setCounts,
    setCorrelatedFreqs,
    setGroupInfos,
    setGroupsActivity,
    setGroupsActivityLoadedFreq,
    setGroupsActivityLoadedPeriod,
    setMapDateRange,
    setMapNetworkUnits,
    setMapOpenMessages,
    setMapPoints,
    setMessages,
    setMessageComments,
    setNetworkDisplayMap,
    setNetworks,
    setNewCallsigns,
    setNoMoreToLoad,
    setNolimitShown,
    setOptions,
    setProfiles,
    setSummaryCallsignsInfo,
    setSummaryLoading,
    setSummaryRows,
    setTagsMap,
    setTopCallsigns,
    setTopFreqs,
    setTopLocations,
    setRightSidebarLoading,
    setTopUnits,
    setUnitsMap,
    setHasLoadedInitialMessages,
    invalidateMessageCommentsLoads: () => {
      messageCommentsLoadVersionRef.current += 1;
      setMessageComments({});
    },
  });

  const loadMessageComments = useCallback(
    async (loadedMessages: Array<[number, InboxMessage]>, forceReload = false) => {
      await loadMissingMessageCommentsForMessages(loadedMessages, {
        authUserName: currentUserRef.current?.name ?? null,
        currentUser: currentUserRef.current,
        messageComments: messageCommentsRef.current,
        messageCommentsLoadVersionRef,
        onError,
        onUnauthorized,
        setMessageComments,
        setUsers,
        users: usersRef.current,
      }, forceReload);
    },
    [onError, onUnauthorized, setMessageComments, setUsers],
  );

  const reload = useCallback(async () => {
    messageCommentsLoadVersionRef.current += 1;
    setMessageComments({});
    await reloadAnalysisData({
      clearAnalysisResults,
      invalidateCallsignGraph,
      invalidateCorrelatedFreqsCache,
      invalidateMessagePaging,
      newestFirst,
      onError,
      onUnauthorized,
      optionsFreqsRef,
      queryState,
      reloadRequestRef,
      newCallsignsRequestRef,
      newCallsignsLoadedKeyRef,
      newCallsignsPendingKeyRef,
      setAorEntries,
      setCounts,
      setCountsLoading,
      setFiltersLoading,
      invalidateFilterSectionLoads,
      setGroupInfos,
      setMapLoading,
      setMapDateRange,
      setMapNetworkUnits,
      setMapOpenMessages,
      setMapPoints,
      setMessages,
      loadMessageComments,
      setMessagesLoading,
      setNetworkDisplayMap,
      setNetworks,
      setNewCallsigns,
      setNewCallsignsLoading,
      setNewCallsignsLoadedKey: (key) => {
        newCallsignsLoadedKeyRef.current = key;
      },
      shouldLoadNewCallsigns: shouldLoadNewCallsignsRef.current,
      setNoMoreToLoad,
      setNolimitShown,
      setOptions,
      setProfiles,
      setSummaryCallsignsInfo,
      setTagsMap,
      setTopCallsigns,
      setTopFreqs,
      setTopLocations,
      setTopUnits,
      setUnitsMap,
      setHasLoadedInitialMessages,
      invalidateSummaryLoads: invalidateSummaryData,
      invalidateTopSidebarLoads: invalidateRightSidebarData,
      loadInitialFilterSections,
    });
  }, [
    clearAnalysisResults,
    invalidateCallsignGraph,
    invalidateCorrelatedFreqsCache,
    invalidateFilterSectionLoads,
    invalidateSummaryData,
    invalidateRightSidebarData,
    invalidateMessagePaging,
    loadMessageComments,
    loadInitialFilterSections,
    newestFirst,
    onError,
    onUnauthorized,
    queryState,
  ]);

  const {
    messageActionCount,
    onDeleteMessage,
    onToggleMessageBookmark,
    onToggleMessageImportant,
    onSaveMessageComment,
    onToggleMessageTag,
    renameSummaryUnit,
  } = useAnalysisDataMessageActions({
    messages,
    mapOpenMessages,
    optionsFreqs: optionsFreqValues,
    onError,
    onUnauthorized,
    patchMessages,
    queryState,
    reload,
    setMapOpenMessages,
    setMessages,
    setSummaryRows,
    toErrorMessage,
  });

  const loadAllMessages = useCallback(async () => {
    const inboxReq = buildInboxReq(queryState, optionsFreqValues);
    if (inboxReq == null) return;

    setMessagesPaging(true);
    try {
      const rsp = await fetchInboxMessages({ ...inboxReq, nolimit: true, newestFirst });
      setMessages(rsp.inboxItems ?? []);
      setSummaryCallsignsInfo((current) => mergeAnalysisCallsignInfoMap(current, rsp.callsigns));
      await loadMissingNetworksForMessages(rsp.inboxItems ?? []);
      await loadMessageComments(rsp.inboxItems ?? [], false);
      setNolimitShown(true);
      setNoMoreToLoad(isAnalysisInboxPageExhausted(rsp.inboxItems, rsp.pageLimit));
    } catch (loadError) {
      if (!onUnauthorized(loadError)) {
        onError(toErrorMessage(loadError));
      }
    } finally {
      setMessagesPaging(false);
    }
  }, [loadMessageComments, loadMissingNetworksForMessages, newestFirst, onError, onUnauthorized, optionsFreqValues, queryState]);

  const loadMoreMessages = useCallback(async () => {
    const inboxReq = buildInboxReq(queryState, optionsFreqValues);
    const lastMessage = messages.at(-1);
    if (inboxReq == null || lastMessage == null) return;

    const requestId = loadMoreMessagesRequestRef.current + 1;
    loadMoreMessagesRequestRef.current = requestId;
    const isStaleLoadMore = () => requestId !== loadMoreMessagesRequestRef.current;

    setMessagesPaging(true);
    try {
      const paginatedReq = newestFirst
        ? { ...inboxReq, beforeIdNoninclusive: lastMessage[0], newestFirst }
        : { ...inboxReq, sinceIdNoninclusive: lastMessage[0], newestFirst };
      const rsp = await fetchInboxMessages(paginatedReq);
      if (isStaleLoadMore()) {
        return;
      }
      const nextMessages = rsp.inboxItems ?? [];
      setSummaryCallsignsInfo((current) => mergeAnalysisCallsignInfoMap(current, rsp.callsigns));
      setMessages((current) => [...current, ...nextMessages]);
      await loadMissingNetworksForMessages(nextMessages);
      await loadMessageComments(nextMessages, false);
      if (nextMessages.length === 0 || isAnalysisInboxPageExhausted(nextMessages, rsp.pageLimit)) {
        setNoMoreToLoad(true);
      }
    } catch (loadError) {
      if (isStaleLoadMore()) {
        return;
      }
      if (!onUnauthorized(loadError)) {
        onError(toErrorMessage(loadError));
      }
    } finally {
      if (!isStaleLoadMore()) {
        setMessagesPaging(false);
      }
    }
  }, [loadMessageComments, loadMissingNetworksForMessages, messages, newestFirst, onError, onUnauthorized, optionsFreqValues, queryState]);

  useEffect(() => {
    if (lastReloadTriggerKeyRef.current === reloadTriggerKey) return;
    lastReloadTriggerKeyRef.current = reloadTriggerKey;
    void reload();
  }, [reload, reloadTriggerKey]);

  useEffect(() => {
    if (centerTab !== 'summary') return;
    void loadSummaryData();
  }, [centerTab, loadSummaryData]);

  useEffect(() => {
    if (!rightSidebarVisible) return;
    if (rightSidebarTab !== 'stats' && rightSidebarTab !== 'callsigns') return;
    void loadTopSidebarData();
  }, [loadTopSidebarData, rightSidebarTab, rightSidebarVisible]);

  useEffect(() => {
    void loadMapPalitras();
  }, [loadMapPalitras]);

  const mapAttrs = useMemo(
    () =>
      buildMapAttrs({
        dateRange: mapDateRange,
        isLoading: mapLoading,
        points: mapPoints,
        messages: mapOpenMessages,
        networkUnits: mapNetworkUnits,
        selectedUnits: queryState.unitsSelected,
        palitras: mapPalitras,
        palitrasLoaded: mapPalitrasLoaded,
        palitrasLoadState: mapPalitrasLoadState,
      }),
    [
      mapDateRange,
      mapLoading,
      mapNetworkUnits,
      mapOpenMessages,
      mapPalitras,
      mapPalitrasLoaded,
      mapPalitrasLoadState,
      mapPoints,
      queryState.unitsSelected,
    ],
  );

  return {
    callsignGraph,
    callsignGraphLoading,
    callsignGraphLoadVersion,
    callsignGraphNolimit,
    correlatedFreqs,
    correlatedFreqsLoading,
    counts,
    countsLoading,
    aorEntries,
    filtersLoading,
    groupsActivityPeriod,
    downloadGeojson,
    downloadKmz,
    downloadSummaryXlsx,
    groupsActivity,
    groupsActivityLoadedFreq,
    groupsActivityLoadedPeriod,
    groupsActivityLoading,
    hasLoadedInitialMessages,
    inboxReq: buildInboxReq(queryState, optionsFreqValues),
    loadCallsignGraph,
    loadAllMessages,
    loadFilterSection,
    invalidateFilterSectionLoads,
    toggleCallsignGraphNolimit,
    loadCorrelatedFreqs,
    loadGroupsActivity,
    loadNewCallsigns,
    loadMoreMessages,
    loadMessagesForMap,
    mapAttrs,
    messageActionLoading: messageActionCount > 0,
    messagesLoading,
    messagesPaging,
    messageComments,
    messages,
    networkDisplayMap,
    networks,
    newCallsigns,
    newCallsignsLoading,
    noMoreToLoad,
    nolimitShown,
    onUpdateLocalMessage,
    onDeleteMessage,
    onSaveMessageComment,
    onToggleMessageBookmark,
    onToggleMessageImportant,
    onToggleMessageTag,
    options,
    profiles,
    users,
    refreshMapDateRange,
    reload,
    summaryLoading,
    rightSidebarLoading,
    summaryRows,
    summaryCallsignsInfo,
    unitsMap,
    tagsMap,
    topCallsigns,
    topFreqs,
    groupInfos,
    topLocations,
    topUnits,
    renameSummaryUnit,
  };
}
