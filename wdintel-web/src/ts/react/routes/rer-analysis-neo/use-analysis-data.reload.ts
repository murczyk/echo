import type {
  CallsignInfoRes,
  CountStatsRsp,
  InboxMessage,
  Network,
  NewCallsignsRes,
  SignalGroupEntry,
  SignalProfileEntry,
  Tag,
  Unit,
} from '../../../../Bindings';
import type { AnalysisStatsReq } from '../../../../Bindings';
import {
  fetchAnalysisAors,
  fetchAnalysisCount,
  fetchAnalysisCallsigns,
  fetchAnalysisFreqs,
  fetchAnalysisGroups,
  fetchAnalysisMapPoints,
  fetchAnalysisLocations,
  fetchAnalysisMetadata,
  fetchAnalysisNetworks,
  fetchAnalysisNewCallsigns,
  fetchAnalysisPosts,
  fetchAnalysisSenders,
  fetchAnalysisTags,
  fetchAnalysisUnits,
  fetchInboxMessages,
  fetchNetworksByIds,
  getLatestSenders,
  getTagsMapForDisplay,
} from '../../services/api/analysis';
import { isAbortError } from '../../services/api/client';
import { getUnitsList } from '../../services/api/units';
import { isNullOrUndefined, isPresent, sortFrequenciesNumerically } from '../../utils/misc';
import {
  ANALYSIS_SESSION_ACTIVITY_PAGE_ID,
  buildAnalysisReq,
  buildInboxReq,
  shouldRebuildAnalysisRequests,
} from './helpers';
import { buildSummaryCallsignsInfo } from './use-analysis-data.callsigns';
import {
  emptyNewCallsigns,
  emptyOptions,
  isAnalysisInboxPageExhausted,
  normalizeFilterLabel,
  toErrorMessage,
  topItems,
} from './use-analysis-data.shared';
import { invalidateNewCallsignsLoadState } from './use-analysis-data.support';
import { buildSenderFilterOptions } from './message-utils';
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
  networkStatsCache?: Map<string, ReturnType<typeof fetchAnalysisNetworks>>;
  signal?: AbortSignal;
  setAorEntries: Setter<AnalysisAorEntry[]>;
  setGroupInfos: Setter<Record<string, SignalGroupEntry>>;
  setNetworks: Setter<Network[]>;
  setOptions: Setter<AnalysisFilterOptions>;
  setProfiles: Setter<Record<string, SignalProfileEntry | null>>;
  setTagsMap: Setter<Record<number, Tag>>;
  unitsMap: Record<number, Unit>;
};

export function filterSectionLoadKey(section: AnalysisFilterSectionId, requestKey: string): string {
  return `${section}:${requestKey}`;
}

export function filterSectionCacheKey(
  section: AnalysisFilterSectionId,
  analysisReq: AnalysisStatsReq,
): string {
  return filterSectionLoadKey(section, JSON.stringify(analysisReq));
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

export function mergeSignalProfiles(
  current: Record<string, SignalProfileEntry | null>,
  next: Record<string, SignalProfileEntry | null>,
): Record<string, SignalProfileEntry | null> {
  const merged = { ...current };
  for (const [login, profile] of Object.entries(next)) {
    if (profile != null || !(login in merged)) {
      merged[login] = profile;
    }
  }
  return merged;
}

function mergeSignalGroups(
  current: Record<string, SignalGroupEntry>,
  next: Record<string, SignalGroupEntry>,
): Record<string, SignalGroupEntry> {
  return { ...current, ...next };
}

async function loadAnalysisNetworksWithCache(
  analysisReq: AnalysisStatsReq,
  cache?: Map<string, ReturnType<typeof fetchAnalysisNetworks>>,
  signal?: AbortSignal,
): ReturnType<typeof fetchAnalysisNetworks> {
  const requestKey = JSON.stringify(analysisReq);
  const cached = cache?.get(requestKey);
  if (cached) return cached;

  const request = fetchAnalysisNetworks(analysisReq, signal ? { signal } : undefined);
  cache?.set(requestKey, request);
  return request;
}

export function filterSectionsForQueryState(
  queryState: AnalysisQueryState,
): AnalysisFilterSectionId[] {
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
  if (
    queryState.metadataCc.length > 0 ||
    queryState.metadataSender.length > 0 ||
    queryState.metadataReceiver.length > 0 ||
    queryState.metadataHash.length > 0
  ) {
    sections.push('metadata');
  }
  return sections;
}

export function filterSectionsForInitialLoad(
  queryState: AnalysisQueryState,
): AnalysisFilterSectionId[] {
  const sections = new Set<AnalysisFilterSectionId>(['tags', 'groups', 'senders']);
  filterSectionsForQueryState(queryState).forEach((section) => {
    sections.add(section);
  });
  return Array.from(sections);
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
      return {
        ...analysisReq,
        metadataCc: null,
        metadataSender: null,
        metadataReceiver: null,
        metadataHash: null,
        withoutMetadata: false,
      };
  }
}

