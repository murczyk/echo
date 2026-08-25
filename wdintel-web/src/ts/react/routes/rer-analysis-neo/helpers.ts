import dayjs from 'dayjs';

import type { AnalysisStatsReq, InboxMessagesReq, SavedFilter } from '../../../../Bindings';
import {
  parseRerAnalysisQueryStateFromSearchParams,
  writeRerAnalysisQueryStateToSearchParams,
} from '../../../rer-analysis-query-state';
import {
  APP_TIME_ZONE,
  combineDateTimeInputToMs,
  formatDateTimeInputValueInTimeZone,
  isNullOrUndefined,
} from '../../utils/misc';
import { normalizeUnknownUnitSelections } from '../shared/analysis-unit-filter';
import { normalizeCallsignFilterValues } from '../../utils/callsign-normalization';
import type { AnalysisQueryState } from './types';

export const ANALYSIS_ROUTE_PAGE_ID = 'rer-analysis-neo';
export const ANALYSIS_MESSAGES_PAGE_SIZE = 20;
// Keep old and new analysis pages grouped in session activity while both coexist.
export const ANALYSIS_SESSION_ACTIVITY_PAGE_ID = 'rer-analysis';
export const ADJACENT_FREQS_RANGE_OPTIONS = [0, 0.0005, 0.002, 0.005] as const;
const ONLY_WITH_MEDIA_PARAM = 'only_with_media';
const LEFT_PANEL_OPEN_PARAM = 'leftPanelOpen';
const RIGHT_PANEL_OPEN_PARAM = 'rightPanelOpen';

export type AnalysisPanelQueryState = {
  leftPanelOpen: boolean | null;
  rightPanelOpen: boolean | null;
};

/** Duty / deep links append `?showMap=true` so the map center tab opens (see `buildRerAnalysisNeoHref` in rer-duty-neo). */
export function shouldOpenAnalysisMapFromSearchParams(searchParams: URLSearchParams): boolean {
  const v = searchParams.get('showMap');
  return v === 'true';
}

function parseOptionalBooleanParam(value: string | null): boolean | null {
  if (value == null) return null;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return null;
}

function findAllAdjacentFreqs(
  allFrequencies: string[],
  selectedFrequencies: string[],
  range: number,
): string[] {
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
    deviceNamesSelected: [],
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
    tagsExcludeMode: false,
    reportTagsOnlyThisUnit: false,
    onlyWithMedia: false,
  };
}

function getDefaultAnalysisDateRange(now: Date): {
  fromDateTimeStr: string;
  toDateTimeStr: string;
} {
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
  const onlyWithMedia = parseOptionalBooleanParam(url.searchParams.get(ONLY_WITH_MEDIA_PARAM));

  return {
    ...emptyQueryState(),
    ...(flatStateFromUrl ?? {}),
    ...(onlyWithMedia != null ? { onlyWithMedia } : {}),
  };
}

export function parseNewestFirstFromWindow(): boolean {
  if (typeof window === 'undefined') return true;
  const url = new URL(window.location.href);
  const param = url.searchParams.get('newestFirst');
  return param !== 'false';
}

export function parseAnalysisPanelQueryStateFromWindow(): AnalysisPanelQueryState {
  if (typeof window === 'undefined') {
    return { leftPanelOpen: null, rightPanelOpen: null };
  }
  const searchParams = new URL(window.location.href).searchParams;
  return {
    leftPanelOpen: parseOptionalBooleanParam(searchParams.get(LEFT_PANEL_OPEN_PARAM)),
    rightPanelOpen: parseOptionalBooleanParam(searchParams.get(RIGHT_PANEL_OPEN_PARAM)),
  };
}

export function parseMessageUidFromWindow(): string | null {
  if (typeof window === 'undefined') return null;
  const url = new URL(window.location.href);
  const param =
    url.searchParams.get('m') || url.searchParams.get('mid') || url.searchParams.get('messageUid');
  const trimmed = param?.trim();
  return trimmed && trimmed !== '' ? trimmed : null;
}

