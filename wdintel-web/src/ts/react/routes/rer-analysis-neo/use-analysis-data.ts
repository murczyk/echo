import type {
  CallsignInfoRes,
  CorrelatedFreq,
  CountStatsRsp,
  FreqDailyActivityCount,
  FreqDetailedPoint,
  InboxMessage,
  InboxMessageTag,
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
  bookmarkAdd,
  bookmarkRemove,
  commentSave,
  deleteMessage,
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
  importantAdd,
  importantRemove,
  inboxMessageTagsAdd,
  inboxMessageTagsRm,
  downloadAnalysisGeojson,
  downloadAnalysisKmz,
  downloadAnalysisSummaryTableXlsx,
  editAnalysisFreqUnitName,
} from '../../services/api/analysis';
import { listPalitrasV2 } from '../../services/api/palitra';
import { downloadBlob } from '../../utils/download-blob';
import { sortFrequenciesNumerically, sortStringsAlphabetically } from '../../utils/misc';
import { sortAndTakeTopAnalysisCountItems } from './count-items';
import {
  ANALYSIS_SESSION_ACTIVITY_PAGE_ID,
  buildAnalysisReq,
  buildInboxReq,
  pushQueryStateToUrl,
  shouldRebuildAnalysisRequests,
} from './helpers';
import { buildMapAttrs } from './helpers-map';
import { buildNetworkDisplayMap, getMessageTagEnabled } from './message-utils';
import type {
  AnalysisAorEntry,
  AnalysisCountItem,
  AnalysisFilterOptions,
  AnalysisGroupsActivityPeriod,
  AnalysisMapAttrs,
  AnalysisPalitrasLoadState,
} from './types';

type Props = {
  newestFirst: boolean;
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  queryState: import('./types').AnalysisQueryState;
};

type Result = {
  callsignGraph: NetJsonGraphAndMeta | null;
  callsignGraphLoading: boolean;
  callsignGraphLoadVersion: number;
  callsignGraphNolimit: boolean;
  correlatedFreqs: CorrelatedFreq[];
  correlatedFreqsLoading: boolean;
  counts: CountStatsRsp | null;
  countsLoading: boolean;
  aorEntries: AnalysisAorEntry[];
  filtersLoading: boolean;
  groupsActivityPeriod: AnalysisGroupsActivityPeriod;
  downloadGeojson: () => Promise<void>;
  downloadKmz: () => Promise<void>;
  downloadSummaryXlsx: () => Promise<void>;
  groupsActivity: FreqDailyActivityCount | null;
  groupsActivityLoadedFreq: string | null;
  groupsActivityLoadedPeriod: AnalysisGroupsActivityPeriod | null;
  groupsActivityLoading: boolean;
  inboxReq: ReturnType<typeof buildInboxReq>;
  loadCallsignGraph: () => Promise<void>;
  loadAllMessages: () => Promise<void>;
  toggleCallsignGraphNolimit: () => void;
  loadCorrelatedFreqs: () => Promise<void>;
  loadGroupsActivity: (period?: AnalysisGroupsActivityPeriod) => Promise<void>;
  loadMoreMessages: () => Promise<void>;
  loadMessagesForMap: (messageIds: number[]) => Promise<void>;
  mapAttrs: AnalysisMapAttrs;
  messageActionLoading: boolean;
  messagesLoading: boolean;
  messagesPaging: boolean;
  messages: Array<[number, InboxMessage]>;
  networkDisplayMap: Record<number, string>;
  networks: Network[];
  newCallsigns: NewCallsignsRes;
  newCallsignsLoading: boolean;
  noMoreToLoad: boolean;
  nolimitShown: boolean;
  onUpdateLocalMessage: (messageId: number, updater: (message: InboxMessage) => InboxMessage) => void;
  onDeleteMessage: (messageId: number) => Promise<void>;
  onSaveMessageComment: (messageId: number, comment: string | null) => Promise<void>;
  onToggleMessageBookmark: (messageId: number, currentlyBookmarked: boolean) => Promise<void>;
  onToggleMessageImportant: (messageId: number, currentlyImportant: boolean) => Promise<void>;
  onToggleMessageTag: (messageId: number, tagId: number) => Promise<void>;
  options: AnalysisFilterOptions;
  profiles: Record<string, SignalProfileEntry | null>;
  refreshMapDateRange: (range: { startDate: number; endDate: number }) => Promise<void>;
  reload: () => Promise<void>;
  summaryLoading: boolean;
  summaryRows: SummaryTableFreqRow[];
  summaryCallsignsInfo: Record<string, CallsignInfoRes>;
  unitsMap: Record<number, Unit>;
  tagsMap: Record<number, Tag>;
  topCallsigns: AnalysisCountItem[];
  topFreqs: AnalysisCountItem[];
  groupInfos: Record<string, SignalGroupEntry>;
  topLocations: AnalysisCountItem[];
  topUnits: AnalysisCountItem[];
  renameSummaryUnit: (freq: string, unit: string, unitNew: string) => Promise<void>;
};

