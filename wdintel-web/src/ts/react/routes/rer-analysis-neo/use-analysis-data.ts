import type {
  CallsignInfoRes,
  CorrelatedFreq,
  CountStatsRsp,
  FreqDailyActivityCount,
  FreqDetailedPoint,
  InboxMessage,
  NetJsonGraphAndMeta,
  Network,
  NetworkUnit,
  NewCallsignsRes,
  PalitraReadV2,
  SignalGroupEntry,
  SignalProfileEntry,
  SummaryTableFreqRow,
  Tag,
  Unit,
} from '../../../../Bindings';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  fetchAnalysisAors,
  fetchAnalysisCallsignGraph,
  fetchAnalysisCallsigns,
  fetchAnalysisCallsignInfos,
  fetchAnalysisCorrelatedFreqs,
  fetchAnalysisCount,
  fetchAnalysisFreqs,
  fetchAnalysisGroups,
  fetchAnalysisLocations,
  fetchAnalysisMapPoints,
  fetchAnalysisMetadata,
  fetchAnalysisNetworks,
  fetchAnalysisNewCallsigns,
  fetchAnalysisPosts,
  fetchAnalysisSenders,
  fetchAnalysisSummaryTable,
  fetchAnalysisTags,
  fetchAnalysisUnits,
  fetchUnitsByIds,
  fetchNetworksByIds,
  fetchFreqActivityDaily,
  fetchInboxMessages,
  fetchMessagesByIds,
  getGroupInfosBatch,
  getLatestSenders,
  getTagsMapForDisplay,
  downloadAnalysisGeojson,
  downloadAnalysisKmz,
  downloadAnalysisSummaryTableXlsx,
} from '../../services/api/analysis';
import { listPalitrasV2 } from '../../services/api/palitra';
import { downloadBlob } from '../../utils/download-blob';
import { sortFrequenciesNumerically, sortStringsAlphabetically } from '../../utils/misc';
import {
  ANALYSIS_SESSION_ACTIVITY_PAGE_ID,
  buildAnalysisReq,
  buildInboxReq,
  pushQueryStateToUrl,
  shouldRebuildAnalysisRequests,
} from './helpers';
import { buildMapAttrs } from './helpers-map';
import { buildNetworkDisplayMap } from './message-utils';
import { buildSummaryCallsignsInfo, mergeAnalysisCallsignInfoMap } from './use-analysis-data.callsigns';
import { useAnalysisDataLoaders } from './use-analysis-data.loaders';
import { useAnalysisDataMessageActions } from './use-analysis-data.message-actions';
import { reloadAnalysisData } from './use-analysis-data.reload';
import { emptyNewCallsigns, emptyOptions, toErrorMessage, topItems } from './use-analysis-data.shared';
import { useAnalysisDataStateUtils } from './use-analysis-data.state-utils';
import type { UseAnalysisDataProps, UseAnalysisDataResult } from './use-analysis-data.types';
import type {
  AnalysisAorEntry,
  AnalysisCountItem,
  AnalysisFilterOptions,
  AnalysisGroupsActivityPeriod,
  AnalysisMapAttrs,
  AnalysisPalitrasLoadState,
} from './types';

