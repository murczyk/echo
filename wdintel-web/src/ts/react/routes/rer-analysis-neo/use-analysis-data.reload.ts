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
import type { AnalysisStatsReq } from '../../../../Bindings';
import {
  fetchAnalysisAors,
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
  getLatestSenders,
  getTagsMapForDisplay,
} from '../../services/api/analysis';
import { getUnitsList } from '../../services/api/units';
import { sortFrequenciesNumerically } from '../../utils/misc';
import { ANALYSIS_SESSION_ACTIVITY_PAGE_ID, buildAnalysisReq, buildInboxReq, shouldRebuildAnalysisRequests } from './helpers';
import { emptyNewCallsigns, emptyOptions, normalizeFilterLabel, toErrorMessage, topItems } from './use-analysis-data.shared';
import { buildNetworkDisplayMap, buildSenderFilterOptions } from './message-utils';
import type {
  AnalysisAorEntry,
  AnalysisCountItem,
  AnalysisFilterOption,
  AnalysisFilterOptions,
  AnalysisFilterSectionId,
  AnalysisQueryState,
} from './types';

type FilterSectionLoadContext = {
  analysisReq: NonNullable<ReturnType<typeof buildAnalysisReq>>;
  loadVersion: number;
  loadVersionRef: React.MutableRefObject<number>;
  setAorEntries: Setter<AnalysisAorEntry[]>;
  setGroupInfos: Setter<Record<string, SignalGroupEntry>>;
  setNetworks: Setter<Network[]>;
  setNetworkDisplayMap: Setter<Record<number, string>>;
  setOptions: Setter<AnalysisFilterOptions>;
  setProfiles: Setter<Record<string, SignalProfileEntry | null>>;
  setTagsMap: Setter<Record<number, Tag>>;
  unitsMap: Record<number, Unit>;
};

function filterSectionLoadKey(section: AnalysisFilterSectionId, requestKey: string): string {
  return `${section}:${requestKey}`;
}

function mergeNetworks(existing: Network[], next: Network[]): Network[] {
  const merged = new Map<number, Network>();
  existing.forEach((network) => {
    merged.set(network.id, network);
  });
  next.forEach((network) => {
    merged.set(network.id, network);
  });
  return Array.from(merged.values());
}

export function filterSectionsForQueryState(queryState: AnalysisQueryState): AnalysisFilterSectionId[] {
  const sections: AnalysisFilterSectionId[] = [];
  if (queryState.tags.length > 0) sections.push('tags');
  if (queryState.aorsSelected.length > 0) sections.push('aors');
  if (queryState.groupsSelected.length > 0) sections.push('groups');
  if (queryState.sendersSelected.length > 0) sections.push('senders');
  if (queryState.callsignsSelected.length > 0) sections.push('callsigns');
  if (queryState.unitsSelected.length > 0) sections.push('units');
  if (queryState.locationsSelected.length > 0) sections.push('locations');
  if (queryState.postsSelected.length > 0) sections.push('posts');
  if (queryState.networksSelected.length > 0) sections.push('networks');
  if (queryState.metadataCc.length > 0 || queryState.metadataSender.length > 0 || queryState.metadataReceiver.length > 0 || queryState.metadataHash.length > 0) {
    sections.push('metadata');
  }
  return sections;
}

export function filterSectionsForInitialLoad(queryState: AnalysisQueryState): AnalysisFilterSectionId[] {
  return filterSectionsForQueryState(queryState);
}

function toFilterOptions<T>(
  items: T[],
  getValue: (item: T) => string,
  getLabel: (item: T) => string,
  getCount: (item: T) => number,
): AnalysisFilterOption[] {
  return items.map((item) => ({
    value: getValue(item),
    label: getLabel(item),
    count: getCount(item),
  }));
}

export function buildAnalysisReqForFilterSection(
  section: AnalysisFilterSectionId,
  analysisReq: AnalysisStatsReq,
): AnalysisStatsReq {
  switch (section) {
    case 'tags':
      return { ...analysisReq, selectedTags: null };
    case 'aors':
      return { ...analysisReq, selectedAors: null };
    case 'groups':
      return { ...analysisReq, selectedGroups: null };
    case 'senders':
      return { ...analysisReq, selectedSenders: null };
    case 'callsigns':
      return { ...analysisReq, selectedCallsigns: null };
    case 'units':
      return { ...analysisReq, selectedUnits: null };
    case 'locations':
      return { ...analysisReq, selectedLocations: null };
    case 'posts':
      return { ...analysisReq, selectedPosts: null };
    case 'networks':
      return { ...analysisReq, selectedNetworks: null };
    case 'metadata':
      return { ...analysisReq, metadataCc: null, metadataSender: null, metadataReceiver: null, metadataHash: null };
  }
}