export async function loadFilterSectionData(
  section: AnalysisFilterSectionId,
  context: FilterSectionLoadContext,
): Promise<void> {
  const isStale = () => context.loadVersion !== context.loadVersionRef.current;
  const requestOptions = context.signal ? { signal: context.signal } : undefined;
  const isAborted = () => context.signal?.aborted === true;

  switch (section) {
    case 'tags': {
      const [tagsRsp, tagsDisplayMap] = await Promise.all([
        fetchAnalysisTags(context.analysisReq, requestOptions),
        getTagsMapForDisplay(requestOptions),
      ]);
      if (isStale() || isAborted()) return;
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
      const aorsRsp = await fetchAnalysisAors(context.analysisReq, requestOptions);
      if (isStale() || isAborted()) return;
      const aorNamesById = Object.fromEntries(
        (aorsRsp.aorNames ?? []).map((item) => [String(item.id), item.name]),
      );
      context.setAorEntries(
        (aorsRsp.aorNames ?? []).map((item) => ({ id: item.id, name: item.name })),
      );
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
      const groupsRsp = await fetchAnalysisGroups(context.analysisReq, requestOptions);
      if (isStale() || isAborted()) return;
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
      const [sendersRsp, senderProfilesRsp] = await Promise.all([
        fetchAnalysisSenders(context.analysisReq, requestOptions),
        getLatestSenders(requestOptions),
      ]);
      if (isStale() || isAborted()) return;
      context.setProfiles((current) => mergeSignalProfiles(current, senderProfilesRsp.data ?? {}));
      context.setOptions((current) => ({
        ...current,
        senders: buildSenderFilterOptions(sendersRsp.senders, senderProfilesRsp.data ?? {}),
      }));
      return;
    }
    case 'callsigns': {
      const callsignsRsp = await fetchAnalysisCallsigns(context.analysisReq, requestOptions);
      if (isStale() || isAborted()) return;
      const groupedByLabel = new Map<string, AnalysisFilterOption>();
      callsignsRsp.callsigns.forEach((item) => {
        const label = item.callsign.toUpperCase();
        const existing = groupedByLabel.get(label);
        if (isPresent(existing)) {
          existing.count += item.count;
          existing.values = [...(existing.values ?? [existing.value]), item.callsign];
          return;
        }
        groupedByLabel.set(label, {
          value: label,
          label,
          count: item.count,
          values: [item.callsign],
        });
      });
      context.setOptions((current) => ({
        ...current,
        callsigns: [...groupedByLabel.values()].sort((a, b) => a.label.localeCompare(b.label)),
      }));
      return;
    }
    case 'units': {
      const unitsRsp = await fetchAnalysisUnits(context.analysisReq, requestOptions);
      if (isStale() || isAborted()) return;
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
      const locationsRsp = await fetchAnalysisLocations(context.analysisReq, requestOptions);
      if (isStale() || isAborted()) return;
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
      const postsRsp = await fetchAnalysisPosts(context.analysisReq, requestOptions);
      if (isStale() || isAborted()) return;
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
      const networksStatsRsp = await loadAnalysisNetworksWithCache(
        context.analysisReq,
        context.networkStatsCache,
        context.signal,
      );
      if (isStale() || isAborted()) return;
      const networkIds = networksStatsRsp.networks.map((item) => item.networkId);
      const networksById =
        networkIds.length > 0 ? await fetchNetworksByIds(networkIds, requestOptions) : [];
      if (isStale() || isAborted()) return;
      const networkNamesById = Object.fromEntries(
        networksStatsRsp.networkNames.map((network) => [network.id, network.name]),
      );
      context.setNetworks((current) => mergeNetworks(current, networksById));
      context.setOptions((current) => ({
        ...current,
        networks: toFilterOptions(
          networksStatsRsp.networks,
          (item) => String(item.networkId),
          (item) =>
            normalizeFilterLabel(networkNamesById[item.networkId] ?? `Network ${item.networkId}`),
          (item) => item.count,
        ).sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value)),
      }));
      return;
    }
    case 'metadata': {
      const metadataRsp = await fetchAnalysisMetadata(context.analysisReq, requestOptions);
      if (isStale() || isAborted()) return;
      context.setOptions((current) => ({
        ...current,
        metadataCcs: toFilterOptions(
          metadataRsp.ccs,
          (item) => item.value,
          (item) => item.value,
          (item) => item.count,
        ),
        metadataSenders: toFilterOptions(
          metadataRsp.senders,
          (item) => item.value,
          (item) => item.value,
          (item) => item.count,
        ),
        metadataReceivers: toFilterOptions(
          metadataRsp.receivers,
          (item) => item.value,
          (item) => item.value,
          (item) => item.count,
        ),
        metadataHashes: toFilterOptions(
          metadataRsp.hashes,
          (item) => item.value,
          (item) => item.value,
          (item) => item.count,
        ),
      }));
      return;
    }
  }
}

