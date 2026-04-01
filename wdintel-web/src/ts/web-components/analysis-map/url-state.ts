import {
  clearRerAnalysisQueryStateSearchParams,
  loadRerAnalysisQueryState,
  normalizeRerAnalysisQueryState,
  parseRerAnalysisQueryStateFromSearchParams,
  RER_ANALYSIS_LEGACY_STATE_PARAM,
  RerAnalysisQueryState,
  saveRerAnalysisQueryState,
  writeRerAnalysisQueryStateToSearchParams,
} from '../../rer-analysis-query-state';

const CLASSIC_RER_ANALYSIS_PATH = '/rer-analysis';

type LegacyRerAnalysisState = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function parseRawStateFromUrl(stateParam: string | null): LegacyRerAnalysisState | null {
  if (!stateParam) {
    return null;
  }

  try {
    const parsed = JSON.parse(stateParam);
    return isPlainObject(parsed) ? parsed : null;
  } catch (_error) {
    try {
      const decodedState = decodeURIComponent(stateParam);
      const parsed = JSON.parse(decodedState);
      return isPlainObject(parsed) ? parsed : null;
    } catch (_) {
      return null;
    }
  }
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function toNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toNullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function toLegacyState(state: RerAnalysisQueryState): LegacyRerAnalysisState {
  const normalized = normalizeRerAnalysisQueryState(state) ?? {};

  return {
    date_from_str: typeof normalized.dateFromStr === 'string' ? normalized.dateFromStr : '',
    time_from_str: typeof normalized.timeFromStr === 'string' ? normalized.timeFromStr : '',
    date_to_str: typeof normalized.dateToStr === 'string' ? normalized.dateToStr : '',
    time_to_str: typeof normalized.timeToStr === 'string' ? normalized.timeToStr : '',
    aors_selected: toStringArray(normalized.aorsSelected),
    groups_selected: toStringArray(normalized.groupsSelected),
    senders_selected: toStringArray(normalized.sendersSelected),
    freqs_selected: toStringArray(normalized.freqsSelected),
    callsigns_selected: toStringArray(normalized.callsignsSelected),
    units_selected: toStringArray(normalized.unitsSelected),
    locations_selected: toStringArray(normalized.locationsSelected),
    posts_selected: toStringArray(normalized.postsSelected),
    networks_selected: toStringArray(normalized.networksSelected),
    without_network: toBoolean(normalized.withoutNetwork, false),
    or_with_extended_form: toBoolean(normalized.orWithExtendedForm, false),
    or_bookmarked: toBoolean(normalized.orBookmarked, false),
    or_important: toBoolean(normalized.orImportant, false),
    or_with_coords: toBoolean(normalized.orWithCoords, false),
    search: typeof normalized.search === 'string' ? normalized.search : '',
    metadata_cc: toStringArray(normalized.metadataCc),
    metadata_sender: toStringArray(normalized.metadataSender),
    metadata_receiver: toStringArray(normalized.metadataReceiver),
    metadata_hash: toStringArray(normalized.metadataHash),
    only_with_metadata: toBoolean(normalized.onlyWithMetadata, false),
    without_metadata: toBoolean(normalized.withoutMetadata, false),
    tags: toNumberArray(normalized.tags),
    include_peleng_locations: toBoolean(normalized.includePelengLocations, true),
    units_exact_match_only: toNullableBoolean(normalized.unitsExactMatchOnly),
    adjacent_freqs_range: toNumber(normalized.adjacentFreqsRange, 0),
    without_model_tags: toBoolean(normalized.withoutModelTags, false),
    filter_tags_option: typeof normalized.filterTagsOption === 'string' ? normalized.filterTagsOption : 'OneOfTags',
    report_tags_only_this_unit: toBoolean(normalized.reportTagsOnlyThisUnit, false),
  };
}

export function parseStateFromUrl(stateParam: string | null): RerAnalysisQueryState | null {
  if (!stateParam) {
    return null;
  }

  try {
    const parsed = JSON.parse(stateParam);
    return normalizeRerAnalysisQueryState(parsed);
  } catch (_error) {
    try {
      const decodedState = decodeURIComponent(stateParam);
      const parsed = JSON.parse(decodedState);
      return normalizeRerAnalysisQueryState(parsed);
    } catch (_) {
      // ignore malformed state
    }
  }

  return null;
}

export function getSearchQueryFromCurrentUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URL(window.location.href).searchParams;
  const fromFlatState = parseRerAnalysisQueryStateFromSearchParams(params)?.search;
  if (fromFlatState != null && String(fromFlatState).trim() !== '') return String(fromFlatState).trim();
  const state = parseStateFromUrl(params.get('state'));
  const fromState = state?.search;
  if (fromState != null && String(fromState).trim() !== '') return String(fromState).trim();
  return null;
}

export function updateStateUrl(currentUrl: string, messageUid: string): string {
  try {
    const url = new URL(currentUrl);
    const storedState = loadRerAnalysisQueryState();
    const rawStateFromUrl = parseRawStateFromUrl(url.searchParams.get(RER_ANALYSIS_LEGACY_STATE_PARAM));
    const baseState =
      parseRerAnalysisQueryStateFromSearchParams(url.searchParams) ??
      parseStateFromUrl(url.searchParams.get(RER_ANALYSIS_LEGACY_STATE_PARAM)) ??
      storedState ??
      {};
    const stateObject: RerAnalysisQueryState = { ...(baseState as RerAnalysisQueryState), search: messageUid };
    saveRerAnalysisQueryState(stateObject);
    if (url.pathname === CLASSIC_RER_ANALYSIS_PATH) {
      const legacyState = rawStateFromUrl != null ? { ...rawStateFromUrl, search: messageUid } : toLegacyState(stateObject);
      clearRerAnalysisQueryStateSearchParams(url.searchParams);
      url.searchParams.set(RER_ANALYSIS_LEGACY_STATE_PARAM, JSON.stringify(legacyState));
    } else {
      writeRerAnalysisQueryStateToSearchParams(url.searchParams, stateObject);
    }
    return url.href;
  } catch (error) {
    console.error('Error updating URL state:', error);
    return currentUrl;
  }
}
