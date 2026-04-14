import type {
  CallsignInfoRes,
  CountStatsRsp,
  InboxMessage,
  Network,
  NewCallsignsRes,
  SignalGroupEntry,
  SignalProfileEntry,
  SummaryTableFreqRow,
  Tag,
  Unit,
} from '../../../../Bindings';
import {
  fetchAnalysisAors,
  fetchAnalysisCallsignInfos,
  fetchAnalysisCallsigns,
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
  fetchInboxMessages,
  fetchNetworksByIds,
  fetchUnitsByIds,
  getGroupInfosBatch,
  getLatestSenders,
  getTagsMapForDisplay,
} from '../../services/api/analysis';
import { sortFrequenciesNumerically, sortStringsAlphabetically } from '../../utils/misc';
import { ANALYSIS_SESSION_ACTIVITY_PAGE_ID, buildAnalysisReq, buildInboxReq, pushQueryStateToUrl, shouldRebuildAnalysisRequests } from './helpers';
import { buildSummaryCallsignsInfo } from './use-analysis-data.callsigns';
import { emptyOptions, toErrorMessage, topItems } from './use-analysis-data.shared';
import { buildNetworkDisplayMap } from './message-utils';
import type { AnalysisAorEntry, AnalysisCountItem, AnalysisFilterOptions, AnalysisQueryState } from './types';

type Setter<T> = React.Dispatch<React.SetStateAction<T>>;

type ReloadParams = {
  clearAnalysisResults: () => void;
  invalidateCallsignGraph: () => void;
  invalidateMessagePaging: () => void;
  newestFirst: boolean;
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  optionsFreqsRef: React.MutableRefObject<string[]>;
  queryState: AnalysisQueryState;
  reloadRequestRef: React.MutableRefObject<number>;
  setAorEntries: Setter<AnalysisAorEntry[]>;
  setCounts: Setter<CountStatsRsp | null>;
  setCountsLoading: Setter<boolean>;
  setFiltersLoading: Setter<boolean>;
  setGroupInfos: Setter<Record<string, SignalGroupEntry>>;
  setMapLoading: Setter<boolean>;
  setMapDateRange: Setter<{ startDate: number; endDate: number }>;
  setMapNetworkUnits: Setter<import('../../../../Bindings').NetworkUnit[]>;
  setMapOpenMessages: Setter<Array<[number, InboxMessage]>>;
  setMapPoints: Setter<import('../../../../Bindings').FreqDetailedPoint[]>;
  setMessages: Setter<Array<[number, InboxMessage]>>;
  setMessagesLoading: Setter<boolean>;
  setNetworkDisplayMap: Setter<Record<number, string>>;
  setNetworks: Setter<Network[]>;
  setNewCallsigns: Setter<NewCallsignsRes>;
  setNewCallsignsLoading: Setter<boolean>;
  setNoMoreToLoad: Setter<boolean>;
  setNolimitShown: Setter<boolean>;
  setOptions: Setter<AnalysisFilterOptions>;
  setProfiles: Setter<Record<string, SignalProfileEntry | null>>;
  setSummaryCallsignsInfo: Setter<Record<string, CallsignInfoRes>>;
  setSummaryLoading: Setter<boolean>;
  setSummaryRows: Setter<SummaryTableFreqRow[]>;
  setTagsMap: Setter<Record<number, Tag>>;
  setTopCallsigns: Setter<AnalysisCountItem[]>;
  setTopFreqs: Setter<AnalysisCountItem[]>;
  setTopLocations: Setter<AnalysisCountItem[]>;
  setTopUnits: Setter<AnalysisCountItem[]>;
  setUnitsMap: Setter<Record<number, Unit>>;
};