type Setter<T> = React.Dispatch<React.SetStateAction<T>>;

type ReloadParams = {
  clearAnalysisResults: () => void;
  invalidateCorrelatedFreqsCache: () => void;
  invalidateCallsignGraph: () => void;
  invalidateMessagePaging: () => void;
  centerTab?: import('./types').AnalysisCenterTab;
  rightSidebarVisible?: boolean;
  rightSidebarTab?: import('./types').AnalysisSidebarTab | null;
  newestFirst: boolean;
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  optionsFreqsRef: React.MutableRefObject<string[]>;
  queryState: AnalysisQueryState;
  reloadRequestRef: React.MutableRefObject<number>;
  newCallsignsRequestRef?: React.MutableRefObject<number>;
  newCallsignsLoadedKeyRef?: React.MutableRefObject<string | null>;
  newCallsignsPendingKeyRef?: React.MutableRefObject<string | null>;
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
  setTagsMap: Setter<Record<number, Tag>>;
  setTopCallsigns: Setter<AnalysisCountItem[]>;
  setTopFreqs: Setter<AnalysisCountItem[]>;
  setTopLocations: Setter<AnalysisCountItem[]>;
  setTopUnits: Setter<AnalysisCountItem[]>;
  loadMessageComments?: (
    messages: Array<[number, InboxMessage]>,
    forceReload?: boolean,
  ) => Promise<void>;
  invalidateSummaryLoads?: () => void;
  invalidateTopSidebarLoads?: () => void;
  getLoadedFilterSections?: () => AnalysisFilterSectionId[];
  loadInitialFilterSections: (
    analysisReq: NonNullable<ReturnType<typeof buildAnalysisReq>>,
    plan:
      | import('./use-analysis-data-filter-sections').FilterSectionLoadPlan
      | { mode: 'initial'; selectedSections: AnalysisFilterSectionId[] },
    networkStatsCache?: Map<string, ReturnType<typeof fetchAnalysisNetworks>>,
    signal?: AbortSignal,
  ) => Promise<void>;
  invalidateFilterSectionLoads: () => void;
  invalidateFilterSectionLoadsForPatch: (patch?: Partial<AnalysisQueryState>) => void;
  getReloadFilterSections?: () => AnalysisFilterSectionId[] | null;
  signal?: AbortSignal;
};

