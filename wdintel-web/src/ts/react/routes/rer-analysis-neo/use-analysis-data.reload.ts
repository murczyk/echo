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
  fetchAnalysisPosts,
  fetchAnalysisSenders,
  fetchAnalysisTags,
  fetchAnalysisUnits,
  fetchInboxMessages,
  fetchNetworksByIds,
  getTagsForDisplay,
} from '../../services/api/analysis';
import { isAbortError } from '../../services/api/client';
import { getGroupInfosBatch } from '../../services/api/inbox-reference-data';
import { getUnitsByIds, getUnitsList, mergeUnitsById } from '../../services/api/units';
import {
  normalizeCallsignFilterValues,
  normalizeCallsignLookupValue,
} from '../../utils/callsign-normalization';
import { isNullOrUndefined, isPresent, sortFrequenciesNumerically } from '../../utils/misc';
import { getUnitIdFilterValue } from '../../utils/unit-search';
import {
  ANALYSIS_SESSION_ACTIVITY_PAGE_ID,
  buildAnalysisReq,
  buildInboxReq,
  shouldRebuildAnalysisRequests,
} from './helpers';
import { createMasterUnitText } from '../rer-duty-neo/utils';
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
  AnalysisMessagePageCursor,
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
  queryState: AnalysisQueryState;
  setAorEntries: Setter<AnalysisAorEntry[]>;
  setGroupInfos: Setter<Record<string, SignalGroupEntry>>;
  setNetworks: Setter<Network[]>;
  setOptions: Setter<AnalysisFilterOptions>;
  setProfiles: Setter<Record<string, SignalProfileEntry | null>>;
  setTagsMap: Setter<Record<number, Tag>>;
  setTagsOrder: Setter<number[]>;
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

function isFallbackNetworkLabel(option: AnalysisFilterOption): boolean {
  return option.label === `Network ${option.value}`;
}

function networkLabelWithUnits(network: Network, unitsMap: Record<number, Unit>): string {
  return createMasterUnitText(network, unitsMap).replace(/^р\/м\s*/, '');
}

async function loadMissingNetworkUnits(
  networks: Network[],
  unitsMap: Record<number, Unit>,
  requestOptions?: { signal?: AbortSignal },
): Promise<Record<number, Unit>> {
  const missingUnitIds = Array.from(
    new Set(networks.flatMap((network) => network.unitIds ?? [])),
  ).filter((unitId) => unitsMap[unitId] == null);
  const units = await getUnitsByIds(missingUnitIds, requestOptions);
  return {
    ...unitsMap,
    ...Object.fromEntries(units.map((unit) => [unit.id, unit])),
  };
}

function preferCompleteNetworkLabel(
  current: AnalysisFilterOption,
  next: AnalysisFilterOption,
): string {
  const currentIsFallback = isFallbackNetworkLabel(current);
  const nextIsFallback = isFallbackNetworkLabel(next);
  if (currentIsFallback && !nextIsFallback) return next.label;
  if (!currentIsFallback && nextIsFallback) return current.label;
  const currentLabel = normalizeFilterLabel(current.label);
  const nextLabel = normalizeFilterLabel(next.label);
  return nextLabel.length > currentLabel.length && nextLabel.includes(currentLabel)
    ? next.label
    : current.label;
}

function preferFreshNetworkLabel(
  current: AnalysisFilterOption,
  next: AnalysisFilterOption,
): string {
  if (isFallbackNetworkLabel(next) && !isFallbackNetworkLabel(current)) return current.label;
  const currentLabel = normalizeFilterLabel(current.label);
  const nextLabel = normalizeFilterLabel(next.label);
  return currentLabel.length > nextLabel.length && currentLabel.includes(nextLabel)
    ? current.label
    : next.label;
}

function mergeNetworkOptionValues(
  existing: AnalysisFilterOption,
  next: AnalysisFilterOption,
): string[] | undefined {
  const existingValues = existing.values ?? [existing.value];
  const nextValues = next.values ?? [next.value];
  const mergedValues = Array.from(new Set([...existingValues, ...nextValues]));
  return mergedValues.length > 0 ? mergedValues : undefined;
}

