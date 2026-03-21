import type { AnalysisStatsReq, InboxMessagesReq, SavedFilter } from '../../../../Bindings';
import { loadRerAnalysisQueryState, saveRerAnalysisQueryState } from '../../../rer-analysis-query-state';
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

export function formatLocalDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatLocalTimeInputValue(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function parseStateParam(raw: string | null): AnalysisQueryState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as AnalysisQueryState;
  } catch {
    try {
      const decoded = decodeURIComponent(raw);
      const parsed = JSON.parse(decoded) as unknown;
      if (parsed && typeof parsed === 'object') return parsed as AnalysisQueryState;
    } catch {
      return null;
    }
  }

  return null;
}

export function parseQueryStateFromWindow(): AnalysisQueryState {
  if (typeof window === 'undefined') return emptyQueryState();

  const url = new URL(window.location.href);
  const stateFromUrl = parseStateParam(url.searchParams.get('state'));
  const search = url.searchParams.get('search');
  const storedState = loadRerAnalysisQueryState();
  const state = {
    ...emptyQueryState(),
    ...(storedState ?? {}),
    ...(stateFromUrl ?? {}),
  };

  if (search && search.trim() !== '') {
    return { ...state, search: search.trim() };
  }

  return state;
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

export function pushQueryStateToUrl(state: AnalysisQueryState) {
  if (typeof window === 'undefined') return;
  saveRerAnalysisQueryState(state);
  const url = new URL(window.location.href);
  url.searchParams.set('state', JSON.stringify(state));
  if (state.search.trim() === '') {
    url.searchParams.delete('search');
  }
  window.history.replaceState({}, '', `${url.pathname}?${url.searchParams.toString()}`);
}

export function isValidDateInput(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const [yearRaw, monthRaw, dayRaw] = dateStr.split('-');
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  if (!Number.isInteger(year) || year < 1000) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function isValidTimeInput(timeStr: string): boolean {
  return /^\d{2}:\d{2}$/.test(timeStr);
}

export function combineDateTimeToMs(dateStr: string, timeStr: string): number | null {
  if (!isValidDateInput(dateStr) || !isValidTimeInput(timeStr)) return null;
  const iso = `${dateStr}T${timeStr}:00`;
  const millis = new Date(iso).getTime();
  return Number.isFinite(millis) ? millis : null;
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

export function queryStateFromSavedFilter(savedFilter: SavedFilter, current: AnalysisQueryState): AnalysisQueryState {
  const req = savedFilter.req;
  return normalizeQueryState({
    ...current,
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

export function queryStateMatchesSavedFilter(state: AnalysisQueryState, savedFilter: SavedFilter, allFrequencies: string[] = []): boolean {
  const normalizedState = buildAnalysisReq(state, allFrequencies);
  if (normalizedState == null) return false;
  return JSON.stringify(normalizedState) === JSON.stringify(savedFilter.req);
}
