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
import { buildAnalysisReq, buildInboxReq, pushQueryStateToUrl } from './helpers';
import { buildMapAttrs } from './helpers-map';
import { buildNetworkDisplayMap, getMessageTagEnabled } from './message-utils';
import { downloadBlob } from '../../utils/download';
import type {
  AnalysisAorEntry,
  AnalysisCountItem,
  AnalysisFilterOptions,
  AnalysisGroupsActivityPeriod,
  AnalysisMapAttrs,
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
  callsignGraphNolimit: boolean;
  correlatedFreqs: CorrelatedFreq[];
  correlatedFreqsLoading: boolean;
  counts: CountStatsRsp | null;
  aorEntries: AnalysisAorEntry[];
  groupsActivityPeriod: AnalysisGroupsActivityPeriod;
  downloadGeojson: () => Promise<void>;
  downloadKmz: () => Promise<void>;
  downloadSummaryXlsx: () => Promise<void>;
  groupsActivity: FreqDailyActivityCount | null;
  groupsActivityLoading: boolean;
  inboxReq: ReturnType<typeof buildInboxReq>;
  loading: boolean;
  loadCallsignGraph: () => Promise<void>;
  loadAllMessages: () => Promise<void>;
  toggleCallsignGraphNolimit: () => void;
  loadCorrelatedFreqs: () => Promise<void>;
  loadGroupsActivity: (period?: AnalysisGroupsActivityPeriod) => Promise<void>;
  loadMoreMessages: () => Promise<void>;
  loadMessagesForMap: (messageIds: number[]) => Promise<void>;
  mapAttrs: AnalysisMapAttrs;
  messages: Array<[number, InboxMessage]>;
  networkDisplayMap: Record<number, string>;
  networks: Network[];
  newCallsigns: NewCallsignsRes;
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

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Сталася помилка під час завантаження аналізу.';
}