function mergeCallsignInfoMap(
  prev: Record<string, CallsignInfoRes>,
  items: CallsignInfoRes[] | null | undefined,
  options?: { overwrite?: boolean },
): Record<string, CallsignInfoRes> {
  if (!items || items.length === 0) return prev;
  const overwrite = options?.overwrite ?? false;
  const next = { ...prev };
  items.forEach((item) => {
    const key = item.callsign.toLowerCase();
    if (overwrite || next[key] == null || (next[key].res?.length ?? 0) === 0) {
      next[key] = item;
    }
  });
  return next;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Сталася помилка під час завантаження аналізу.';
}

function topItems<T>(list: T[], getKey: (item: T) => string, getCount: (item: T) => number): AnalysisCountItem[] {
  return sortAndTakeTopAnalysisCountItems(list.map((item) => ({ key: getKey(item), count: getCount(item) })));
}

const emptyOptions: AnalysisFilterOptions = {
  aors: [],
  groups: [],
  senders: [],
  freqs: [],
  newFreqs: [],
  callsigns: [],
  units: [],
  locations: [],
  posts: [],
  networks: [],
  metadataCcs: [],
  metadataSenders: [],
  metadataReceivers: [],
  metadataHashes: [],
};

const emptyNewCallsigns: NewCallsignsRes = {
  notSeen24h: [],
  notSeen7days: [],
  notSeen30days: [],
};

