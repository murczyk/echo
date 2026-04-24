import dayjs from 'dayjs';

import type { AnalysisStatsReq, InboxMessagesReq, SavedFilter } from '../../../../Bindings';
import {
  hasRerAnalysisQueryStateParams,
  loadRerAnalysisQueryState,
  parseRerAnalysisQueryStateFromSearchParams,
  saveRerAnalysisQueryState,
  writeRerAnalysisQueryStateToSearchParams,
} from '../../../rer-analysis-query-state';
import {
  APP_TIME_ZONE,
  combineDateTimeInputToMs,
  formatDateTimeInputValueInTimeZone,
} from '../../utils/misc';
import type { AnalysisQueryState } from './types';

export const ANALYSIS_ROUTE_PAGE_ID = 'rer-analysis-neo';
// Keep old and new analysis pages grouped in session activity while both coexist.
export const ANALYSIS_SESSION_ACTIVITY_PAGE_ID = 'rer-analysis';
export const ADJACENT_FREQS_RANGE_OPTIONS = [0, 0.0005, 0.002, 0.005] as const;

/** Duty / deep links append `?showMap=true` so the map center tab opens (see `buildRerAnalysisNeoHref` in rer-duty-neo). */
export function shouldOpenAnalysisMapFromSearchParams(searchParams: URLSearchParams): boolean {
  const v = searchParams.get('showMap');
  return v === 'true';
}

function findAllAdjacentFreqs(allFrequencies: string[], selectedFrequencies: string[], range: number): string[] {
  if (range <= 0) return [];
  return allFrequencies.filter((freq) => {
    if (selectedFrequencies.includes(freq)) return false;
    const freqN = parseFloat(freq);
    if (Number.isNaN(freqN)) return false;
    return selectedFrequencies.some((selected) => {
      const selectedN = parseFloat(selected);
      if (Number.isNaN(selectedN)) return false;
      return freqN >= selectedN - range && freqN <= selectedN + range;
    });
  });
}

export function emptyQueryState(): AnalysisQueryState {
  return {
    fromDateTimeStr: '',
    toDateTimeStr: '',
    includeOnlyNewFreqs: false,
    aorsSelected: [],
    groupsSelected: [],
    sendersSelected: [],
    freqsSelected: [],
    callsignsSelected: [],
    unitsSelected: [],
    locationsSelected: [],
    postsSelected: [],
    networksSelected: [],
    withoutNetwork: false,
    orWithExtendedForm: false,
    orBookmarked: false,
    orImportant: false,
    orWithCoords: false,
    orWithoutCoords: false,
    search: '',
    metadataCc: [],
    metadataSender: [],
    metadataReceiver: [],
    metadataHash: [],
    onlyWithMetadata: false,
    withoutMetadata: false,
    tags: [],
    includePelengLocations: true,
    // Important: `null` means "use the server-side default".
    // Neo must preserve this tri-state instead of hard-coding exact-match mode.
    unitsExactMatchOnly: null,
    adjacentFreqsRange: 0,
    withoutModelTags: false,
    filterTagsOption: 'OneOfTags',
    reportTagsOnlyThisUnit: false,
  };
}

function getDefaultAnalysisDateRange(now: Date): { fromDateTimeStr: string; toDateTimeStr: string } {
  const startOfTodayInAppTz = dayjs(now).tz(APP_TIME_ZONE).startOf('day');
  const startOfTomorrowInAppTz = startOfTodayInAppTz.add(1, 'day');

  return {
    fromDateTimeStr: startOfTodayInAppTz.format('YYYY-MM-DDTHH:mm'),
    toDateTimeStr: startOfTomorrowInAppTz.format('YYYY-MM-DDTHH:mm'),
  };
}