export async function reloadAnalysisData(params: ReloadParams): Promise<void> {
  const requestId = params.reloadRequestRef.current + 1;
  params.reloadRequestRef.current = requestId;
  const isStaleReload = () => requestId !== params.reloadRequestRef.current;
  let startedSecondaryLoads = false;

  params.onError('');
  params.invalidateMessagePaging();
  params.setCountsLoading(true);
  params.setMessagesLoading(true);
  params.setFiltersLoading(true);
  params.setSummaryLoading(true);
  params.setNewCallsignsLoading(true);
  params.setMapLoading(true);
  params.setNoMoreToLoad(false);
  params.setNolimitShown(false);

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
      const analysisReq = buildAnalysisReq(params.queryState, allFrequencies);
      const inboxReq = buildInboxReq(params.queryState, allFrequencies);

      if (analysisReq == null || inboxReq == null) {
        params.clearAnalysisResults();
        return null;
      }

      const [nextCounts, inboxRsp, freqsRsp] = await Promise.all([
        fetchAnalysisCount(analysisReq),
        fetchInboxMessages({ ...inboxReq, newestFirst: params.newestFirst }),
        fetchAnalysisFreqs(analysisReq),
      ]);
      if (isStaleReload()) return null;

      const nextFrequencies = freqsRsp.freqs.map((item) => item.freq);
      if (shouldRebuildAnalysisRequests(params.queryState, allFrequencies, nextFrequencies)) {
        params.optionsFreqsRef.current = nextFrequencies;
        return loadCriticalData(nextFrequencies);
      }

      params.setCounts(nextCounts);
      params.setMessages(inboxRsp.inboxItems ?? []);
      params.setOptions({
        ...emptyOptions,
        freqs: sortFrequenciesNumerically(nextFrequencies),
        newFreqs: sortFrequenciesNumerically(freqsRsp.freqs.filter((item) => item.isNew).map((item) => item.freq)),
      });
      params.setTopFreqs(topItems(freqsRsp.freqs, (item) => item.freq, (item) => item.count));
      params.setMapDateRange({
        startDate: inboxReq.sinceDateInclusiveMs ?? 0,
        endDate: inboxReq.tillDateInclusiveMs ?? 0,
      });
      params.invalidateCallsignGraph();
      pushQueryStateToUrl(params.queryState);

      return { analysisReq, inboxReq, inboxRsp, freqsRsp };
    };

    const criticalData = await loadCriticalData(params.optionsFreqsRef.current);
    if (criticalData == null || isStaleReload()) return;

    params.optionsFreqsRef.current = criticalData.freqsRsp.freqs.map((item) => item.freq);
    params.setCountsLoading(false);
    params.setMessagesLoading(false);

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
        if (isStaleReload()) return;

        const groupInfosByKey: Record<string, SignalGroupEntry> = {};
        groupsRsp.groupNames.forEach((item) => {
          groupInfosByKey[item.masterKey] = item;
        });

        params.setOptions((current) => ({
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
        params.setGroupInfos((current) => ({ ...current, ...groupInfosByKey }));
        params.setAorEntries((aorsRsp.aorNames ?? []).map((item) => ({ id: item.id, name: item.name })));
        params.setProfiles(senderProfilesRsp.data ?? {});
        params.setTagsMap(
          Object.fromEntries(
            Object.entries(tagsDisplayMap).filter(([tagId]) => tagsRsp.tags.some((item) => String(item.tagId) === tagId)),
          ),
        );
        params.setTopCallsigns(topItems(callsignsRsp.callsigns, (item) => item.callsign, (item) => item.count));
        params.setTopUnits(topItems(unitsRsp.units, (item) => item.unit, (item) => item.count));
        params.setTopLocations(topItems(locationsRsp.locations, (item) => item.location, (item) => item.count));

        const messageGroupKeys = Array.from(
          new Set(inboxItems.map(([, message]) => message.groupMasterKey).filter((value): value is string => Boolean(value))),
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
        if (isStaleReload()) return;

        const unitIds = Array.from(new Set(networksRspById.flatMap((network) => network.unitIds ?? [])));
        const unitsRspById = unitIds.length > 0 ? await fetchUnitsByIds({ ids: unitIds }) : { units: [] };
        if (isStaleReload()) return;

        const nextGroupInfos: Record<string, SignalGroupEntry> = { ...groupInfosByKey };
        groupInfosRsp.forEach((item) => {
          nextGroupInfos[item.masterKey] = item;
        });
        const nextUnitsMap: Record<number, Unit> = {};
        unitsRspById.units.forEach((unit) => {
          nextUnitsMap[unit.id] = unit;
        });

        params.setGroupInfos(nextGroupInfos);
        params.setNetworks(networksRspById);
        params.setUnitsMap(nextUnitsMap);
        params.setNetworkDisplayMap(buildNetworkDisplayMap(networksRspById, nextUnitsMap));
        params.setSummaryCallsignsInfo(buildSummaryCallsignsInfo(criticalData.inboxRsp.callsigns, callsignInfosRsp));
      } catch (loadError) {
        if (isStaleReload()) return;
        if (!params.onUnauthorized(loadError)) {
          params.onError(toErrorMessage(loadError));
        }
      } finally {
        if (!isStaleReload()) params.setFiltersLoading(false);
      }
    };

    const loadSummaryData = async () => {
      try {
        const summaryRsp = await fetchAnalysisSummaryTable(criticalData.analysisReq);
        if (isStaleReload()) return;
        params.setSummaryRows(summaryRsp.rows ?? []);
      } catch (loadError) {
        if (isStaleReload()) return;
        if (!params.onUnauthorized(loadError)) params.onError(toErrorMessage(loadError));
      } finally {
        if (!isStaleReload()) params.setSummaryLoading(false);
      }
    };

    const loadNewCallsignsData = async () => {
      try {
        const newCallsignsRsp = await fetchAnalysisNewCallsigns(criticalData.analysisReq);
        if (isStaleReload()) return;
        params.setNewCallsigns(newCallsignsRsp);
      } catch (loadError) {
        if (isStaleReload()) return;
        if (!params.onUnauthorized(loadError)) params.onError(toErrorMessage(loadError));
      } finally {
        if (!isStaleReload()) params.setNewCallsignsLoading(false);
      }
    };

    const loadMapData = async () => {
      try {
        const mapRsp = await fetchAnalysisMapPoints({
          inboxItemsFilter: criticalData.inboxReq,
          mapFilter: null,
          pageId: ANALYSIS_SESSION_ACTIVITY_PAGE_ID,
        });
        if (isStaleReload()) return;
        params.setMapPoints(mapRsp.points ?? []);
        params.setMapNetworkUnits(mapRsp.networkUnits ?? []);
        params.setMapOpenMessages([]);
      } catch (loadError) {
        if (isStaleReload()) return;
        if (!params.onUnauthorized(loadError)) params.onError(toErrorMessage(loadError));
      } finally {
        if (!isStaleReload()) params.setMapLoading(false);
      }
    };

    startedSecondaryLoads = true;
    void Promise.all([loadFilterData(), loadSummaryData(), loadNewCallsignsData(), loadMapData()]);
  } catch (loadError) {
    if (isStaleReload()) return;
    if (!params.onUnauthorized(loadError)) params.onError(toErrorMessage(loadError));
  } finally {
    if (!isStaleReload()) {
      params.setCountsLoading(false);
      params.setMessagesLoading(false);
      if (!startedSecondaryLoads) {
        params.setFiltersLoading(false);
        params.setSummaryLoading(false);
        params.setNewCallsignsLoading(false);
        params.setMapLoading(false);
      }
    }
  }
}
