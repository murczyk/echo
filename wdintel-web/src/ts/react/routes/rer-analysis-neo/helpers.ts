import type { AnalysisStatsReq, InboxMessagesReq, SavedFilter } from '../../../../Bindings';
import {
  loadRerAnalysisQueryState,
  normalizeRerAnalysisQueryState,
  parseRerAnalysisQueryStateFromSearchParams,
  saveRerAnalysisQueryState,
  writeRerAnalysisQueryStateToSearchParams,
} from '../../../rer-analysis-query-state';
import { combineDateTimeToMs, formatLocalDateInputValue, formatLocalTimeInputValue } from '../../utils/misc';
import type { AnalysisQueryState } from './types';

export const PAGE_ID = 'rer-analysis-neo';
export const ADJACENT_FREQS_RANGE_OPTIONS = [0, 0.0005, 0.002, 0.005] as const;

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
    dateFromStr: '',
    timeFromStr: '',
    dateToStr: '',
    timeToStr: '',
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
    search: '',
    metadataCc: [],
    metadataSender: [],
    metadataReceiver: [],
    metadataHash: [],
    onlyWithMetadata: false,
    withoutMetadata: false,
    tags: [],
    includePelengLocations: true,
    unitsExactMatchOnly: null,
    adjacentFreqsRange: 0,
    withoutModelTags: false,
    filterTagsOption: 'OneOfTags',
    reportTagsOnlyThisUnit: false,
  };
}

function parseStateParam(raw: string | null): AnalysisQueryState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return normalizeRerAnalysisQueryState(parsed) as AnalysisQueryState | null;
  } catch {
    try {
      const decoded = decodeURIComponent(raw);
      const parsed = JSON.parse(decoded) as unknown;
      return normalizeRerAnalysisQueryState(parsed) as AnalysisQueryState | null;
    } catch {
      return null;
    }
  }
}

export function parseQueryStateFromWindow(): AnalysisQueryState {
  if (typeof window === 'undefined') return emptyQueryState();

  const url = new URL(window.location.href);
  const flatStateFromUrl = parseRerAnalysisQueryStateFromSearchParams(url.searchParams);
  const stateFromUrl = parseStateParam(url.searchParams.get('state'));
  const storedState = loadRerAnalysisQueryState();
  return {
    ...emptyQueryState(),
    ...(storedState ?? {}),
    ...(stateFromUrl ?? {}),
    ...(flatStateFromUrl ?? {}),
  };
}

export function createInitialQueryState(
  parsed: AnalysisQueryState,
  now: Date = new Date(),
): AnalysisQueryState {
  if (parsed.dateFromStr !== '' && parsed.dateToStr !== '') return parsed;

  const start = new Date(now.getTime() - 12 * 60 * 60 * 1000);
  return {
    ...emptyQueryState(),
    ...parsed,
    dateFromStr: parsed.dateFromStr || formatLocalDateInputValue(start),
    timeFromStr: parsed.timeFromStr || formatLocalTimeInputValue(start),
    dateToStr: parsed.dateToStr || formatLocalDateInputValue(now),
    timeToStr: parsed.timeToStr || formatLocalTimeInputValue(now),
  };
}

export function createResetQueryState(now: Date = new Date()): AnalysisQueryState {
  return createInitialQueryState(emptyQueryState(), now);
}

export function hasMeaningfulFiltersBeyondDateRange(state: AnalysisQueryState): boolean {
  const {
    dateFromStr: _dateFromStr,
    timeFromStr: _timeFromStr,
    dateToStr: _dateToStr,
    timeToStr: _timeToStr,
    ...rest
  } = state;
  const {
    dateFromStr: _defaultDateFromStr,
    timeFromStr: _defaultTimeFromStr,
    dateToStr: _defaultDateToStr,
    timeToStr: _defaultTimeToStr,
    ...defaultRest
  } = emptyQueryState();

  return JSON.stringify(rest) !== JSON.stringify(defaultRest);
}

export function pushQueryStateToUrl(state: AnalysisQueryState) {
  if (typeof window === 'undefined') return;
  saveRerAnalysisQueryState(state);
  const url = new URL(window.location.href);
  writeRerAnalysisQueryStateToSearchParams(url.searchParams, state);
  window.history.replaceState({}, '', `${url.pathname}?${url.searchParams.toString()}`);
}

export function normalizeQueryState(state: AnalysisQueryState): AnalysisQueryState {
  if (state.withoutMetadata) {
    return {
      ...state,
      metadataCc: [],
      metadataSender: [],
      metadataReceiver: [],
      metadataHash: [],
      onlyWithMetadata: false,
    };
  }

  if (state.onlyWithMetadata) {
    return { ...state, withoutMetadata: false };
  }

  if (state.withoutNetwork) {
    return { ...state, networksSelected: [] };
  }

  return state;
}

export function buildAnalysisReq(state: AnalysisQueryState, allFrequencies: string[] = []): AnalysisStatsReq | null {
  const query = normalizeQueryState(state);
  const sinceDateInclusiveMs = combineDateTimeToMs(query.dateFromStr, query.timeFromStr);
  const tillDateNoninclusiveMs = combineDateTimeToMs(query.dateToStr, query.timeToStr);

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
    unitsExactMatchOnly: req.unitsExactMatchOnly ?? true,
    calculateFreqPelengsSummary: null,
    skipGroupStats: true,
    filterTagsOption: req.filterTagsOption,
    pageId: 'rer-analysis',
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
    search: req.search ?? '',
    metadataCc: req.metadataCc ?? [],
    metadataSender: req.metadataSender ?? [],
    metadataReceiver: req.metadataReceiver ?? [],
    metadataHash: req.metadataHash ?? [],
    onlyWithMetadata: req.onlyWithMetadata ?? false,
    withoutMetadata: req.withoutMetadata ?? false,
    tags: req.selectedTags ?? [],
    includePelengLocations: req.includePelengLocations ?? true,
    unitsExactMatchOnly: req.unitsExactMatchOnly ?? null,
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
    dateFromStr: formatLocalDateInputValue(new Date(normalized.sinceDateInclusiveMs)),
    timeFromStr: formatLocalTimeInputValue(new Date(normalized.sinceDateInclusiveMs)),
    dateToStr: formatLocalDateInputValue(new Date(normalized.tillDateNoninclusiveMs)),
    timeToStr: formatLocalTimeInputValue(new Date(normalized.tillDateNoninclusiveMs)),
  });
}

export function queryStateMatchesSavedFilter(state: AnalysisQueryState, savedFilter: SavedFilter, allFrequencies: string[] = []): boolean {
  const currentReq = buildAnalysisReq(state, allFrequencies);
  if (currentReq == null) return false;

  const normalizedState = buildAnalysisReq(canonicalizeAnalysisReqToQueryState(currentReq), allFrequencies);
  const normalizedSaved = buildAnalysisReq(canonicalizeAnalysisReqToQueryState(savedFilter.req), allFrequencies);
  if (normalizedState == null || normalizedSaved == null) return false;

  return JSON.stringify(normalizedState) === JSON.stringify(normalizedSaved);
}