export function parseQueryStateFromWindow(): AnalysisQueryState {
  if (typeof window === 'undefined') return emptyQueryState();

  const url = new URL(window.location.href);
  const flatStateFromUrl = parseRerAnalysisQueryStateFromSearchParams(url.searchParams);

  // Startup order is intentional:
  // 1) URL params win
  // 2) persisted localStorage fills the gap when URL is empty
  // 3) hard-coded defaults apply only when neither source has a value
  const storedState = loadRerAnalysisQueryState();
  const hasManagedStateInUrl = hasRerAnalysisQueryStateParams(url.searchParams);

  return {
    ...emptyQueryState(),
    ...(hasManagedStateInUrl ? {} : (storedState ?? {})),
    ...(flatStateFromUrl ?? {}),
  };
}

export function createInitialQueryState(
  parsed: AnalysisQueryState,
  now: Date = new Date(),
): AnalysisQueryState {
  if (parsed.fromDateTimeStr !== '' && parsed.toDateTimeStr !== '') return parsed;

  const defaultDateRange = getDefaultAnalysisDateRange(now);
  return {
    ...emptyQueryState(),
    ...parsed,
    fromDateTimeStr: parsed.fromDateTimeStr || defaultDateRange.fromDateTimeStr,
    toDateTimeStr: parsed.toDateTimeStr || defaultDateRange.toDateTimeStr,
  };
}

export function createResetQueryState(now: Date = new Date()): AnalysisQueryState {
  return createInitialQueryState(emptyQueryState(), now);
}

export function hasMeaningfulFiltersBeyondDateRange(state: AnalysisQueryState): boolean {
  const stateKey = queryStateComparisonKey(state);
  const defaultKey = queryStateComparisonKey(createResetQueryState());
  if (stateKey == null || defaultKey == null) return false;

  return stateKey !== defaultKey;
}

export function pushQueryStateToUrl(state: AnalysisQueryState) {
  if (typeof window === 'undefined') return;
  saveRerAnalysisQueryState(state);
  const url = new URL(window.location.href);
  writeRerAnalysisQueryStateToSearchParams(url.searchParams, state);
  window.history.replaceState({}, '', `${url.pathname}?${url.searchParams.toString()}`);
}

export function normalizeQueryState(state: AnalysisQueryState): AnalysisQueryState {
  let next = state;

  if (state.withoutMetadata) {
    next = {
      ...next,
      metadataCc: [],
      metadataSender: [],
      metadataReceiver: [],
      metadataHash: [],
      onlyWithMetadata: false,
    };
  }

  if (next.onlyWithMetadata) {
    next = { ...next, withoutMetadata: false };
  }

  if (next.withoutNetwork) {
    next = { ...next, networksSelected: [] };
  }

  if (next.orWithCoords && next.orWithoutCoords) {
    next = { ...next, orWithCoords: false, orWithoutCoords: false };
  } else if (next.orWithoutCoords) {
    next = { ...next, orWithCoords: false };
  }

  return next;
}