export function useAnalysisData({ newestFirst, onError, onUnauthorized, queryState }: UseAnalysisDataProps): UseAnalysisDataResult {
  const [countsLoading, setCountsLoading] = useState(false);
  const [filtersLoading, setFiltersLoading] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesPaging, setMessagesPaging] = useState(false);
  const [counts, setCounts] = useState<CountStatsRsp | null>(null);
  const [aorEntries, setAorEntries] = useState<AnalysisAorEntry[]>([]);
  const [messages, setMessages] = useState<Array<[number, InboxMessage]>>([]);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryRows, setSummaryRows] = useState<SummaryTableFreqRow[]>([]);
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
  const [tagsMap, setTagsMap] = useState<Record<number, Tag>>({});
  const [networkDisplayMap, setNetworkDisplayMap] = useState<Record<number, string>>({});
  const [networks, setNetworks] = useState<Network[]>([]);
  const mapMessagesLoadVersionRef = useRef(0);
  const mapDateRangeLoadVersionRef = useRef(0);
  const [summaryCallsignsInfo, setSummaryCallsignsInfo] = useState<Record<string, CallsignInfoRes>>({});
  const [unitsMap, setUnitsMap] = useState<Record<number, Unit>>({});
  const optionsFreqsRef = useRef<string[]>([]);
  const callsignGraphRequestRef = useRef(0);
  const reloadRequestRef = useRef(0);
  const loadMoreMessagesRequestRef = useRef(0);

  useEffect(() => {
    optionsFreqsRef.current = options.freqs;
  }, [options.freqs]);

  const invalidateMessagePaging = useCallback(() => {
    loadMoreMessagesRequestRef.current += 1;
    setMessagesPaging(false);
  }, []);

  const {
    downloadGeojson,
    downloadKmz,
    downloadSummaryXlsx,
    invalidateCallsignGraph,
    loadCallsignGraph,
    loadCorrelatedFreqs,
    loadGroupsActivity,
    loadMapPalitras,
    loadMessagesForMap,
    refreshMapDateRange,
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
    optionsFreqs: options.freqs,
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
    setNetworkDisplayMap,
    setNetworks,
    setNewCallsigns,
    setNoMoreToLoad,
    setNolimitShown,
    setOptions,
    setProfiles,
    setSummaryCallsignsInfo,
    setSummaryRows,
    setTagsMap,
    setTopCallsigns,
    setTopFreqs,
    setTopLocations,
    setTopUnits,
    setUnitsMap,
  });

  const reload = useCallback(async () => {
    await reloadAnalysisData({
      clearAnalysisResults,
      invalidateCallsignGraph,
      invalidateMessagePaging,
      newestFirst,
      onError,
      onUnauthorized,
      optionsFreqsRef,
      queryState,
      reloadRequestRef,
      setAorEntries,
      setCounts,
      setCountsLoading,
      setFiltersLoading,
      setGroupInfos,
      setMapLoading,
      setMapDateRange,
      setMapNetworkUnits,
      setMapOpenMessages,
      setMapPoints,
      setMessages,
      setMessagesLoading,
      setNetworkDisplayMap,
      setNetworks,
      setNewCallsigns,
      setNewCallsignsLoading,
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
      setTopUnits,
      setUnitsMap,
    });
  }, [clearAnalysisResults, invalidateCallsignGraph, invalidateMessagePaging, newestFirst, onError, onUnauthorized, queryState]);

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
    optionsFreqs: options.freqs,
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
    const inboxReq = buildInboxReq(queryState, options.freqs);
    if (inboxReq == null) return;

    setMessagesPaging(true);
    try {
      const rsp = await fetchInboxMessages({ ...inboxReq, nolimit: true, newestFirst });
      setMessages(rsp.inboxItems ?? []);
      setSummaryCallsignsInfo((current) => mergeAnalysisCallsignInfoMap(current, rsp.callsigns));
      setNolimitShown(true);
      setNoMoreToLoad(true);
    } catch (loadError) {
      if (!onUnauthorized(loadError)) {
        onError(toErrorMessage(loadError));
      }
    } finally {
      setMessagesPaging(false);
    }
  }, [newestFirst, onError, onUnauthorized, options.freqs, queryState]);

  const loadMoreMessages = useCallback(async () => {
    const inboxReq = buildInboxReq(queryState, options.freqs);
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
      if (nextMessages.length === 0) {
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
  }, [messages, newestFirst, onError, onUnauthorized, options.freqs, queryState]);

  useEffect(() => {
    void reload();
  }, [reload]);

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
    inboxReq: buildInboxReq(queryState, options.freqs),
    loadCallsignGraph,
    loadAllMessages,
    toggleCallsignGraphNolimit,
    loadCorrelatedFreqs,
    loadGroupsActivity,
    loadMoreMessages,
    loadMessagesForMap,
    mapAttrs,
    messageActionLoading: messageActionCount > 0,
    messagesLoading,
    messagesPaging,
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
    refreshMapDateRange,
    reload,
    summaryLoading,
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