function topItems<T>(list: T[], getKey: (item: T) => string, getCount: (item: T) => number): AnalysisCountItem[] {
  return list.slice(0, 12).map((item) => ({ key: getKey(item), count: getCount(item) }));
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
  const [loading, setLoading] = useState(false);
  const [counts, setCounts] = useState<CountStatsRsp | null>(null);
  const [aorEntries, setAorEntries] = useState<AnalysisAorEntry[]>([]);
  const [messages, setMessages] = useState<Array<[number, InboxMessage]>>([]);
  const [summaryRows, setSummaryRows] = useState<SummaryTableFreqRow[]>([]);
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
  const [correlatedFreqs, setCorrelatedFreqs] = useState<CorrelatedFreq[]>([]);
  const [correlatedFreqsLoading, setCorrelatedFreqsLoading] = useState(false);
  const [callsignGraph, setCallsignGraph] = useState<NetJsonGraphAndMeta | null>(null);
  const [callsignGraphLoading, setCallsignGraphLoading] = useState(false);
  const [callsignGraphNolimit, setCallsignGraphNolimit] = useState(false);
  const [groupsActivity, setGroupsActivity] = useState<FreqDailyActivityCount | null>(null);
  const [groupsActivityLoading, setGroupsActivityLoading] = useState(false);
  const [groupsActivityPeriod, setGroupsActivityPeriod] = useState<AnalysisGroupsActivityPeriod>('selected');
  const [profiles, setProfiles] = useState<Record<string, SignalProfileEntry | null>>({});
  const [groupInfos, setGroupInfos] = useState<Record<string, SignalGroupEntry>>({});
  const [tagsMap, setTagsMap] = useState<Record<number, Tag>>({});
  const [networkDisplayMap, setNetworkDisplayMap] = useState<Record<number, string>>({});
  const [networks, setNetworks] = useState<Network[]>([]);
  const [summaryCallsignsInfo, setSummaryCallsignsInfo] = useState<Record<string, CallsignInfoRes>>({});
  const [unitsMap, setUnitsMap] = useState<Record<number, Unit>>({});
  const optionsFreqsRef = useRef<string[]>([]);

  useEffect(() => {
    optionsFreqsRef.current = options.freqs;
  }, [options.freqs]);

  const patchMessages = useCallback(
    (updater: (messageId: number, message: InboxMessage) => InboxMessage) => {
      const updateItems = (items: Array<[number, InboxMessage]>) =>
        items.map(([messageId, message]) => [messageId, updater(messageId, message)] as [number, InboxMessage]);

      setMessages((current) => updateItems(current));
      setMapOpenMessages((current) => updateItems(current));
    },
    [],
  );

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
          pageId: 'rer-analysis',
        });
        setMapPoints(rsp.points ?? []);
        setMapNetworkUnits(rsp.networkUnits ?? []);
      } catch (loadError) {
        if (!onUnauthorized(loadError)) {
          onError(toErrorMessage(loadError));
        }
      } finally {
        setMapLoading(false);
      }
    },
    [newestFirst, onError, onUnauthorized, options.freqs, queryState],
  );

  const loadMessagesForMap = useCallback(
    async (messageIds: number[]) => {
      try {
        const nextMessages = await fetchMessagesByIds(messageIds);
        setMapOpenMessages(nextMessages);
      } catch (loadError) {
        if (!onUnauthorized(loadError)) {
          onError(toErrorMessage(loadError));
        }
      }
    },
    [onError, onUnauthorized],
  );

  const onToggleMessageBookmark = useCallback(
    async (messageId: number, currentlyBookmarked: boolean) => {
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
      }
    },
    [onError, onUnauthorized, patchMessages],
  );

  const onToggleMessageImportant = useCallback(
    async (messageId: number, currentlyImportant: boolean) => {
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
      }
    },
    [onError, onUnauthorized, patchMessages],
  );

  const onSaveMessageComment = useCallback(
    async (messageId: number, comment: string | null) => {
      try {
        await commentSave({ messageId, comment });

        patchMessages((id, message) => (id === messageId ? { ...message, extendedForm: comment } : message));
      } catch (loadError) {
        if (!onUnauthorized(loadError)) {
          onError(toErrorMessage(loadError));
        }
      }
    },
    [onError, onUnauthorized, patchMessages],
  );

  const onDeleteMessage = useCallback(
    async (messageId: number) => {
      try {
        await deleteMessage({ id: messageId });
        setMessages((current) => current.filter(([id]) => id !== messageId));
        setMapOpenMessages((current) => current.filter(([id]) => id !== messageId));
      } catch (loadError) {
        if (!onUnauthorized(loadError)) {
          onError(toErrorMessage(loadError));
        }
      }
    },
    [onError, onUnauthorized],
  );

  const onToggleMessageTag = useCallback(
    async (messageId: number, tagId: number) => {
      const sourceMessage =
        messages.find(([id]) => id === messageId)?.[1] ?? mapOpenMessages.find(([id]) => id === messageId)?.[1] ?? null;
      if (sourceMessage == null) return;

      const enabled = getMessageTagEnabled(sourceMessage, tagId);

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

    setCallsignGraphLoading(true);
    try {
      const rsp = await fetchAnalysisCallsignGraph({
        ...analysisReq,
        nolimit: callsignGraphNolimit,
      });
      setCallsignGraph(rsp);
    } catch (loadError) {
      if (!onUnauthorized(loadError)) {
        onError(toErrorMessage(loadError));
      }
    } finally {
      setCallsignGraphLoading(false);
    }
  }, [callsignGraphNolimit, onError, onUnauthorized, options.freqs, queryState]);

  const toggleCallsignGraphNolimit = useCallback(() => {
    setCallsignGraphNolimit((current) => !current);
  }, []);

  const loadGroupsActivity = useCallback(async (period?: AnalysisGroupsActivityPeriod) => {
    const analysisReq = buildAnalysisReq(queryState, options.freqs);
    const firstFreq = queryState.freqsSelected[0];
    if (analysisReq == null || !firstFreq) {
      setGroupsActivity(null);
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
          filterTagsOption: null,
          reportTagsOnlyThisUnit: false,
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
    const allFrequencies = optionsFreqsRef.current;
    const analysisReq = buildAnalysisReq(queryState, allFrequencies);
    const inboxReq = buildInboxReq(queryState, allFrequencies);

    if (analysisReq == null || inboxReq == null) {
      return;
    }

    setLoading(true);
    onError('');

    try {
      const [
        nextCounts,
        inboxRsp,
        groupsRsp,
        sendersRsp,
        freqsRsp,
        callsignsRsp,
        unitsRsp,
        locationsRsp,
        postsRsp,
        networksRsp,
        aorsRsp,
        metadataRsp,
        summaryRsp,
        newCallsignsRsp,
        mapRsp,
        tagsRsp,
        tagsDisplayMap,
        senderProfilesRsp,
      ] = await Promise.all([
        fetchAnalysisCount(analysisReq),
        fetchInboxMessages({ ...inboxReq, newestFirst }),
        fetchAnalysisGroups(analysisReq),
        fetchAnalysisSenders(analysisReq),
        fetchAnalysisFreqs(analysisReq),
        fetchAnalysisCallsigns(analysisReq),
        fetchAnalysisUnits(analysisReq),
        fetchAnalysisLocations(analysisReq),
        fetchAnalysisPosts(analysisReq),
        fetchAnalysisNetworks(analysisReq),
        fetchAnalysisAors(analysisReq),
        fetchAnalysisMetadata(analysisReq),
        fetchAnalysisSummaryTable(analysisReq),
        fetchAnalysisNewCallsigns(analysisReq),
        fetchAnalysisMapPoints({
          inboxItemsFilter: inboxReq,
          mapFilter: null,
          pageId: 'rer-analysis',
        }),
        fetchAnalysisTags(analysisReq),
        getTagsMapForDisplay(),
        getLatestSenders(),
      ]);

      const messageGroupKeys = Array.from(
        new Set(inboxRsp.inboxItems.map(([, message]) => message.groupMasterKey).filter((value): value is string => Boolean(value))),
      );
      const messageNetworkIds = Array.from(
        new Set(inboxRsp.inboxItems.flatMap(([, message]) => message.networkIds ?? [])),
      );
      const analysisNetworkIds = Array.from(new Set(networksRsp.networks.map((item) => item.networkId)));
      const allNetworkIds = Array.from(new Set([...messageNetworkIds, ...analysisNetworkIds]));
      const [groupInfosRsp, networksRspById, callsignInfosRsp] = await Promise.all([
        messageGroupKeys.length > 0 ? getGroupInfosBatch(messageGroupKeys) : Promise.resolve([]),
        allNetworkIds.length > 0 ? fetchNetworksByIds(allNetworkIds) : Promise.resolve([] as Network[]),
        callsignsRsp.callsigns.length > 0
          ? fetchAnalysisCallsignInfos(callsignsRsp.callsigns.map((item) => item.callsign))
          : Promise.resolve([] as CallsignInfoRes[]),
      ]);
      const unitIds = Array.from(new Set(networksRspById.flatMap((network) => network.unitIds ?? [])));
      const unitsRspById = unitIds.length > 0 ? await fetchUnitsByIds({ ids: unitIds }) : { units: [] };

      const nextGroupInfos: Record<string, SignalGroupEntry> = {};
      groupInfosRsp.forEach((item) => {
        nextGroupInfos[item.masterKey] = item;
      });
      const unitsMap: Record<number, Unit> = {};
      unitsRspById.units.forEach((unit) => {
        unitsMap[unit.id] = unit;
      });
      const nextSummaryCallsignsInfo: Record<string, CallsignInfoRes> = {};
      callsignInfosRsp.forEach((item) => {
        nextSummaryCallsignsInfo[item.callsign.toLowerCase()] = item;
      });

      setCounts(nextCounts);
      setMessages(inboxRsp.inboxItems ?? []);
      setNoMoreToLoad(false);
      setNolimitShown(false);
      setOptions({
        aors: aorsRsp.aors.map((item) => String(item.aorId)),
        groups: groupsRsp.groupNames.map((item) => item.name),
        senders: sendersRsp.senders.map((item) => item.uuid),
        freqs: freqsRsp.freqs.map((item) => item.freq),
        newFreqs: freqsRsp.freqs.filter((item) => item.isNew).map((item) => item.freq),
        callsigns: callsignsRsp.callsigns.map((item) => item.callsign),
        units: unitsRsp.units.map((item) => item.unit),
        locations: locationsRsp.locations.map((item) => item.location),
        posts: postsRsp.posts.map((item) => item.post),
        networks: networksRsp.networks.map((item) => String(item.networkId)),
        metadataCcs: metadataRsp.ccs.map((item) => item.value),
        metadataSenders: metadataRsp.senders.map((item) => item.value),
        metadataReceivers: metadataRsp.receivers.map((item) => item.value),
        metadataHashes: metadataRsp.hashes.map((item) => item.value),
      });
      setAorEntries((aorsRsp.aorNames ?? []).map((item) => ({ id: item.id, name: item.name })));
      setProfiles(senderProfilesRsp.data ?? {});
      setGroupInfos(nextGroupInfos);
      setTagsMap(
        Object.fromEntries(
          Object.entries(tagsDisplayMap).filter(([tagId]) =>
            tagsRsp.tags.some((item) => String(item.tagId) === tagId),
          ),
        ),
      );
      setNetworks(networksRspById);
      setUnitsMap(unitsMap);
      setNetworkDisplayMap(buildNetworkDisplayMap(networksRspById, unitsMap));
      setSummaryCallsignsInfo(nextSummaryCallsignsInfo);
      setTopFreqs(topItems(freqsRsp.freqs, (item) => item.freq, (item) => item.count));
      setTopCallsigns(topItems(callsignsRsp.callsigns, (item) => item.callsign, (item) => item.count));
      setTopUnits(topItems(unitsRsp.units, (item) => item.unit, (item) => item.count));
      setTopLocations(topItems(locationsRsp.locations, (item) => item.location, (item) => item.count));
      setSummaryRows(summaryRsp.rows ?? []);
      setNewCallsigns(newCallsignsRsp);
      setMapDateRange({
        startDate: inboxReq.sinceDateInclusiveMs ?? 0,
        endDate: inboxReq.tillDateInclusiveMs ?? 0,
      });
      setMapPoints(mapRsp.points ?? []);
      setMapNetworkUnits(mapRsp.networkUnits ?? []);
      setMapOpenMessages([]);
      pushQueryStateToUrl(queryState);
    } catch (loadError) {
      if (!onUnauthorized(loadError)) {
        onError(toErrorMessage(loadError));
      }
    } finally {
      setLoading(false);
    }
  }, [newestFirst, onError, onUnauthorized, queryState]);

  const loadAllMessages = useCallback(async () => {
    const inboxReq = buildInboxReq(queryState, options.freqs);
    if (inboxReq == null) return;

    setLoading(true);
    try {
      const rsp = await fetchInboxMessages({ ...inboxReq, nolimit: true, newestFirst });
      setMessages(rsp.inboxItems ?? []);
      setNolimitShown(true);
      setNoMoreToLoad(true);
    } catch (loadError) {
      if (!onUnauthorized(loadError)) {
        onError(toErrorMessage(loadError));
      }
    } finally {
      setLoading(false);
    }
  }, [newestFirst, onError, onUnauthorized, options.freqs, queryState]);

  const loadMoreMessages = useCallback(async () => {
    const inboxReq = buildInboxReq(queryState, options.freqs);
    const lastMessage = messages.at(-1);
    if (inboxReq == null || lastMessage == null) return;

    setLoading(true);
    try {
      const paginatedReq = newestFirst
        ? { ...inboxReq, beforeIdNoninclusive: lastMessage[0], newestFirst }
        : { ...inboxReq, sinceIdNoninclusive: lastMessage[0], newestFirst };
      const rsp = await fetchInboxMessages(paginatedReq);
      const nextMessages = rsp.inboxItems ?? [];
      setMessages((current) => [...current, ...nextMessages]);
      if (nextMessages.length === 0) {
        setNoMoreToLoad(true);
      }
    } catch (loadError) {
      if (!onUnauthorized(loadError)) {
        onError(toErrorMessage(loadError));
      }
    } finally {
      setLoading(false);
    }
  }, [messages, newestFirst, onError, onUnauthorized, options.freqs, queryState]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const mapAttrs = useMemo(
    () =>
      buildMapAttrs({
        dateRange: mapDateRange,
        isLoading: mapLoading,
        points: mapPoints,
        messages: mapOpenMessages,
        networkUnits: mapNetworkUnits,
        selectedUnits: queryState.unitsSelected,
      }),
    [mapDateRange, mapLoading, mapNetworkUnits, mapOpenMessages, mapPoints, queryState.unitsSelected],
  );

  return {
    callsignGraph,
    callsignGraphLoading,
    callsignGraphNolimit,
    correlatedFreqs,
    correlatedFreqsLoading,
    counts,
    aorEntries,
    groupsActivityPeriod,
    downloadGeojson,
    downloadKmz,
    downloadSummaryXlsx,
    groupsActivity,
    groupsActivityLoading,
    inboxReq: buildInboxReq(queryState, options.freqs),
    loading,
    loadCallsignGraph,
    loadAllMessages,
    toggleCallsignGraphNolimit,
    loadCorrelatedFreqs,
    loadGroupsActivity,
    loadMoreMessages,
    loadMessagesForMap,
    mapAttrs,
    messages,
    networkDisplayMap,
    networks,
    newCallsigns,
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