export function useAnalysisData({ newestFirst, onError, onUnauthorized, queryState }: Props): Result {
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
  const [messageActionCount, setMessageActionCount] = useState(0);
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

  const invalidateCallsignGraph = useCallback(() => {
    callsignGraphRequestRef.current += 1;
    setCallsignGraph(null);
    setCallsignGraphLoading(false);
    setCallsignGraphLoadVersion((current) => current + 1);
  }, []);

  const invalidateMessagePaging = useCallback(() => {
    loadMoreMessagesRequestRef.current += 1;
    setMessagesPaging(false);
  }, []);

  const patchMessages = useCallback(
    (updater: (messageId: number, message: InboxMessage) => InboxMessage) => {
      const updateItems = (items: Array<[number, InboxMessage]>) =>
        items.map(([messageId, message]) => [messageId, updater(messageId, message)] as [number, InboxMessage]);

      setMessages((current) => updateItems(current));
      setMapOpenMessages((current) => updateItems(current));
    },
    [],
  );

  const clearAnalysisResults = useCallback(() => {
    setCounts(null);
    setMessages([]);
    setSummaryRows([]);
    setNewCallsigns(emptyNewCallsigns);
    setOptions(emptyOptions);
    setTopFreqs([]);
    setTopCallsigns([]);
    setTopUnits([]);
    setTopLocations([]);
    setAorEntries([]);
    setProfiles({});
    setGroupInfos({});
    setTagsMap({});
    setNetworks([]);
    setUnitsMap({});
    setNetworkDisplayMap({});
    setSummaryCallsignsInfo({});
    setMapDateRange({ startDate: 0, endDate: 0 });
    setMapPoints([]);
    setMapNetworkUnits([]);
    setMapOpenMessages([]);
    setCorrelatedFreqs([]);
    setGroupsActivity(null);
    setGroupsActivityLoadedFreq(null);
    setGroupsActivityLoadedPeriod(null);
    setNoMoreToLoad(false);
    setNolimitShown(false);
    optionsFreqsRef.current = [];
    invalidateCallsignGraph();
  }, [invalidateCallsignGraph]);

  const onUpdateLocalMessage = useCallback(
    (messageId: number, updater: (message: InboxMessage) => InboxMessage) => {
      patchMessages((id, message) => (id === messageId ? updater(message) : message));
    },
    [patchMessages],
  );

  const refreshMapDateRange = useCallback(
    async (range: { startDate: number; endDate: number }) => {
      const inboxReq = buildInboxReq(queryState, options.freqs);
      if (inboxReq == null) {
        return;
      }

      const loadVersion = mapDateRangeLoadVersionRef.current + 1;
      mapDateRangeLoadVersionRef.current = loadVersion;

      setMapLoading(true);
      setMapDateRange(range);

      try {
        const rsp = await fetchAnalysisMapPoints({
          inboxItemsFilter: {
            ...inboxReq,
            sinceDateInclusiveMs: range.startDate,
            tillDateInclusiveMs: range.endDate,
            newestFirst,
          },
          mapFilter: null,
          pageId: ANALYSIS_SESSION_ACTIVITY_PAGE_ID,
        });
        if (mapDateRangeLoadVersionRef.current !== loadVersion) {
          return;
        }

        setMapPoints(rsp.points ?? []);
        setMapNetworkUnits(rsp.networkUnits ?? []);
      } catch (loadError) {
        if (mapDateRangeLoadVersionRef.current !== loadVersion) {
          return;
        }

        if (!onUnauthorized(loadError)) {
          onError(toErrorMessage(loadError));
        }
      } finally {
        if (mapDateRangeLoadVersionRef.current === loadVersion) {
          setMapLoading(false);
        }
      }
    },
    [newestFirst, onError, onUnauthorized, options.freqs, queryState],
  );

  const loadMessagesForMap = useCallback(
    async (messageIds: number[]) => {
      const loadVersion = mapMessagesLoadVersionRef.current + 1;
      mapMessagesLoadVersionRef.current = loadVersion;

      try {
        const nextMessages = await fetchMessagesByIds(messageIds);
        if (mapMessagesLoadVersionRef.current !== loadVersion) {
          return;
        }

        setMapOpenMessages(nextMessages);
      } catch (loadError) {
        if (mapMessagesLoadVersionRef.current !== loadVersion) {
          return;
        }

        if (!onUnauthorized(loadError)) {
          onError(toErrorMessage(loadError));
        }
      }
    },
    [onError, onUnauthorized],
  );

  const loadMapPalitras = useCallback(async () => {
    setMapPalitrasLoadState('loading');
    setMapPalitrasLoaded(false);

    try {
      const palitras = await listPalitrasV2();
      setMapPalitras(
        palitras.map((palitraRead) => ({
          ...palitraRead,
          geometries: palitraRead.geometries.map((geometry) => ({
            ...geometry,
            points: [],
          })),
        })),
      );
      setMapPalitrasLoaded(true);
      setMapPalitrasLoadState('success');
    } catch (loadError) {
      if (!onUnauthorized(loadError)) {
        onError(`Не вдалося завантажити палітри: ${toErrorMessage(loadError)}`);
      }
      setMapPalitras([]);
      setMapPalitrasLoaded(false);
      setMapPalitrasLoadState('error');
    }
  }, [onError, onUnauthorized]);

  const onToggleMessageBookmark = useCallback(
    async (messageId: number, currentlyBookmarked: boolean) => {
      setMessageActionCount((current) => current + 1);
      try {
        if (currentlyBookmarked) {
          await bookmarkRemove({ messageId });
        } else {
          await bookmarkAdd({ messageId });
        }

        patchMessages((id, message) => (id === messageId ? { ...message, bookmarked: !currentlyBookmarked } : message));
      } catch (loadError) {
        if (!onUnauthorized(loadError)) {
          onError(toErrorMessage(loadError));
        }
      } finally {
        setMessageActionCount((current) => Math.max(0, current - 1));
      }
    },
    [onError, onUnauthorized, patchMessages],
  );

  const onToggleMessageImportant = useCallback(
    async (messageId: number, currentlyImportant: boolean) => {
      setMessageActionCount((current) => current + 1);
      try {
        if (currentlyImportant) {
          await importantRemove({ messageId });
        } else {
          await importantAdd({ messageId });
        }

        patchMessages((id, message) => (id === messageId ? { ...message, important: !currentlyImportant } : message));
      } catch (loadError) {
        if (!onUnauthorized(loadError)) {
          onError(toErrorMessage(loadError));
        }
      } finally {
        setMessageActionCount((current) => Math.max(0, current - 1));
      }
    },
    [onError, onUnauthorized, patchMessages],
  );

  const onSaveMessageComment = useCallback(
    async (messageId: number, comment: string | null) => {
      setMessageActionCount((current) => current + 1);
      try {
        await commentSave({ messageId, comment });

        patchMessages((id, message) => (id === messageId ? { ...message, extendedForm: comment } : message));
      } catch (loadError) {
        if (!onUnauthorized(loadError)) {
          onError(toErrorMessage(loadError));
        }
      } finally {
        setMessageActionCount((current) => Math.max(0, current - 1));
      }
    },
    [onError, onUnauthorized, patchMessages],
  );

  const onToggleMessageTag = useCallback(
    async (messageId: number, tagId: number) => {
      const sourceMessage =
        messages.find(([id]) => id === messageId)?.[1] ?? mapOpenMessages.find(([id]) => id === messageId)?.[1] ?? null;
      if (sourceMessage == null) return;

      const enabled = getMessageTagEnabled(sourceMessage, tagId);

      setMessageActionCount((current) => current + 1);
      try {
        if (enabled) {
          await inboxMessageTagsRm({ messageId, tagId });
        } else {
          await inboxMessageTagsAdd({ messageId, tagId });
        }

        patchMessages((id, message) => {
          if (id !== messageId) return message;

          const currentTags = message.tags ?? [];
          const currentInboxTags = message.inboxTags ?? [];
          const nextTags = enabled ? currentTags.filter((value) => value !== tagId) : [...currentTags, tagId];
          const nextInboxTags: InboxMessageTag[] = enabled
            ? currentInboxTags.filter((tag) => tag.tagId !== tagId)
            : [
                ...currentInboxTags,
                {
                  id: 0,
                  tagId,
                  confidence: 1,
                  login: null,
                  model: null,
                  organismId: null,
                },
              ];

          return {
            ...message,
            tags: nextTags,
            inboxTags: nextInboxTags,
          };
        });
      } catch (loadError) {
        if (!onUnauthorized(loadError)) {
          onError(toErrorMessage(loadError));
        }
      } finally {
        setMessageActionCount((current) => Math.max(0, current - 1));
      }
    },
    [mapOpenMessages, messages, onError, onUnauthorized, patchMessages],
  );

  const loadCorrelatedFreqs = useCallback(async () => {
    const analysisReq = buildAnalysisReq(queryState, options.freqs);
    if (analysisReq == null || queryState.freqsSelected.length === 0) {
      setCorrelatedFreqs([]);
      return;
    }

    setCorrelatedFreqsLoading(true);
    try {
      const rsp = await fetchAnalysisCorrelatedFreqs(analysisReq);
      setCorrelatedFreqs(rsp.freqs ?? []);
    } catch (loadError) {
      if (!onUnauthorized(loadError)) {
        onError(toErrorMessage(loadError));
      }
    } finally {
      setCorrelatedFreqsLoading(false);
    }
  }, [onError, onUnauthorized, options.freqs, queryState]);

  const loadCallsignGraph = useCallback(async () => {
    const analysisReq = buildAnalysisReq(queryState, options.freqs);
    if (analysisReq == null) {
      return;
    }

    const requestId = callsignGraphRequestRef.current + 1;
    callsignGraphRequestRef.current = requestId;
    setCallsignGraphLoading(true);
    try {
      const rsp = await fetchAnalysisCallsignGraph({
        ...analysisReq,
        nolimit: callsignGraphNolimit,
      });
      if (requestId !== callsignGraphRequestRef.current) return;
      setCallsignGraph(rsp);
    } catch (loadError) {
      if (requestId !== callsignGraphRequestRef.current) return;
      if (!onUnauthorized(loadError)) {
        onError(toErrorMessage(loadError));
      }
    } finally {
      if (requestId !== callsignGraphRequestRef.current) return;
      setCallsignGraphLoading(false);
    }
  }, [callsignGraphNolimit, onError, onUnauthorized, options.freqs, queryState]);

  const toggleCallsignGraphNolimit = useCallback(() => {
    invalidateCallsignGraph();
    setCallsignGraphNolimit((current) => !current);
  }, [invalidateCallsignGraph]);

  const loadGroupsActivity = useCallback(async (period?: AnalysisGroupsActivityPeriod) => {
    const analysisReq = buildAnalysisReq(queryState, options.freqs);
    const firstFreq = queryState.freqsSelected[0];
    if (analysisReq == null || !firstFreq) {
      setGroupsActivity(null);
      setGroupsActivityLoadedFreq(null);
      setGroupsActivityLoadedPeriod(null);
      return;
    }

    const nextPeriod = period ?? groupsActivityPeriod;
    const tillDateInclusiveMs = analysisReq.tillDateNoninclusiveMs;
    const dayMs = 24 * 60 * 60 * 1000;
    const sinceDateInclusiveMs =
      nextPeriod === 'month'
        ? tillDateInclusiveMs - 30 * dayMs
        : nextPeriod === 'quarter'
          ? tillDateInclusiveMs - 90 * dayMs
          : nextPeriod === 'year'
            ? tillDateInclusiveMs - 365 * dayMs
            : analysisReq.sinceDateInclusiveMs;

    setGroupsActivityLoading(true);
    setGroupsActivityPeriod(nextPeriod);
    try {
      const rsp = await fetchFreqActivityDaily({
        freq: firstFreq,
        sinceDateInclusiveMs,
        tillDateInclusiveMs,
      });
      setGroupsActivity(rsp);
      setGroupsActivityLoadedFreq(firstFreq);
      setGroupsActivityLoadedPeriod(nextPeriod);
    } catch (loadError) {
      if (!onUnauthorized(loadError)) {
        onError(toErrorMessage(loadError));
      }
    } finally {
      setGroupsActivityLoading(false);
    }
  }, [groupsActivityPeriod, onError, onUnauthorized, options.freqs, queryState]);

  const downloadSummaryXlsx = useCallback(async () => {
    const analysisReq = buildAnalysisReq(queryState, options.freqs);
    if (analysisReq == null) {
      onError('Перевірте дату та час перед експортом.');
      return;
    }

    try {
      const blob = await downloadAnalysisSummaryTableXlsx(analysisReq);
      downloadBlob(blob, 'rer-analysis-summary.xlsx');
    } catch (loadError) {
      if (!onUnauthorized(loadError)) {
        onError(toErrorMessage(loadError));
      }
    }
  }, [onError, onUnauthorized, options.freqs, queryState]);

  const downloadKmz = useCallback(async () => {
    const analysisReq = buildAnalysisReq(queryState, options.freqs);
    if (analysisReq == null) {
      onError('Перевірте дату та час перед експортом.');
      return;
    }

    try {
      const blob = await downloadAnalysisKmz(analysisReq);
      downloadBlob(blob, 'rer-analysis.kmz');
    } catch (loadError) {
      if (!onUnauthorized(loadError)) {
        onError(toErrorMessage(loadError));
      }
    }
  }, [onError, onUnauthorized, options.freqs, queryState]);

  const downloadGeojson = useCallback(async () => {
    const analysisReq = buildAnalysisReq(queryState, options.freqs);
    if (analysisReq == null) {
      onError('Перевірте дату та час перед експортом.');
      return;
    }

    try {
      const blob = await downloadAnalysisGeojson(analysisReq);
      downloadBlob(blob, 'rer-analysis.geojson');
    } catch (loadError) {
      if (!onUnauthorized(loadError)) {
        onError(toErrorMessage(loadError));
      }
    }
  }, [onError, onUnauthorized, options.freqs, queryState]);

  const renameSummaryUnit = useCallback(
    async (freq: string, unit: string, unitNew: string) => {
      const analysisReq = buildAnalysisReq(queryState, options.freqs);
      if (analysisReq == null) {
        onError('Перевірте дату та час перед збереженням підрозділу.');
        return;
      }

      try {
        await editAnalysisFreqUnitName({
          analysisStatsReq: analysisReq,
          freq,
          unit,
          unitNew,
          search: queryState.search.trim() || null,
          filterTagsOption: queryState.filterTagsOption,
          reportTagsOnlyThisUnit: queryState.reportTagsOnlyThisUnit,
        });
        setSummaryRows((current) =>
          current.map((row) =>
            row.freq === freq
              ? {
                  ...row,
                  units: Array.from(new Set(row.units.map((value) => (value === unit ? unitNew : value)))),
                }
              : row,
          ),
        );
      } catch (loadError) {
        if (!onUnauthorized(loadError)) {
          onError(toErrorMessage(loadError));
        }
      }
    },
    [newestFirst, onError, onUnauthorized, options.freqs, queryState],
  );

  const reload = useCallback(async () => {
    const requestId = reloadRequestRef.current + 1;
    reloadRequestRef.current = requestId;
    const isStaleReload = () => requestId !== reloadRequestRef.current;
    let startedSecondaryLoads = false;

    onError('');
    invalidateMessagePaging();
    setCountsLoading(true);
    setMessagesLoading(true);
    setFiltersLoading(true);
    setSummaryLoading(true);
    setNewCallsignsLoading(true);
    setMapLoading(true);
    setNoMoreToLoad(false);
    setNolimitShown(false);

    try {
      const loadCriticalData = async (
        allFrequencies: string[],
      ): Promise<
        | {
            analysisReq: NonNullable<ReturnType<typeof buildAnalysisReq>>;
            inboxReq: NonNullable<ReturnType<typeof buildInboxReq>>;
            inboxRsp: Awaited<ReturnType<typeof fetchInboxMessages>>;
            freqsRsp: Awaited<ReturnType<typeof fetchAnalysisFreqs>>;
          }
        | null
      > => {
        const analysisReq = buildAnalysisReq(queryState, allFrequencies);
        const inboxReq = buildInboxReq(queryState, allFrequencies);

        if (analysisReq == null || inboxReq == null) {
          clearAnalysisResults();
          return null;
        }

        const [nextCounts, inboxRsp, freqsRsp] = await Promise.all([
          fetchAnalysisCount(analysisReq),
          fetchInboxMessages({ ...inboxReq, newestFirst }),
          fetchAnalysisFreqs(analysisReq),
        ]);
        if (isStaleReload()) {
          return null;
        }

        const nextFrequencies = freqsRsp.freqs.map((item) => item.freq);
        if (shouldRebuildAnalysisRequests(queryState, allFrequencies, nextFrequencies)) {
          optionsFreqsRef.current = nextFrequencies;
          return loadCriticalData(nextFrequencies);
        }

        setCounts(nextCounts);
        setMessages(inboxRsp.inboxItems ?? []);
        setSummaryCallsignsInfo((current) => mergeCallsignInfoMap(current, inboxRsp.callsigns, { overwrite: true }));
        setOptions({
          ...emptyOptions,
          freqs: sortFrequenciesNumerically(nextFrequencies),
          newFreqs: sortFrequenciesNumerically(freqsRsp.freqs.filter((item) => item.isNew).map((item) => item.freq)),
        });
        setTopFreqs(topItems(freqsRsp.freqs, (item) => item.freq, (item) => item.count));
        setMapDateRange({
          startDate: inboxReq.sinceDateInclusiveMs ?? 0,
          endDate: inboxReq.tillDateInclusiveMs ?? 0,
        });
        invalidateCallsignGraph();
        pushQueryStateToUrl(queryState);

        return {
          analysisReq,
          inboxReq,
          inboxRsp,
          freqsRsp,
        };
      };

      const criticalData = await loadCriticalData(optionsFreqsRef.current);
      if (criticalData == null || isStaleReload()) {
        return;
      }

      optionsFreqsRef.current = criticalData.freqsRsp.freqs.map((item) => item.freq);

      setCountsLoading(false);
      setMessagesLoading(false);

      const loadFilterData = async () => {
        const inboxItems = criticalData.inboxRsp.inboxItems ?? [];

        try {
          const [
            groupsRsp,
            sendersRsp,
            callsignsRsp,
            unitsRsp,
            locationsRsp,
            postsRsp,
            networksRsp,
            aorsRsp,
            metadataRsp,
            tagsRsp,
            tagsDisplayMap,
            senderProfilesRsp,
          ] = await Promise.all([
            fetchAnalysisGroups(criticalData.analysisReq),
            fetchAnalysisSenders(criticalData.analysisReq),
            fetchAnalysisCallsigns(criticalData.analysisReq),
            fetchAnalysisUnits(criticalData.analysisReq),
            fetchAnalysisLocations(criticalData.analysisReq),
            fetchAnalysisPosts(criticalData.analysisReq),
            fetchAnalysisNetworks(criticalData.analysisReq),
            fetchAnalysisAors(criticalData.analysisReq),
            fetchAnalysisMetadata(criticalData.analysisReq),
            fetchAnalysisTags(criticalData.analysisReq),
            getTagsMapForDisplay(),
            getLatestSenders(),
          ]);
          if (isStaleReload()) {
            return;
          }

          const groupInfosByKey: Record<string, SignalGroupEntry> = {};
          groupsRsp.groupNames.forEach((item) => {
            groupInfosByKey[item.masterKey] = item;
          });

          setOptions((current) => ({
            ...current,
            aors: sortStringsAlphabetically(aorsRsp.aors.map((item) => String(item.aorId))),
            groups: groupsRsp.groups.map((item) => item.masterKey),
            senders: sortStringsAlphabetically(sendersRsp.senders.map((item) => item.uuid)),
            callsigns: sortStringsAlphabetically(callsignsRsp.callsigns.map((item) => item.callsign)),
            units: sortStringsAlphabetically(unitsRsp.units.map((item) => item.unit)),
            locations: sortStringsAlphabetically(locationsRsp.locations.map((item) => item.location)),
            posts: sortStringsAlphabetically(postsRsp.posts.map((item) => item.post)),
            networks: sortStringsAlphabetically(networksRsp.networks.map((item) => String(item.networkId))),
            metadataCcs: sortStringsAlphabetically(metadataRsp.ccs.map((item) => item.value)),
            metadataSenders: sortStringsAlphabetically(metadataRsp.senders.map((item) => item.value)),
            metadataReceivers: sortStringsAlphabetically(metadataRsp.receivers.map((item) => item.value)),
            metadataHashes: sortStringsAlphabetically(metadataRsp.hashes.map((item) => item.value)),
          }));
          setGroupInfos((current) => ({ ...current, ...groupInfosByKey }));
          setAorEntries((aorsRsp.aorNames ?? []).map((item) => ({ id: item.id, name: item.name })));
          setProfiles(senderProfilesRsp.data ?? {});
          setTagsMap(
            Object.fromEntries(
              Object.entries(tagsDisplayMap).filter(([tagId]) =>
                tagsRsp.tags.some((item) => String(item.tagId) === tagId),
              ),
            ),
          );
          setTopCallsigns(topItems(callsignsRsp.callsigns, (item) => item.callsign, (item) => item.count));
          setTopUnits(topItems(unitsRsp.units, (item) => item.unit, (item) => item.count));
          setTopLocations(topItems(locationsRsp.locations, (item) => item.location, (item) => item.count));

          const messageGroupKeys = Array.from(
            new Set(
              inboxItems.map(([, message]) => message.groupMasterKey).filter((value): value is string => Boolean(value)),
            ),
          );
          const messageNetworkIds = Array.from(new Set(inboxItems.flatMap(([, message]) => message.networkIds ?? [])));
          const analysisNetworkIds = Array.from(new Set(networksRsp.networks.map((item) => item.networkId)));
          const allNetworkIds = Array.from(new Set([...messageNetworkIds, ...analysisNetworkIds]));
          const [groupInfosRsp, networksRspById, callsignInfosRsp] = await Promise.all([
            messageGroupKeys.length > 0 ? getGroupInfosBatch(messageGroupKeys) : Promise.resolve([]),
            allNetworkIds.length > 0 ? fetchNetworksByIds(allNetworkIds) : Promise.resolve([] as Network[]),
            callsignsRsp.callsigns.length > 0
              ? fetchAnalysisCallsignInfos(callsignsRsp.callsigns.map((item) => item.callsign))
              : Promise.resolve([] as CallsignInfoRes[]),
          ]);
          if (isStaleReload()) {
            return;
          }

          const unitIds = Array.from(new Set(networksRspById.flatMap((network) => network.unitIds ?? [])));
          const unitsRspById = unitIds.length > 0 ? await fetchUnitsByIds({ ids: unitIds }) : { units: [] };
          if (isStaleReload()) {
            return;
          }

          const nextGroupInfos: Record<string, SignalGroupEntry> = { ...groupInfosByKey };
          groupInfosRsp.forEach((item) => {
            nextGroupInfos[item.masterKey] = item;
          });
          const nextUnitsMap: Record<number, Unit> = {};
          unitsRspById.units.forEach((unit) => {
            nextUnitsMap[unit.id] = unit;
          });
          let nextSummaryCallsignsInfo: Record<string, CallsignInfoRes> = {};
          nextSummaryCallsignsInfo = mergeCallsignInfoMap(nextSummaryCallsignsInfo, criticalData.inboxRsp.callsigns, {
            overwrite: true,
          });
          nextSummaryCallsignsInfo = mergeCallsignInfoMap(nextSummaryCallsignsInfo, callsignInfosRsp);

          setGroupInfos(nextGroupInfos);
          setNetworks(networksRspById);
          setUnitsMap(nextUnitsMap);
          setNetworkDisplayMap(buildNetworkDisplayMap(networksRspById, nextUnitsMap));
          setSummaryCallsignsInfo(nextSummaryCallsignsInfo);
        } catch (loadError) {
          if (isStaleReload()) {
            return;
          }
          if (!onUnauthorized(loadError)) {
            onError(toErrorMessage(loadError));
          }
        } finally {
          if (!isStaleReload()) {
            setFiltersLoading(false);
          }
        }
      };

      const loadSummaryData = async () => {
        try {
          const summaryRsp = await fetchAnalysisSummaryTable(criticalData.analysisReq);
          if (isStaleReload()) {
            return;
          }
          setSummaryRows(summaryRsp.rows ?? []);
        } catch (loadError) {
          if (isStaleReload()) {
            return;
          }
          if (!onUnauthorized(loadError)) {
            onError(toErrorMessage(loadError));
          }
        } finally {
          if (!isStaleReload()) {
            setSummaryLoading(false);
          }
        }
      };

      const loadNewCallsignsData = async () => {
        try {
          const newCallsignsRsp = await fetchAnalysisNewCallsigns(criticalData.analysisReq);
          if (isStaleReload()) {
            return;
          }
          setNewCallsigns(newCallsignsRsp);
        } catch (loadError) {
          if (isStaleReload()) {
            return;
          }
          if (!onUnauthorized(loadError)) {
            onError(toErrorMessage(loadError));
          }
        } finally {
          if (!isStaleReload()) {
            setNewCallsignsLoading(false);
          }
        }
      };

      const loadMapData = async () => {
        try {
          const mapRsp = await fetchAnalysisMapPoints({
            inboxItemsFilter: criticalData.inboxReq,
            mapFilter: null,
            pageId: ANALYSIS_SESSION_ACTIVITY_PAGE_ID,
          });
          if (isStaleReload()) {
            return;
          }
          setMapPoints(mapRsp.points ?? []);
          setMapNetworkUnits(mapRsp.networkUnits ?? []);
          setMapOpenMessages([]);
        } catch (loadError) {
          if (isStaleReload()) {
            return;
          }
          if (!onUnauthorized(loadError)) {
            onError(toErrorMessage(loadError));
          }
        } finally {
          if (!isStaleReload()) {
            setMapLoading(false);
          }
        }
      };

      startedSecondaryLoads = true;
      void Promise.all([loadFilterData(), loadSummaryData(), loadNewCallsignsData(), loadMapData()]);
    } catch (loadError) {
      if (isStaleReload()) {
        return;
      }
      if (!onUnauthorized(loadError)) {
        onError(toErrorMessage(loadError));
      }
    } finally {
      if (!isStaleReload()) {
        setCountsLoading(false);
        setMessagesLoading(false);
        if (!startedSecondaryLoads) {
          setFiltersLoading(false);
          setSummaryLoading(false);
          setNewCallsignsLoading(false);
          setMapLoading(false);
        }
      }
    }
  }, [clearAnalysisResults, invalidateCallsignGraph, invalidateMessagePaging, newestFirst, onError, onUnauthorized, queryState]);

  const loadAllMessages = useCallback(async () => {
    const inboxReq = buildInboxReq(queryState, options.freqs);
    if (inboxReq == null) return;

    setMessagesPaging(true);
    try {
      const rsp = await fetchInboxMessages({ ...inboxReq, nolimit: true, newestFirst });
      setMessages(rsp.inboxItems ?? []);
      setSummaryCallsignsInfo((current) => mergeCallsignInfoMap(current, rsp.callsigns, { overwrite: true }));
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

  const onDeleteMessage = useCallback(
    async (messageId: number) => {
      setMessageActionCount((current) => current + 1);
      try {
        await deleteMessage({ id: messageId });
        setMessages((current) => current.filter(([id]) => id !== messageId));
        setMapOpenMessages((current) => current.filter(([id]) => id !== messageId));
        await reload();
      } catch (loadError) {
        if (!onUnauthorized(loadError)) {
          onError(toErrorMessage(loadError));
        }
      } finally {
        setMessageActionCount((current) => Math.max(0, current - 1));
      }
    },
    [onError, onUnauthorized, reload],
  );

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
      setSummaryCallsignsInfo((current) => mergeCallsignInfoMap(current, rsp.callsigns, { overwrite: true }));
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