export function buildAnalysisReq(state: AnalysisQueryState, allFrequencies: string[] = []): AnalysisStatsReq | null {
  const query = normalizeQueryState(state);
  const sinceDateInclusiveMs = combineDateTimeInputToMs(query.fromDateTimeStr ?? '', APP_TIME_ZONE);
  const tillDateNoninclusiveMs = combineDateTimeInputToMs(query.toDateTimeStr ?? '', APP_TIME_ZONE);

  if (sinceDateInclusiveMs == null || tillDateNoninclusiveMs == null) {
    return null;
  }

  const expandedFreqs =
    query.adjacentFreqsRange > 0
      ? Array.from(new Set([...query.freqsSelected, ...findAllAdjacentFreqs(allFrequencies, query.freqsSelected, query.adjacentFreqsRange)]))
      : query.freqsSelected;

  return {
    sinceDateInclusiveMs,
    tillDateNoninclusiveMs,
    selectedGroups: query.groupsSelected.length ? query.groupsSelected : null,
    selectedSenders: query.sendersSelected.length ? query.sendersSelected : null,
    selectedFreqs: expandedFreqs.length ? expandedFreqs : null,
    selectedPosts: query.postsSelected.length ? query.postsSelected : null,
    selectedCallsigns: query.callsignsSelected.length ? query.callsignsSelected : null,
    selectedUnits: query.unitsSelected.length ? query.unitsSelected : null,
    selectedLocations: query.locationsSelected.length ? query.locationsSelected : null,
    selectedAors: query.aorsSelected.length ? query.aorsSelected.map((value) => Number(value)).filter(Number.isFinite) : null,
    orWithExtendedForm: query.orWithExtendedForm,
    orBookmarked: query.orBookmarked,
    orImportant: query.orImportant,
    orWithCoords: query.orWithCoords,
    orWithoutCoords: query.orWithoutCoords,
    search: query.search.trim() === '' ? null : query.search.trim(),
    selectedTags: query.tags.length ? query.tags : null,
    selectedNetworks: query.withoutNetwork ? null : query.networksSelected.map((value) => Number(value)).filter(Number.isFinite),
    withoutNetwork: query.withoutNetwork,
    metadataCc: query.metadataCc.length ? query.metadataCc : null,
    metadataSender: query.metadataSender.length ? query.metadataSender : null,
    metadataReceiver: query.metadataReceiver.length ? query.metadataReceiver : null,
    metadataHash: query.metadataHash.length ? query.metadataHash : null,
    onlyWithMetadata: query.onlyWithMetadata,
    withoutMetadata: query.withoutMetadata,
    includePelengLocations: query.includePelengLocations,
    unitsExactMatchOnly: query.unitsExactMatchOnly,
    filterTagsOption: query.filterTagsOption,
    withoutModelTags: query.withoutModelTags,
    reportTagsOnlyThisUnit: query.reportTagsOnlyThisUnit,
  };
}

export function buildInboxReq(state: AnalysisQueryState, allFrequencies: string[] = []): InboxMessagesReq | null {
  const req = buildAnalysisReq(state, allFrequencies);
  if (req == null) return null;

  return {
    sinceIdNoninclusive: null,
    beforeIdNoninclusive: null,
    sinceDateInclusiveMs: req.sinceDateInclusiveMs,
    tillDateInclusiveMs: req.tillDateNoninclusiveMs,
    onlyShowUnprocessed: null,
    checkedOnly: false,
    selectedGroups: req.selectedGroups,
    deniedGroups: null,
    selectedSenders: req.selectedSenders,
    deniedSenders: null,
    selectedFreqs: req.selectedFreqs,
    selectedPosts: req.selectedPosts,
    deniedPosts: null,
    deniedFreqs: null,
    selectedCallsigns: req.selectedCallsigns,
    selectedUnits: req.selectedUnits,
    selectedLocations: req.selectedLocations,
    nolimit: null,
    orWithExtendedForm: req.orWithExtendedForm,
    loadLatest: null,
    returnDuplicates: null,
    orBookmarked: req.orBookmarked,
    orImportant: req.orImportant,
    orWithCoords: req.orWithCoords,
    orWithoutCoords: req.orWithoutCoords,
    newestFirst: true,
    search: req.search,
    highlightCallsigns: true,
    highlightKeywords: true,
    highlightSearchres: true,
    highlightSignals: null,
    highlightPoints: true,
    selectedTags: req.selectedTags,
    selectedAors: req.selectedAors,
    selectedNetworks: req.selectedNetworks,
    withoutNetwork: req.withoutNetwork,
    metadataCc: req.metadataCc,
    metadataSender: req.metadataSender,
    metadataReceiver: req.metadataReceiver,
    metadataHash: req.metadataHash,
    onlyWithMetadata: req.onlyWithMetadata,
    withoutMetadata: req.withoutMetadata,
    sortBy: null,
    reportTagsOnlyThisUnit: req.reportTagsOnlyThisUnit,
    ignoreImportedCoords: null,
    includePelengLocations: req.includePelengLocations,
    unitsExactMatchOnly: req.unitsExactMatchOnly,
    calculateFreqPelengsSummary: null,
    skipGroupStats: true,
    filterTagsOption: req.filterTagsOption,
    pageId: ANALYSIS_SESSION_ACTIVITY_PAGE_ID,
    withoutModelTags: req.withoutModelTags,
  };
}