export function createInitialQueryState(
  parsed: AnalysisQueryState,
  now: Date = new Date(),
): AnalysisQueryState {
  if (parsed.fromDateTimeStr !== '' && parsed.toDateTimeStr !== '')
    return normalizeQueryState(parsed);

  const defaultDateRange = getDefaultAnalysisDateRange(now);
  return normalizeQueryState({
    ...emptyQueryState(),
    ...parsed,
    fromDateTimeStr: parsed.fromDateTimeStr || defaultDateRange.fromDateTimeStr,
    toDateTimeStr: parsed.toDateTimeStr || defaultDateRange.toDateTimeStr,
  });
}

export function createResetQueryState(now: Date = new Date()): AnalysisQueryState {
  return createInitialQueryState(emptyQueryState(), now);
}

export function hasMeaningfulFiltersBeyondDateRange(state: AnalysisQueryState): boolean {
  const stateKey = queryStateComparisonKey(state);
  const defaultKey = queryStateComparisonKey(createResetQueryState());
  if (isNullOrUndefined(stateKey) || isNullOrUndefined(defaultKey)) return false;

  return stateKey !== defaultKey;
}

export function hasMeaningfulUiFiltersBeyondDateRange(state: AnalysisQueryState): boolean {
  const stateKey = queryStateUiComparisonKey(state);
  const defaultKey = queryStateUiComparisonKey(createResetQueryState());
  if (isNullOrUndefined(stateKey) || isNullOrUndefined(defaultKey)) return false;

  return stateKey !== defaultKey;
}

export function pushQueryStateToUrl(
  state: AnalysisQueryState,
  newestFirst: boolean = true,
  panelState?: { leftPanelOpen: boolean; rightPanelOpen: boolean },
) {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  writeRerAnalysisQueryStateToSearchParams(url.searchParams, state);
  if (state.onlyWithMedia) {
    url.searchParams.set(ONLY_WITH_MEDIA_PARAM, 'true');
  } else {
    url.searchParams.delete(ONLY_WITH_MEDIA_PARAM);
  }
  if (!newestFirst) {
    url.searchParams.set('newestFirst', 'false');
  } else {
    url.searchParams.delete('newestFirst');
  }
  if (panelState) {
    url.searchParams.set(LEFT_PANEL_OPEN_PARAM, String(panelState.leftPanelOpen));
    url.searchParams.set(RIGHT_PANEL_OPEN_PARAM, String(panelState.rightPanelOpen));
  }
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
  }

  return {
    ...next,
    callsignsSelected: normalizeCallsignFilterValues(next.callsignsSelected),
    unitsSelected: normalizeUnknownUnitSelections(next.unitsSelected),
  };
}

export function buildAnalysisReq(
  state: AnalysisQueryState,
  allFrequencies: string[] = [],
): AnalysisStatsReq | null {
  const query = normalizeQueryState(state);
  const sinceDateInclusiveMs = combineDateTimeInputToMs(query.fromDateTimeStr ?? '', APP_TIME_ZONE);
  const tillDateNoninclusiveMs = combineDateTimeInputToMs(query.toDateTimeStr ?? '', APP_TIME_ZONE);

  if (
    isNullOrUndefined(sinceDateInclusiveMs) ||
    isNullOrUndefined(tillDateNoninclusiveMs) ||
    sinceDateInclusiveMs > tillDateNoninclusiveMs
  ) {
    return null;
  }

  const expandedFreqs =
    query.adjacentFreqsRange > 0
      ? Array.from(
          new Set([
            ...query.freqsSelected,
            ...findAllAdjacentFreqs(allFrequencies, query.freqsSelected, query.adjacentFreqsRange),
          ]),
        )
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
    selectedDeviceNames: query.deviceNamesSelected.length ? query.deviceNamesSelected : null,
    selectedLocations: query.locationsSelected.length ? query.locationsSelected : null,
    selectedAors: query.aorsSelected.length
      ? query.aorsSelected.map((value) => Number(value)).filter(Number.isFinite)
      : null,
    orWithExtendedForm: query.orWithExtendedForm,
    orBookmarked: query.orBookmarked,
    orImportant: query.orImportant,
    orWithCoords: query.orWithCoords,
    orWithoutCoords: query.orWithoutCoords,
    search: query.search.trim() === '' ? null : query.search.trim(),
    selectedTags: query.tags.length && !query.tagsExcludeMode ? query.tags : null,
    deniedTags: query.tags.length && query.tagsExcludeMode ? query.tags : null,
    tagPresence: null,
    selectedNetworks: query.withoutNetwork
      ? null
      : query.networksSelected.map((value) => Number(value)).filter(Number.isFinite),
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

export function buildInboxReq(
  state: AnalysisQueryState,
  allFrequencies: string[] = [],
  // `onlyWithMedia` is intentionally opt-in: it filters only the Messages tab,
  // while map/report consumers should keep using the broader analysis request.
  includeOnlyWithMedia = false,
): InboxMessagesReq | null {
  const req = buildAnalysisReq(state, allFrequencies);
  if (isNullOrUndefined(req)) return null;

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
    selectedDeviceNames: req.selectedDeviceNames,
    deniedUnits: null,
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
    highlightKeywordSetId: null,
    highlightSearchres: true,
    highlightSignals: null,
    highlightPoints: true,
    selectedTags: req.selectedTags,
    deniedTags: req.deniedTags,
    tagPresence: req.tagPresence,
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
    onlyWithMedia: includeOnlyWithMedia ? state.onlyWithMedia : false,
  };
}