export async function loadFilterSectionData(section: AnalysisFilterSectionId, context: FilterSectionLoadContext): Promise<void> {
  const requestKey = JSON.stringify(context.analysisReq);
  void filterSectionLoadKey(section, requestKey);
  const isStale = () => context.loadVersion !== context.loadVersionRef.current;

  switch (section) {
    case 'tags': {
      const [tagsRsp, tagsDisplayMap] = await Promise.all([fetchAnalysisTags(context.analysisReq), getTagsMapForDisplay()]);
      if (isStale()) return;
      context.setTagsMap(tagsDisplayMap);
      context.setOptions((current) => ({
        ...current,
        tags: toFilterOptions(
          tagsRsp.tags,
          (item) => String(item.tagId),
          (item) => tagsDisplayMap[item.tagId]?.label ?? String(item.tagId),
          (item) => item.count,
        ),
      }));
      return;
    }
    case 'aors': {
      const aorsRsp = await fetchAnalysisAors(context.analysisReq);
      if (isStale()) return;
      const aorNamesById = Object.fromEntries((aorsRsp.aorNames ?? []).map((item) => [String(item.id), item.name]));
      context.setAorEntries((aorsRsp.aorNames ?? []).map((item) => ({ id: item.id, name: item.name })));
      context.setOptions((current) => ({
        ...current,
        aors: toFilterOptions(
          aorsRsp.aors,
          (item) => String(item.aorId),
          (item) => aorNamesById[String(item.aorId)] ?? String(item.aorId),
          (item) => item.count,
        ),
      }));
      return;
    }
    case 'groups': {
      const groupsRsp = await fetchAnalysisGroups(context.analysisReq);
      if (isStale()) return;
      const groupInfosByKey: Record<string, SignalGroupEntry> = {};
      groupsRsp.groupNames.forEach((item) => {
        groupInfosByKey[item.masterKey] = item;
      });
      context.setGroupInfos((current) => ({ ...current, ...groupInfosByKey }));
      context.setOptions((current) => ({
        ...current,
        groups: toFilterOptions(
          groupsRsp.groups,
          (item) => item.masterKey,
          (item) => groupInfosByKey[item.masterKey]?.name ?? item.masterKey,
          (item) => item.count,
        ),
      }));
      return;
    }
    case 'senders': {
      const [sendersRsp, senderProfilesRsp] = await Promise.all([fetchAnalysisSenders(context.analysisReq), getLatestSenders()]);
      if (isStale()) return;
      context.setProfiles(senderProfilesRsp.data ?? {});
      context.setOptions((current) => ({
        ...current,
        senders: buildSenderFilterOptions(sendersRsp.senders, senderProfilesRsp.data ?? {}),
      }));
      return;
    }
    case 'callsigns': {
      const callsignsRsp = await fetchAnalysisCallsigns(context.analysisReq);
      if (isStale()) return;
      const groupedByLabel = new Map<string, AnalysisFilterOption>();
      callsignsRsp.callsigns.forEach((item) => {
        const label = item.callsign.toUpperCase();
        const existing = groupedByLabel.get(label);
        if (existing != null) {
          existing.count += item.count;
          existing.values = [...(existing.values ?? [existing.value]), item.callsign];
          return;
        }
        groupedByLabel.set(label, { value: label, label, count: item.count, values: [item.callsign] });
      });
      context.setOptions((current) => ({
        ...current,
        callsigns: [...groupedByLabel.values()].sort((a, b) => a.label.localeCompare(b.label)),
      }));
      return;
    }
    case 'units': {
      const unitsRsp = await fetchAnalysisUnits(context.analysisReq);
      if (isStale()) return;
      context.setOptions((current) => ({
        ...current,
        units: toFilterOptions(
          unitsRsp.units,
          (item) => item.unit,
          (item) => item.unit,
          (item) => item.count,
        ),
      }));
      return;
    }
    case 'locations': {
      const locationsRsp = await fetchAnalysisLocations(context.analysisReq);
      if (isStale()) return;
      context.setOptions((current) => ({
        ...current,
        locations: toFilterOptions(
          locationsRsp.locations,
          (item) => item.location,
          (item) => item.location,
          (item) => item.count,
        ),
      }));
      return;
    }
    case 'posts': {
      const postsRsp = await fetchAnalysisPosts(context.analysisReq);
      if (isStale()) return;
      context.setOptions((current) => ({
        ...current,
        posts: toFilterOptions(
          postsRsp.posts,
          (item) => item.post,
          (item) => normalizeFilterLabel(item.post),
          (item) => item.count,
        ),
      }));
      return;
    }
    case 'networks': {
      const networksStatsRsp = await fetchAnalysisNetworks(context.analysisReq);
      if (isStale()) return;
      const networkIds = networksStatsRsp.networks.map((item) => item.networkId);
      const networksById = networkIds.length > 0 ? await fetchNetworksByIds(networkIds) : [];
      if (isStale()) return;
      const networkNamesById = Object.fromEntries(networksStatsRsp.networkNames.map((network) => [network.id, network.name]));
      context.setNetworks((current) => mergeNetworks(current, networksById));
      context.setNetworkDisplayMap(buildNetworkDisplayMap(networksById, context.unitsMap));
      context.setOptions((current) => ({
        ...current,
        networks: toFilterOptions(
          networksStatsRsp.networks,
          (item) => String(item.networkId),
          (item) => normalizeFilterLabel(networkNamesById[item.networkId] ?? `Network ${item.networkId}`),
          (item) => item.count,
        ).sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value)),
      }));
      return;
    }
    case 'metadata': {
      const metadataRsp = await fetchAnalysisMetadata(context.analysisReq);
      if (isStale()) return;
      context.setOptions((current) => ({
        ...current,
        metadataCcs: toFilterOptions(metadataRsp.ccs, (item) => item.value, (item) => item.value, (item) => item.count),
        metadataSenders: toFilterOptions(metadataRsp.senders, (item) => item.value, (item) => item.value, (item) => item.count),
        metadataReceivers: toFilterOptions(metadataRsp.receivers, (item) => item.value, (item) => item.value, (item) => item.count),
        metadataHashes: toFilterOptions(metadataRsp.hashes, (item) => item.value, (item) => item.value, (item) => item.count),
      }));
      return;
    }
  }
}

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
  setUnitsMap: Setter<Record<number, Unit>>;
  setNewCallsigns: Setter<NewCallsignsRes>;
  setHasLoadedInitialMessages: Setter<boolean>;
  setNewCallsignsLoading: Setter<boolean>;
  setNewCallsignsLoadedKey: (key: string | null) => void;
  shouldLoadNewCallsigns: boolean;
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
  loadInitialFilterSections: (analysisReq: NonNullable<ReturnType<typeof buildAnalysisReq>>) => Promise<void>;
  invalidateFilterSectionLoads: () => void;
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
  params.setNewCallsignsLoadedKey(null);
  params.setMapLoading(true);
  params.setNoMoreToLoad(false);
  params.setNolimitShown(false);
  params.invalidateFilterSectionLoads();

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

      const [inboxRsp, freqsRsp] = await Promise.all([
        fetchInboxMessages({ ...inboxReq, newestFirst: params.newestFirst }),
        fetchAnalysisFreqs(analysisReq),
      ]);
      if (isStaleReload()) return null;

      const nextFrequencies = freqsRsp.freqs.map((item) => item.freq);
      if (shouldRebuildAnalysisRequests(params.queryState, allFrequencies, nextFrequencies)) {
        params.optionsFreqsRef.current = nextFrequencies;
        return loadCriticalData(nextFrequencies);
      }

      params.setMessages(inboxRsp.inboxItems ?? []);
      params.setHasLoadedInitialMessages(true);
      const nextFreqCountsByValue = new Map(freqsRsp.freqs.map((item) => [item.freq, item.count]));
      const nextFreqOptions = sortFrequenciesNumerically(nextFrequencies).map((freq) => ({
        value: freq,
        label: normalizeFilterLabel(freq),
        count: nextFreqCountsByValue.get(freq) ?? 0,
      }));
      const nextNewFreqs = sortFrequenciesNumerically(freqsRsp.freqs.filter((item) => item.isNew).map((item) => item.freq)).map((freq) => ({
        value: freq,
        label: normalizeFilterLabel(freq),
        count: nextFreqCountsByValue.get(freq) ?? 0,
      }));
      params.setOptions({
        ...emptyOptions,
        freqs: nextFreqOptions,
        newFreqs: nextNewFreqs,
      });
      params.setTopFreqs(topItems(freqsRsp.freqs, (item) => item.freq, (item) => item.count));
      params.setMapDateRange({
        startDate: inboxReq.sinceDateInclusiveMs ?? 0,
        endDate: inboxReq.tillDateInclusiveMs ?? 0,
      });
      params.invalidateCallsignGraph();
      return { analysisReq, inboxReq, inboxRsp, freqsRsp };
    };

    const criticalData = await loadCriticalData(params.optionsFreqsRef.current);
    if (criticalData == null || isStaleReload()) return;

    params.optionsFreqsRef.current = criticalData.freqsRsp.freqs.map((item) => item.freq);
    params.setMessagesLoading(false);

    const loadCountsData = async () => {
      try {
        const countsRsp = await fetchAnalysisCount(criticalData.analysisReq);
        if (isStaleReload()) return;
        params.setCounts(countsRsp);
      } catch (loadError) {
        if (isStaleReload()) return;
        if (!params.onUnauthorized(loadError)) params.onError(toErrorMessage(loadError));
      } finally {
        if (!isStaleReload()) params.setCountsLoading(false);
      }
    };

    const loadReferenceData = async () => {
      try {
        const messageNetworkIds = Array.from(
          new Set((criticalData.inboxRsp.inboxItems ?? []).flatMap(([, message]) => message.networkIds ?? [])),
        );
        const [units, networksByMessageIds] = await Promise.all([
          getUnitsList(),
          messageNetworkIds.length > 0 ? fetchNetworksByIds(messageNetworkIds) : Promise.resolve([]),
        ]);
        if (isStaleReload()) return;
        params.setUnitsMap(Object.fromEntries(units.map((unit) => [unit.id, unit])));
        params.setNetworks((current) => mergeNetworks(current, networksByMessageIds));
      } catch (loadError) {
        if (isStaleReload()) return;
        if (!params.onUnauthorized(loadError)) params.onError(toErrorMessage(loadError));
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
    const secondaryLoads = [
      loadCountsData(),
      loadReferenceData(),
      (async () => {
        try {
          await params.loadInitialFilterSections(criticalData.analysisReq);
        } finally {
          if (!isStaleReload()) params.setFiltersLoading(false);
        }
      })(),
      loadSummaryData(),
      loadMapData(),
    ];
    if (params.shouldLoadNewCallsigns) {
      secondaryLoads.push(
        (async () => {
          try {
            const newCallsignsRsp = await fetchAnalysisNewCallsigns(criticalData.analysisReq);
            if (isStaleReload()) return;
            params.setNewCallsigns(newCallsignsRsp);
            params.setNewCallsignsLoadedKey(JSON.stringify(criticalData.analysisReq));
          } catch (loadError) {
            if (isStaleReload()) return;
            if (!params.onUnauthorized(loadError)) params.onError(toErrorMessage(loadError));
          } finally {
            if (!isStaleReload()) params.setNewCallsignsLoading(false);
          }
        })(),
      );
    } else {
      params.setNewCallsigns(emptyNewCallsigns);
      params.setNewCallsignsLoading(false);
      params.setNewCallsignsLoadedKey(null);
    }
    void Promise.all(secondaryLoads);
  } catch (loadError) {
    if (isStaleReload()) return;
    if (!params.onUnauthorized(loadError)) params.onError(toErrorMessage(loadError));
  } finally {
    if (!isStaleReload()) {
      params.setMessagesLoading(false);
      if (!startedSecondaryLoads) {
        params.setCountsLoading(false);
        params.setFiltersLoading(false);
        params.setSummaryLoading(false);
        params.setNewCallsignsLoading(false);
        params.setMapLoading(false);
      }
    }
  }
}