export function shouldRebuildAnalysisRequests(
  state: AnalysisQueryState,
  currentFrequencies: string[] = [],
  nextFrequencies: string[] = [],
): boolean {
  if (state.adjacentFreqsRange <= 0 || state.freqsSelected.length === 0 || nextFrequencies.length === 0) {
    return false;
  }

  const currentReq = buildAnalysisReq(state, currentFrequencies);
  const nextReq = buildAnalysisReq(state, nextFrequencies);
  if (currentReq == null || nextReq == null) return false;

  return JSON.stringify(currentReq.selectedFreqs ?? []) !== JSON.stringify(nextReq.selectedFreqs ?? []);
}

export function queryStateFromSavedFilter(savedFilter: SavedFilter, current: AnalysisQueryState): AnalysisQueryState {
  const req = savedFilter.req;
  return normalizeQueryState({
    ...current,
    includeOnlyNewFreqs: false,
    adjacentFreqsRange: 0,
    aorsSelected: (req.selectedAors ?? []).map(String),
    groupsSelected: req.selectedGroups ?? [],
    sendersSelected: req.selectedSenders ?? [],
    freqsSelected: req.selectedFreqs ?? [],
    callsignsSelected: req.selectedCallsigns ?? [],
    unitsSelected: req.selectedUnits ?? [],
    locationsSelected: req.selectedLocations ?? [],
    postsSelected: req.selectedPosts ?? [],
    networksSelected: (req.selectedNetworks ?? []).map(String),
    withoutNetwork: req.withoutNetwork ?? false,
    orWithExtendedForm: req.orWithExtendedForm ?? false,
    orBookmarked: req.orBookmarked ?? false,
    orImportant: req.orImportant ?? false,
    orWithCoords: req.orWithCoords ?? false,
    orWithoutCoords: req.orWithoutCoords ?? false,
    search: req.search ?? '',
    metadataCc: req.metadataCc ?? [],
    metadataSender: req.metadataSender ?? [],
    metadataReceiver: req.metadataReceiver ?? [],
    metadataHash: req.metadataHash ?? [],
    onlyWithMetadata: req.onlyWithMetadata ?? false,
    withoutMetadata: req.withoutMetadata ?? false,
    tags: req.selectedTags ?? [],
    includePelengLocations: req.includePelengLocations ?? true,
    unitsExactMatchOnly: req.unitsExactMatchOnly,
    withoutModelTags: req.withoutModelTags ?? false,
    filterTagsOption: req.filterTagsOption ?? 'OneOfTags',
    reportTagsOnlyThisUnit: req.reportTagsOnlyThisUnit ?? false,
  });
}