export function mergeHydratedNetworkFilterOptions(
  existing: AnalysisFilterOption[],
  next: AnalysisFilterOption[],
): AnalysisFilterOption[] {
  const merged = new Map<string, AnalysisFilterOption>();

  for (const option of existing) {
    merged.set(option.value, option);
  }

  for (const option of next) {
    const current = merged.get(option.value);
    if (current == null) {
      merged.set(option.value, option);
      continue;
    }

    merged.set(option.value, {
      value: option.value,
      label: preferCompleteNetworkLabel(current, option),
      count: Math.max(current.count, option.count),
      values: mergeNetworkOptionValues(current, option),
    });
  }

  return Array.from(merged.values()).sort(
    (left, right) => left.label.localeCompare(right.label) || left.value.localeCompare(right.value),
  );
}

export function replaceNetworkFilterOptionsPreservingSelectedLabels(
  current: AnalysisFilterOption[],
  nextStatsOptions: AnalysisFilterOption[],
  selectedNetworkValues: string[],
): AnalysisFilterOption[] {
  const nextByValue = new Map(nextStatsOptions.map((option) => [option.value, option]));
  const selectedValueSet = new Set(selectedNetworkValues);
  const selectedCurrentOptions = current.filter((option) => selectedValueSet.has(option.value));

  const replaced = nextStatsOptions.map((option) => {
    const currentOption = selectedCurrentOptions.find((item) => item.value === option.value);
    if (currentOption == null) {
      return option;
    }

    return {
      value: option.value,
      label: preferFreshNetworkLabel(currentOption, option),
      count: option.count,
      values: mergeNetworkOptionValues(currentOption, option),
    };
  });

  const appendedSelected = selectedCurrentOptions
    .filter((option) => !nextByValue.has(option.value))
    .map((option) => ({
      ...option,
      count: 0,
      values: option.values ?? [option.value],
    }));

  return [...replaced, ...appendedSelected].sort(
    (left, right) => left.label.localeCompare(right.label) || left.value.localeCompare(right.value),
  );
}

export function buildHydratedNetworkFilterOptions(
  networks: Network[],
  selectedNetworkIds: number[],
  unitsMap: Record<number, Unit>,
): AnalysisFilterOption[] {
  const selectedNetworkIdSet = new Set(selectedNetworkIds);
  return networks
    .filter((network) => selectedNetworkIdSet.has(network.id))
    .map((network) => ({
      value: String(network.id),
      label: normalizeFilterLabel(networkLabelWithUnits(network, unitsMap)),
      count: 0,
    }));
}