export async function reloadAnalysisData(params: ReloadParams): Promise<void> {
  const requestId = params.reloadRequestRef.current + 1;
  params.reloadRequestRef.current = requestId;
  const isStaleReload = () => requestId !== params.reloadRequestRef.current;
  let startedSecondaryLoads = false;
  const networkStatsCache = new Map<string, ReturnType<typeof fetchAnalysisNetworks>>();
  const targetedReloadSections = params.getReloadFilterSections?.();
  const shouldLoadMap =
    params.centerTab === 'map' ||
    (params.rightSidebarVisible === true && params.rightSidebarTab === 'map');

  params.onError('');
  params.invalidateMessagePaging();
  params.invalidateCorrelatedFreqsCache();
  params.setCountsLoading(true);
  params.setMessagesLoading(true);
  params.setFiltersLoading(true);
  params.setNewCallsignsLoading(true);
  params.setNewCallsignsLoadedKey(null);
  params.setMapLoading(shouldLoadMap);
  params.setNoMoreToLoad(false);
  params.setNolimitShown(false);

  try {
    const loadCriticalData = async (
      allFrequencies: string[],
    ): Promise<{
      originalAnalysisReq: NonNullable<ReturnType<typeof buildAnalysisReq>>;
      inboxReq: NonNullable<ReturnType<typeof buildInboxReq>>;
      inboxRsp: Awaited<ReturnType<typeof fetchInboxMessages>>;
      freqsRsp: Awaited<ReturnType<typeof fetchAnalysisFreqs>>;
      countsPromise: Promise<CountStatsRsp>;
      resolvedAnalysisReq: NonNullable<ReturnType<typeof buildAnalysisReq>>;
    } | null> => {
      const analysisReq = buildAnalysisReq(params.queryState, allFrequencies);
      const inboxReq = buildInboxReq(params.queryState, allFrequencies);
      const messageInboxReq = buildInboxReq(params.queryState, allFrequencies, true);

      if (
        isNullOrUndefined(analysisReq) ||
        isNullOrUndefined(inboxReq) ||
        isNullOrUndefined(messageInboxReq)
      ) {
        params.invalidateSummaryLoads?.();
        params.invalidateTopSidebarLoads?.();
        params.clearAnalysisResults();
        if (
          isPresent(params.newCallsignsRequestRef) &&
          isPresent(params.newCallsignsLoadedKeyRef) &&
          isPresent(params.newCallsignsPendingKeyRef)
        ) {
          invalidateNewCallsignsLoadState({
            setNewCallsigns: params.setNewCallsigns,
            setNewCallsignsLoading: params.setNewCallsignsLoading,
            newCallsignsRequestRef: params.newCallsignsRequestRef,
            newCallsignsLoadedKeyRef: params.newCallsignsLoadedKeyRef,
            newCallsignsPendingKeyRef: params.newCallsignsPendingKeyRef,
          });
        }
        return null;
      }

      const countsPromise = fetchAnalysisCount(
        analysisReq,
        params.signal ? { signal: params.signal } : undefined,
      );
      countsPromise.catch(() => undefined);
      const inboxPromise = fetchInboxMessages(
        { ...messageInboxReq, newestFirst: params.newestFirst },
        params.signal ? { signal: params.signal } : undefined,
      );
      const freqsPromise = fetchAnalysisFreqs(
        analysisReq,
        params.signal ? { signal: params.signal } : undefined,
      );
      void freqsPromise.catch(() => undefined);

      let inboxRsp: Awaited<ReturnType<typeof fetchInboxMessages>>;
      try {
        inboxRsp = await inboxPromise;
      } catch (loadError) {
        if (isAbortError(loadError) || params.signal?.aborted) return null;
        throw loadError;
      }
      if (isStaleReload() || params.signal?.aborted) return null;

      params.setMessages(inboxRsp.inboxItems ?? []);
      params.setProfiles((current) => mergeSignalProfiles(current, inboxRsp.signalProfiles ?? {}));
      params.setGroupInfos((current) =>
        mergeSignalGroups(
          current,
          Object.fromEntries((inboxRsp.signalGroups ?? []).map((item) => [item.masterKey, item])),
        ),
      );
      params.setSummaryCallsignsInfo(buildSummaryCallsignsInfo(inboxRsp.callsigns, null));
      params.setNoMoreToLoad(isAnalysisInboxPageExhausted(inboxRsp.inboxItems, inboxRsp.pageLimit));
      params.setHasLoadedInitialMessages(true);
      params.setMessagesLoading(false);
      void params.loadMessageComments?.(inboxRsp.inboxItems ?? [], true);

      let freqsRsp: Awaited<ReturnType<typeof fetchAnalysisFreqs>>;
      try {
        freqsRsp = await freqsPromise;
      } catch (loadError) {
        if (isStaleReload() || isAbortError(loadError) || params.signal?.aborted) return null;
        params.setCounts(null);
        params.setNewCallsigns(emptyNewCallsigns);
        params.setNewCallsignsLoadedKey(null);
        params.setOptions(emptyOptions);
        params.setTopFreqs([]);
        throw loadError;
      }
      if (isStaleReload() || params.signal?.aborted) return null;

      const nextFrequencies = freqsRsp.freqs.map((item) => item.freq);
      let resolvedAnalysisReq = analysisReq;
      let resolvedInboxReq = inboxReq;
      let resolvedInboxRsp = inboxRsp;
      let resolvedFreqsRsp = freqsRsp;

      if (shouldRebuildAnalysisRequests(params.queryState, allFrequencies, nextFrequencies)) {
        params.optionsFreqsRef.current = nextFrequencies;
        const rebuiltAnalysisReq = buildAnalysisReq(params.queryState, nextFrequencies);
        const rebuiltInboxReq = buildInboxReq(params.queryState, nextFrequencies);
        const rebuiltMessageInboxReq = buildInboxReq(params.queryState, nextFrequencies, true);
        if (
          isPresent(rebuiltAnalysisReq) &&
          isPresent(rebuiltInboxReq) &&
          isPresent(rebuiltMessageInboxReq)
        ) {
          try {
            const rebuiltInboxRsp = await fetchInboxMessages(
              { ...rebuiltMessageInboxReq, newestFirst: params.newestFirst },
              params.signal ? { signal: params.signal } : undefined,
            );
            const rebuiltFreqsRsp = await fetchAnalysisFreqs(
              rebuiltAnalysisReq,
              params.signal ? { signal: params.signal } : undefined,
            );
            if (isStaleReload() || params.signal?.aborted) return null;
            // Promote rebuilt req/rsp only after the rebuilt inbox succeeds so we never mix
            // rebuilt summary/count/map data with the old inbox response.
            params.setMessages(rebuiltInboxRsp.inboxItems ?? []);
            params.setProfiles((current) =>
              mergeSignalProfiles(current, rebuiltInboxRsp.signalProfiles ?? {}),
            );
            params.setGroupInfos((current) =>
              mergeSignalGroups(
                current,
                Object.fromEntries(
                  (rebuiltInboxRsp.signalGroups ?? []).map((item) => [item.masterKey, item]),
                ),
              ),
            );
            params.setSummaryCallsignsInfo(
              buildSummaryCallsignsInfo(rebuiltInboxRsp.callsigns, null),
            );
            params.setNoMoreToLoad(
              isAnalysisInboxPageExhausted(rebuiltInboxRsp.inboxItems, rebuiltInboxRsp.pageLimit),
            );
            resolvedAnalysisReq = rebuiltAnalysisReq;
            resolvedInboxReq = rebuiltInboxReq;
            resolvedInboxRsp = rebuiltInboxRsp;
            resolvedFreqsRsp = rebuiltFreqsRsp;
            void params.loadMessageComments?.(rebuiltInboxRsp.inboxItems ?? [], true);
          } catch (loadError) {
            if (isStaleReload() || isAbortError(loadError) || params.signal?.aborted) return null;
            if (!params.onUnauthorized(loadError)) {
              params.onError(toErrorMessage(loadError));
            }
          }
        }
      }

      const effectiveFreqsRsp = resolvedFreqsRsp;
      const effectiveFrequencies = effectiveFreqsRsp.freqs.map((item) => item.freq);
      const nextFreqCountsByValue = new Map(
        effectiveFreqsRsp.freqs.map((item) => [item.freq, item.count]),
      );
      const nextFreqOptions = sortFrequenciesNumerically(effectiveFrequencies).map((freq) => ({
        value: freq,
        label: normalizeFilterLabel(freq),
        count: nextFreqCountsByValue.get(freq) ?? 0,
      }));
      const nextNewFreqs = sortFrequenciesNumerically(
        effectiveFreqsRsp.freqs.filter((item) => item.isNew).map((item) => item.freq),
      ).map((freq) => ({
        value: freq,
        label: normalizeFilterLabel(freq),
        count: nextFreqCountsByValue.get(freq) ?? 0,
      }));
      params.setOptions((current) => ({
        ...current,
        freqs: nextFreqOptions,
        newFreqs: nextNewFreqs,
      }));
      const loadPlan =
        targetedReloadSections == null
          ? {
              mode: 'full' as const,
              sectionsToReload: filterSectionsForInitialLoad(params.queryState),
              loadedSections: params.getLoadedFilterSections?.() ?? [],
              selectedSections: filterSectionsForQueryState(params.queryState),
            }
          : {
              mode: 'targeted' as const,
              sectionsToReload: targetedReloadSections,
            };
      void params.loadInitialFilterSections(
        resolvedAnalysisReq,
        loadPlan,
        networkStatsCache,
        params.signal,
      );
      params.setTopFreqs(
        topItems(
          effectiveFreqsRsp.freqs,
          (item) => item.freq,
          (item) => item.count,
        ),
      );
      params.setMapDateRange({
        startDate: resolvedInboxReq.sinceDateInclusiveMs ?? 0,
        endDate: resolvedInboxReq.tillDateInclusiveMs ?? 0,
      });
      params.invalidateCallsignGraph();
      return {
        originalAnalysisReq: analysisReq,
        countsPromise,
        inboxReq: resolvedInboxReq,
        inboxRsp: resolvedInboxRsp,
        freqsRsp: resolvedFreqsRsp,
        resolvedAnalysisReq,
      };
    };

    const criticalData = await loadCriticalData(params.optionsFreqsRef.current);
    if (isNullOrUndefined(criticalData) || isStaleReload() || params.signal?.aborted) return;

    params.optionsFreqsRef.current = criticalData.freqsRsp.freqs.map((item) => item.freq);
    params.setFiltersLoading(false);
    params.setMessagesLoading(false);

    const loadCountsData = async () => {
      try {
        const countsPromise =
          criticalData.resolvedAnalysisReq === criticalData.originalAnalysisReq
            ? criticalData.countsPromise
            : fetchAnalysisCount(
                criticalData.resolvedAnalysisReq,
                params.signal ? { signal: params.signal } : undefined,
              );
        if (criticalData.resolvedAnalysisReq !== criticalData.originalAnalysisReq) {
          countsPromise.catch(() => undefined);
        }
        const countsRsp = await countsPromise;
        if (isStaleReload() || params.signal?.aborted) return;
        params.setCounts(countsRsp);
      } catch (loadError) {
        if (isStaleReload() || isAbortError(loadError) || params.signal?.aborted) return;
        if (!params.onUnauthorized(loadError)) params.onError(toErrorMessage(loadError));
      } finally {
        if (!isStaleReload() && !params.signal?.aborted) params.setCountsLoading(false);
      }
    };

    const loadReferenceData = async () => {
      try {
        const networksAnalysisReq = buildAnalysisReqForFilterSection(
          'networks',
          criticalData.resolvedAnalysisReq,
        );
        const [units, networksStatsRsp] = await Promise.all([
          getUnitsList(params.signal ? { signal: params.signal } : undefined),
          loadAnalysisNetworksWithCache(networksAnalysisReq, networkStatsCache, params.signal),
        ]);
        if (isStaleReload() || params.signal?.aborted) return;
        const unitsMap = Object.fromEntries(units.map((unit) => [unit.id, unit]));
        params.setUnitsMap(unitsMap);
        const networkIds = Array.from(
          new Set([
            ...networksStatsRsp.networks.map((item) => item.networkId),
            ...(criticalData.inboxRsp.inboxItems ?? []).flatMap(
              ([, message]) => message.networkIds ?? [],
            ),
          ]),
        );
        const networksByAnalysisIds =
          networkIds.length > 0
            ? await fetchNetworksByIds(
                networkIds,
                params.signal ? { signal: params.signal } : undefined,
              )
            : [];
        if (isStaleReload() || params.signal?.aborted) return;
        params.setNetworks((current) => {
          return mergeNetworks(current, networksByAnalysisIds);
        });
      } catch (loadError) {
        if (isStaleReload() || isAbortError(loadError) || params.signal?.aborted) return;
        if (!params.onUnauthorized(loadError)) params.onError(toErrorMessage(loadError));
      }
    };

    const loadMapData = async () => {
      try {
        const mapRsp = await fetchAnalysisMapPoints(
          {
            inboxItemsFilter: criticalData.inboxReq,
            mapFilter: null,
            pageId: ANALYSIS_SESSION_ACTIVITY_PAGE_ID,
          },
          params.signal ? { signal: params.signal } : undefined,
        );
        if (isStaleReload() || params.signal?.aborted) return;
        params.setMapPoints(mapRsp.points ?? []);
        params.setMapNetworkUnits(mapRsp.networkUnits ?? []);
        params.setMapOpenMessages([]);
      } catch (loadError) {
        if (isStaleReload() || isAbortError(loadError) || params.signal?.aborted) return;
        if (!params.onUnauthorized(loadError)) params.onError(toErrorMessage(loadError));
      } finally {
        if (!isStaleReload() && !params.signal?.aborted) params.setMapLoading(false);
      }
    };

    startedSecondaryLoads = true;
    params.invalidateSummaryLoads?.();
    params.invalidateTopSidebarLoads?.();
    const secondaryLoads = [loadCountsData(), loadReferenceData()];
    if (shouldLoadMap) {
      secondaryLoads.push(loadMapData());
    }
    if (params.shouldLoadNewCallsigns) {
      secondaryLoads.push(
        (async () => {
          try {
            const newCallsignsRsp = await fetchAnalysisNewCallsigns(
              criticalData.resolvedAnalysisReq,
              params.signal ? { signal: params.signal } : undefined,
            );
            if (isStaleReload() || params.signal?.aborted) return;
            params.setNewCallsigns(newCallsignsRsp);
            params.setNewCallsignsLoadedKey(JSON.stringify(criticalData.resolvedAnalysisReq));
          } catch (loadError) {
            if (isStaleReload() || isAbortError(loadError) || params.signal?.aborted) return;
            if (!params.onUnauthorized(loadError)) params.onError(toErrorMessage(loadError));
          } finally {
            if (!isStaleReload() && !params.signal?.aborted) params.setNewCallsignsLoading(false);
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
    if (isStaleReload() || params.signal?.aborted) return;
    if (!params.onUnauthorized(loadError)) params.onError(toErrorMessage(loadError));
  } finally {
    if (!isStaleReload() && !params.signal?.aborted) {
      params.setMessagesLoading(false);
      if (!startedSecondaryLoads) {
        params.setCountsLoading(false);
        params.setFiltersLoading(false);
        params.setNewCallsignsLoading(false);
        params.setMapLoading(false);
      }
    }
  }
}