function canonicalizeAnalysisReqToQueryState(req: AnalysisStatsReq): AnalysisQueryState {
  const normalized = { ...req };

  if (normalized.onlyWithMetadata == null) {
    normalized.onlyWithMetadata = false;
  }
  if (normalized.withoutMetadata == null) {
    normalized.withoutMetadata = false;
  }
  if (normalized.withoutNetwork == null) {
    normalized.withoutNetwork = false;
  }
  if (normalized.orWithExtendedForm == null) {
    normalized.orWithExtendedForm = false;
  }
  if (normalized.orBookmarked == null) {
    normalized.orBookmarked = false;
  }
  if (normalized.orImportant == null) {
    normalized.orImportant = false;
  }
  if (normalized.orWithCoords == null) {
    normalized.orWithCoords = false;
  }
  if (normalized.orWithoutCoords == null) {
    normalized.orWithoutCoords = false;
  }
  if (normalized.includePelengLocations == null) {
    normalized.includePelengLocations = true;
  }
  if (normalized.filterTagsOption == null) {
    normalized.filterTagsOption = 'OneOfTags';
  }
  if (normalized.withoutModelTags == null) {
    normalized.withoutModelTags = false;
  }
  if (normalized.reportTagsOnlyThisUnit == null) {
    normalized.reportTagsOnlyThisUnit = false;
  }

  return normalizeQueryState({
    ...emptyQueryState(),
    includeOnlyNewFreqs: false,
    fromDateTimeStr: formatDateTimeInputValueInTimeZone(new Date(normalized.sinceDateInclusiveMs), APP_TIME_ZONE),
    toDateTimeStr: formatDateTimeInputValueInTimeZone(new Date(normalized.tillDateNoninclusiveMs), APP_TIME_ZONE),
    aorsSelected: (normalized.selectedAors ?? []).map(String),
    groupsSelected: normalized.selectedGroups ?? [],
    sendersSelected: normalized.selectedSenders ?? [],
    freqsSelected: normalized.selectedFreqs ?? [],
    callsignsSelected: normalized.selectedCallsigns ?? [],
    unitsSelected: normalized.selectedUnits ?? [],
    locationsSelected: normalized.selectedLocations ?? [],
    postsSelected: normalized.selectedPosts ?? [],
    networksSelected: (normalized.selectedNetworks ?? []).map(String),
    withoutNetwork: normalized.withoutNetwork,
    orWithExtendedForm: normalized.orWithExtendedForm,
    orBookmarked: normalized.orBookmarked,
    orImportant: normalized.orImportant,
    orWithCoords: normalized.orWithCoords,
    orWithoutCoords: normalized.orWithoutCoords,
    search: normalized.search ?? '',
    metadataCc: normalized.metadataCc ?? [],
    metadataSender: normalized.metadataSender ?? [],
    metadataReceiver: normalized.metadataReceiver ?? [],
    metadataHash: normalized.metadataHash ?? [],
    onlyWithMetadata: normalized.onlyWithMetadata,
    withoutMetadata: normalized.withoutMetadata,
    tags: normalized.selectedTags ?? [],
    includePelengLocations: normalized.includePelengLocations,
    unitsExactMatchOnly: normalized.unitsExactMatchOnly ?? null,
    withoutModelTags: normalized.withoutModelTags,
    filterTagsOption: normalized.filterTagsOption,
    reportTagsOnlyThisUnit: normalized.reportTagsOnlyThisUnit,
  });
}

function analysisReqComparisonKey(req: AnalysisStatsReq, allFrequencies: string[] = []): string | null {
  const normalized = buildAnalysisReq(canonicalizeAnalysisReqToQueryState(req), allFrequencies);
  if (normalized == null) return null;

  const { sinceDateInclusiveMs: _sinceDateInclusiveMs, tillDateNoninclusiveMs: _tillDateNoninclusiveMs, ...rest } = normalized;
  return JSON.stringify(rest);
}

export function queryStateComparisonKey(state: AnalysisQueryState, allFrequencies: string[] = []): string | null {
  const req = buildAnalysisReq(state, allFrequencies);
  if (req == null) return null;

  return analysisReqComparisonKey(req, allFrequencies);
}

export function queryStateMatchesSavedFilter(state: AnalysisQueryState, savedFilter: SavedFilter, allFrequencies: string[] = []): boolean {
  const stateKey = queryStateComparisonKey(state, allFrequencies);
  const savedFilterKey = analysisReqComparisonKey(savedFilter.req, allFrequencies);
  if (stateKey == null || savedFilterKey == null) return false;

  return stateKey === savedFilterKey;
}