export function buildNetworkStatsFilterOptions(
  networkStats: Awaited<ReturnType<typeof fetchAnalysisNetworks>>,
  networks: Network[],
  unitsMap: Record<number, Unit>,
): AnalysisFilterOption[] {
  const networkNamesById = new Map(
    networkStats.networkNames.map((network) => [network.id, network.name]),
  );
  const networksById = new Map(networks.map((network) => [network.id, network]));

  return networkStats.networks.map((networkStat) => {
    const value = String(networkStat.networkId);
    const statsOption = {
      value,
      label: normalizeFilterLabel(
        networkNamesById.get(networkStat.networkId) ?? `Network ${networkStat.networkId}`,
      ),
      count: networkStat.count,
    };
    const network = networksById.get(networkStat.networkId);
    if (network == null) return statsOption;

    const hydratedOption = {
      ...statsOption,
      label: normalizeFilterLabel(networkLabelWithUnits(network, unitsMap)),
    };
    return {
      ...statsOption,
      label: preferCompleteNetworkLabel(statsOption, hydratedOption),
    };
  });
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
  includeDefaultSections = true,
  additionalSections: AnalysisFilterSectionId[] = [],
): AnalysisFilterSectionId[] {
  const sections = new Set<AnalysisFilterSectionId>(
    includeDefaultSections ? ['tags', 'groups', 'senders'] : [],
  );
  filterSectionsForQueryState(queryState).forEach((section) => {
    sections.add(section);
  });
  additionalSections.forEach((section) => sections.add(section));
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
      // The tags facet must show every tag regardless of the current tag filter, so
      // strip all self-referential tag conditions — not just `selectedTags`. Leaving
      // `deniedTags`/`tagPresence` in place would compute the option list from messages
      // that already exclude the denied tag, dropping it from its own picker.
      return { ...analysisReq, selectedTags: null, deniedTags: null, tagPresence: null };
    case 'aors':
      return { ...analysisReq, selectedAors: null };
    case 'groups':
      return { ...analysisReq, selectedGroups: null };
    case 'senders':
      return { ...analysisReq, selectedSenders: null };
    case 'callsigns':
      return { ...analysisReq, selectedCallsigns: null };
    case 'units':
      return { ...analysisReq, selectedUnits: null, selectedUnitIds: null };
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
      const [tagsRsp, tagsDisplay] = await Promise.all([
        fetchAnalysisTags(context.analysisReq, requestOptions),
        getTagsForDisplay(requestOptions),
      ]);
      if (isStale() || isAborted()) return;
      context.setTagsMap(tagsDisplay.tagsMap);
      context.setTagsOrder(tagsDisplay.tagsOrder);
      context.setOptions((current) => ({
        ...current,
        tags: toFilterOptions(
          tagsRsp.tags,
          (item) => String(item.tagId),
          (item) => tagsDisplay.tagsMap[item.tagId]?.label ?? String(item.tagId),
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
      const returnedGroupKeys = new Set(groupsRsp.groupNames.map((item) => item.masterKey));
      const missingSelectedGroupKeys = Array.from(
        new Set(
          context.queryState.groupsSelected.filter(
            (masterKey) => !returnedGroupKeys.has(masterKey),
          ),
        ),
      );
      const missingSelectedGroupInfos = await getGroupInfosBatch(
        missingSelectedGroupKeys,
        requestOptions,
      );
      if (isStale() || isAborted()) return;
      const groupInfosByKey: Record<string, SignalGroupEntry> = {};
      [...groupsRsp.groupNames, ...missingSelectedGroupInfos].forEach((item) => {
        groupInfosByKey[item.masterKey] = item;
      });
      context.setGroupInfos((current) => ({ ...current, ...groupInfosByKey }));
      context.setOptions((current) => ({
        ...current,
        groups: [
          ...toFilterOptions(
            groupsRsp.groups,
            (item) => item.masterKey,
            (item) => groupInfosByKey[item.masterKey]?.name ?? item.masterKey,
            (item) => item.count,
          ),
          ...missingSelectedGroupInfos
            .filter((item) => !groupsRsp.groups.some((group) => group.masterKey === item.masterKey))
            .map((item) => ({ value: item.masterKey, label: item.name, count: 0 })),
        ],
      }));
      return;
    }
    case 'senders': {
      const sendersRsp = await fetchAnalysisSenders(context.analysisReq, requestOptions);
      if (isStale() || isAborted()) return;
      const senderProfiles = sendersRsp.senderNames ?? {};
      context.setProfiles((current) => mergeSignalProfiles(current, senderProfiles));
      context.setOptions((current) => ({
        ...current,
        senders: buildSenderFilterOptions(sendersRsp.senders, senderProfiles),
      }));
      return;
    }
    case 'callsigns': {
      const callsignsRsp = await fetchAnalysisCallsigns(context.analysisReq, requestOptions);
      if (isStale() || isAborted()) return;
      const groupedByLabel = new Map<string, AnalysisFilterOption>();
      callsignsRsp.callsigns.forEach((item) => {
        const value = normalizeCallsignLookupValue(item.callsign);
        if (value === '') return;
        const label = value.toLocaleUpperCase('uk-UA');
        const existing = groupedByLabel.get(label);
        if (isPresent(existing)) {
          existing.count += item.count;
          existing.values = normalizeCallsignFilterValues([
            ...(existing.values ?? [existing.value]),
            value,
          ]);
          return;
        }
        groupedByLabel.set(label, {
          value,
          label,
          count: item.count,
          values: [value],
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
          (item) => getUnitIdFilterValue(item.unitId),
          (item) => item.name,
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
      const unitsMap = await loadMissingNetworkUnits(
        networksById,
        context.unitsMap,
        requestOptions,
      );
      if (isStale() || isAborted()) return;
      const networkNamesById = Object.fromEntries(
        networksStatsRsp.networkNames.map((network) => [network.id, network.name]),
      );
      const hydratedNetworksById = new Map(networksById.map((network) => [network.id, network]));
      context.setNetworks((current) => mergeNetworks(current, networksById));
      context.setOptions((current) => ({
        ...current,
        networks: replaceNetworkFilterOptionsPreservingSelectedLabels(
          current.networks,
          toFilterOptions(
            networksStatsRsp.networks,
            (item) => String(item.networkId),
            (item) => {
              const network = hydratedNetworksById.get(item.networkId);
              return normalizeFilterLabel(
                network
                  ? networkLabelWithUnits(network, unitsMap)
                  : (networkNamesById[item.networkId] ?? `Network ${item.networkId}`),
              );
            },
            (item) => item.count,
          ),
          context.queryState.networksSelected,
        ),
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

export function transformMessagePageResponse<
  T extends { inboxItems: Array<[number, InboxMessage]> },
>(response: T, cursor: AnalysisMessagePageCursor | undefined): T {
  if (isNullOrUndefined(cursor)) return response;
  const limitedMessages = cursor.resultLimit
    ? response.inboxItems.slice(0, cursor.resultLimit)
    : response.inboxItems;
  return {
    ...response,
    inboxItems: cursor.reverseResults ? [...limitedMessages].reverse() : limitedMessages,
  };
}

type ReloadParams = {
  clearAnalysisResults: () => void;
  invalidateCorrelatedFreqsCache: () => void;
  invalidateCallsignGraph: (options?: { clearGraph?: boolean }) => void;
  invalidateMessagePaging: () => void;
  includeDefaultFilterSections?: boolean;
  messagePageCursor?: AnalysisMessagePageCursor;
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
  applyMapSettlements: (
    settlements: import('../../../../Bindings').MapSettlement[],
    requestedShowSettlements: boolean,
  ) => void;
  setMapOpenMessages: Setter<Array<[number, InboxMessage]>>;
  setMapPoints: Setter<import('../../../../Bindings').FreqDetailedPoint[]>;
  showSettlements: boolean;
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
  setTagsOrder: Setter<number[]>;
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
      const messagePageCursor = params.messagePageCursor;
      const inboxPromise = fetchInboxMessages(
        {
          ...messageInboxReq,
          beforeIdNoninclusive:
            messagePageCursor?.beforeIdNoninclusive ?? messageInboxReq.beforeIdNoninclusive,
          sinceIdNoninclusive:
            messagePageCursor?.sinceIdNoninclusive ?? messageInboxReq.sinceIdNoninclusive,
          newestFirst: messagePageCursor?.requestNewestFirst ?? params.newestFirst,
        },
        params.signal ? { signal: params.signal } : undefined,
      );
      const freqsPromise = fetchAnalysisFreqs(
        analysisReq,
        params.signal ? { signal: params.signal } : undefined,
      );
      void freqsPromise.catch(() => undefined);

      let inboxRsp: Awaited<ReturnType<typeof fetchInboxMessages>>;
      try {
        inboxRsp = transformMessagePageResponse(await inboxPromise, messagePageCursor);
      } catch (loadError) {
        if (isAbortError(loadError) || params.signal?.aborted) return null;
        throw loadError;
      }
      if (isStaleReload() || params.signal?.aborted) return null;

      const displayedMessages = inboxRsp.inboxItems ?? [];
      params.setMessages(displayedMessages);
      params.setProfiles((current) => mergeSignalProfiles(current, inboxRsp.signalProfiles ?? {}));
      params.setGroupInfos((current) =>
        mergeSignalGroups(
          current,
          Object.fromEntries((inboxRsp.signalGroups ?? []).map((item) => [item.masterKey, item])),
        ),
      );
      params.setSummaryCallsignsInfo(buildSummaryCallsignsInfo(inboxRsp.callsigns, null));
      params.setNoMoreToLoad(isAnalysisInboxPageExhausted(displayedMessages, inboxRsp.pageLimit));
      params.setHasLoadedInitialMessages(true);
      params.setMessagesLoading(false);
      void params.loadMessageComments?.(displayedMessages, true);

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
              {
                ...rebuiltMessageInboxReq,
                beforeIdNoninclusive:
                  messagePageCursor?.beforeIdNoninclusive ??
                  rebuiltMessageInboxReq.beforeIdNoninclusive,
                sinceIdNoninclusive:
                  messagePageCursor?.sinceIdNoninclusive ??
                  rebuiltMessageInboxReq.sinceIdNoninclusive,
                newestFirst: messagePageCursor?.requestNewestFirst ?? params.newestFirst,
              },
              params.signal ? { signal: params.signal } : undefined,
            );
            if (isStaleReload() || params.signal?.aborted) return null;

            const rebuiltMessagePageRsp = transformMessagePageResponse(
              rebuiltInboxRsp,
              messagePageCursor,
            );
            const rebuiltFreqsRsp = await fetchAnalysisFreqs(
              rebuiltAnalysisReq,
              params.signal ? { signal: params.signal } : undefined,
            );
            if (isStaleReload() || params.signal?.aborted) return null;
            // Promote rebuilt req/rsp only after the rebuilt inbox succeeds so we never mix
            // rebuilt summary/count/map data with the old inbox response.
            const displayedRebuiltMessages = rebuiltMessagePageRsp.inboxItems ?? [];
            params.setMessages(displayedRebuiltMessages);
            params.setProfiles((current) =>
              mergeSignalProfiles(current, rebuiltMessagePageRsp.signalProfiles ?? {}),
            );
            params.setGroupInfos((current) =>
              mergeSignalGroups(
                current,
                Object.fromEntries(
                  (rebuiltMessagePageRsp.signalGroups ?? []).map((item) => [item.masterKey, item]),
                ),
              ),
            );
            params.setSummaryCallsignsInfo(
              buildSummaryCallsignsInfo(rebuiltMessagePageRsp.callsigns, null),
            );
            params.setNoMoreToLoad(
              isAnalysisInboxPageExhausted(
                displayedRebuiltMessages,
                rebuiltMessagePageRsp.pageLimit,
              ),
            );
            resolvedAnalysisReq = rebuiltAnalysisReq;
            resolvedInboxReq = rebuiltInboxReq;
            resolvedInboxRsp = rebuiltMessagePageRsp;
            resolvedFreqsRsp = rebuiltFreqsRsp;
            void params.loadMessageComments?.(displayedRebuiltMessages, true);
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
              sectionsToReload: filterSectionsForInitialLoad(
                params.queryState,
                params.includeDefaultFilterSections !== false,
                params.rightSidebarVisible && params.rightSidebarTab === 'stats'
                  ? ['groups']
                  : params.rightSidebarVisible && params.rightSidebarTab === 'callsigns'
                    ? ['callsigns']
                    : [],
              ),
              loadedSections:
                params.includeDefaultFilterSections !== false
                  ? (params.getLoadedFilterSections?.() ?? [])
                  : [],
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
      params.invalidateCallsignGraph({ clearGraph: true });
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
    if (isNullOrUndefined(criticalData) || isStaleReload() || params.signal?.aborted) {
      return;
    }

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
        const selectedNetworkIds = params.queryState.networksSelected
          .map((value) => Number(value))
          .filter(Number.isFinite);
        const networkIds = Array.from(
          new Set([
            ...networksStatsRsp.networks.map((item) => item.networkId),
            ...(criticalData.inboxRsp.inboxItems ?? []).flatMap(
              ([, message]) => message.networkIds ?? [],
            ),
            ...selectedNetworkIds,
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
        const referencedUnitIds = Array.from(
          new Set([
            ...networksByAnalysisIds.flatMap((network) => network.unitIds ?? []),
            ...criticalData.inboxRsp.callsigns.flatMap((callsign) =>
              callsign.res.flatMap((info) => (info.unitId == null ? [] : [info.unitId])),
            ),
          ]),
        );
        const referencedUnits = await getUnitsByIds(
          referencedUnitIds,
          params.signal ? { signal: params.signal } : undefined,
        );
        if (isStaleReload() || params.signal?.aborted) return;
        const unitsMap = Object.fromEntries(
          mergeUnitsById(units, referencedUnits).map((unit) => [unit.id, unit]),
        );
        params.setUnitsMap(unitsMap);
        params.setNetworks((current) => {
          return mergeNetworks(current, networksByAnalysisIds);
        });
        const hydratedSelectedNetworkOptions = buildHydratedNetworkFilterOptions(
          networksByAnalysisIds,
          selectedNetworkIds,
          unitsMap,
        );
        const networkStatsOptions = buildNetworkStatsFilterOptions(
          networksStatsRsp,
          networksByAnalysisIds,
          unitsMap,
        );
        params.setOptions((current) => {
          const hydratedOptions = mergeHydratedNetworkFilterOptions(
            current.networks,
            hydratedSelectedNetworkOptions,
          );
          return {
            ...current,
            networks: replaceNetworkFilterOptionsPreservingSelectedLabels(
              hydratedOptions,
              networkStatsOptions,
              params.queryState.networksSelected,
            ),
          };
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
            showSettlements: params.showSettlements,
          },
          params.signal ? { signal: params.signal } : undefined,
        );
        if (isStaleReload() || params.signal?.aborted) return;
        params.setMapPoints(mapRsp.points ?? []);
        params.setMapNetworkUnits(mapRsp.networkUnits ?? []);
        params.applyMapSettlements(mapRsp.settlements ?? [], params.showSettlements);
        params.setMapOpenMessages([]);
      } catch (loadError) {
        if (isStaleReload() || isAbortError(loadError) || params.signal?.aborted) return;
        if (!params.onUnauthorized(loadError)) params.onError(toErrorMessage(loadError));
      } finally {
        if (!isStaleReload() && !params.signal?.aborted) params.setMapLoading(false);
      }
    };

    const loadCardTagData = async () => {
      try {
        const tagsDisplay = await getTagsForDisplay(
          params.signal ? { signal: params.signal } : undefined,
        );
        if (isStaleReload() || params.signal?.aborted) return;
        params.setTagsMap(tagsDisplay.tagsMap);
        params.setTagsOrder(tagsDisplay.tagsOrder);
      } catch (loadError) {
        if (isStaleReload() || isAbortError(loadError) || params.signal?.aborted) return;
        if (!params.onUnauthorized(loadError)) params.onError(toErrorMessage(loadError));
      }
    };

    startedSecondaryLoads = true;
    params.invalidateSummaryLoads?.();
    params.invalidateTopSidebarLoads?.();
    const secondaryLoads = [loadCountsData(), loadReferenceData(), loadCardTagData()];
    if (shouldLoadMap) {
      secondaryLoads.push(loadMapData());
    }
    if (!params.shouldLoadNewCallsigns) {
      params.setNewCallsigns(emptyNewCallsigns);
      params.setNewCallsignsLoading(false);
      params.setNewCallsignsLoadedKey(null);
    }
    void Promise.all(secondaryLoads);
    return;
  } catch (loadError) {
    if (isStaleReload() || params.signal?.aborted) {
      return;
    }
    if (!params.onUnauthorized(loadError)) params.onError(toErrorMessage(loadError));
    return;
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