export function buildInboxOverallCountReq(state: AnalysisQueryState): InboxMessagesReq | null {
  return buildInboxReq({
    ...emptyQueryState(),
    fromDateTimeStr: state.fromDateTimeStr,
    toDateTimeStr: state.toDateTimeStr,
  });
}

export function shouldRebuildAnalysisRequests(
  state: AnalysisQueryState,
  currentFrequencies: string[] = [],
  nextFrequencies: string[] = [],
): boolean {
  if (
    state.adjacentFreqsRange <= 0 ||
    state.freqsSelected.length === 0 ||
    nextFrequencies.length === 0
  ) {
    return false;
  }

  const currentReq = buildAnalysisReq(state, currentFrequencies);
  const nextReq = buildAnalysisReq(state, nextFrequencies);
  if (isNullOrUndefined(currentReq) || isNullOrUndefined(nextReq)) return false;

  return (
    JSON.stringify(currentReq.selectedFreqs ?? []) !== JSON.stringify(nextReq.selectedFreqs ?? [])
  );
}

export function queryStateFromSavedFilter(
  savedFilter: SavedFilter,
  current: AnalysisQueryState,
): AnalysisQueryState {
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
    deviceNamesSelected: req.selectedDeviceNames ?? [],
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
    tags: (req.deniedTags?.length ? req.deniedTags : req.selectedTags) ?? [],
    tagsExcludeMode: Boolean(req.deniedTags?.length),
    includePelengLocations: req.includePelengLocations ?? true,
    unitsExactMatchOnly: req.unitsExactMatchOnly,
    withoutModelTags: req.withoutModelTags ?? false,
    filterTagsOption: req.filterTagsOption ?? 'OneOfTags',
    reportTagsOnlyThisUnit: req.reportTagsOnlyThisUnit ?? false,
  });
}

function canonicalizeAnalysisReqToQueryState(req: AnalysisStatsReq): AnalysisQueryState {
  const normalized = { ...req };

  if (isNullOrUndefined(normalized.onlyWithMetadata)) {
    normalized.onlyWithMetadata = false;
  }
  if (isNullOrUndefined(normalized.withoutMetadata)) {
    normalized.withoutMetadata = false;
  }
  if (isNullOrUndefined(normalized.withoutNetwork)) {
    normalized.withoutNetwork = false;
  }
  if (isNullOrUndefined(normalized.orWithExtendedForm)) {
    normalized.orWithExtendedForm = false;
  }
  if (isNullOrUndefined(normalized.orBookmarked)) {
    normalized.orBookmarked = false;
  }
  if (isNullOrUndefined(normalized.orImportant)) {
    normalized.orImportant = false;
  }
  if (isNullOrUndefined(normalized.orWithCoords)) {
    normalized.orWithCoords = false;
  }
  if (isNullOrUndefined(normalized.orWithoutCoords)) {
    normalized.orWithoutCoords = false;
  }
  if (isNullOrUndefined(normalized.includePelengLocations)) {
    normalized.includePelengLocations = true;
  }
  if (isNullOrUndefined(normalized.filterTagsOption)) {
    normalized.filterTagsOption = 'OneOfTags';
  }
  if (isNullOrUndefined(normalized.withoutModelTags)) {
    normalized.withoutModelTags = false;
  }
  if (isNullOrUndefined(normalized.reportTagsOnlyThisUnit)) {
    normalized.reportTagsOnlyThisUnit = false;
  }

  return normalizeQueryState({
    ...emptyQueryState(),
    includeOnlyNewFreqs: false,
    fromDateTimeStr: formatDateTimeInputValueInTimeZone(
      new Date(normalized.sinceDateInclusiveMs),
      APP_TIME_ZONE,
    ),
    toDateTimeStr: formatDateTimeInputValueInTimeZone(
      new Date(normalized.tillDateNoninclusiveMs),
      APP_TIME_ZONE,
    ),
    aorsSelected: (normalized.selectedAors ?? []).map(String),
    groupsSelected: normalized.selectedGroups ?? [],
    sendersSelected: normalized.selectedSenders ?? [],
    freqsSelected: normalized.selectedFreqs ?? [],
    callsignsSelected: normalized.selectedCallsigns ?? [],
    unitsSelected: normalized.selectedUnits ?? [],
    deviceNamesSelected: normalized.selectedDeviceNames ?? [],
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
    tags: (normalized.deniedTags?.length ? normalized.deniedTags : normalized.selectedTags) ?? [],
    tagsExcludeMode: Boolean(normalized.deniedTags?.length),
    includePelengLocations: normalized.includePelengLocations,
    unitsExactMatchOnly: normalized.unitsExactMatchOnly ?? null,
    withoutModelTags: normalized.withoutModelTags,
    filterTagsOption: normalized.filterTagsOption,
    reportTagsOnlyThisUnit: normalized.reportTagsOnlyThisUnit,
  });
}

function analysisReqComparisonKey(
  req: AnalysisStatsReq,
  allFrequencies: string[] = [],
): string | null {
  const normalized = buildAnalysisReq(canonicalizeAnalysisReqToQueryState(req), allFrequencies);
  if (isNullOrUndefined(normalized)) return null;

  const {
    sinceDateInclusiveMs: _sinceDateInclusiveMs,
    tillDateNoninclusiveMs: _tillDateNoninclusiveMs,
    ...rest
  } = normalized;
  return JSON.stringify(rest);
}

export function queryStateComparisonKey(
  state: AnalysisQueryState,
  allFrequencies: string[] = [],
): string | null {
  const req = buildAnalysisReq(state, allFrequencies);
  if (isNullOrUndefined(req)) return null;

  return analysisReqComparisonKey(req, allFrequencies);
}

export function queryStateUiComparisonKey(
  state: AnalysisQueryState,
  allFrequencies: string[] = [],
): string | null {
  const analysisKey = queryStateComparisonKey(state, allFrequencies);
  if (isNullOrUndefined(analysisKey)) return null;

  return JSON.stringify({
    analysisKey,
    onlyWithMedia: state.onlyWithMedia,
  });
}

export function queryStateReloadKey(
  state: AnalysisQueryState,
  allFrequencies: string[] = [],
): string | null {
  const req = buildAnalysisReq(state, allFrequencies);
  if (isNullOrUndefined(req)) return null;

  return JSON.stringify(req);
}

export function queryStateMatchesSavedFilter(
  state: AnalysisQueryState,
  savedFilter: SavedFilter,
  allFrequencies: string[] = [],
): boolean {
  const stateKey = queryStateComparisonKey(state, allFrequencies);
  const savedFilterKey = analysisReqComparisonKey(savedFilter.req, allFrequencies);
  if (isNullOrUndefined(stateKey) || isNullOrUndefined(savedFilterKey)) return false;

  return stateKey === savedFilterKey;
}
