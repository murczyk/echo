import type { RerAnalysisQueryState } from './rer-analysis-query-state';
import { normalizeRerAnalysisQueryState } from './rer-analysis-query-state';

export type RerAnalysisLegacyState = Record<string, unknown>;
export const RER_ANALYSIS_LEGACY_QUERY_STATE_KEY = 'rer-analysis-query-state';

type LegacyKeyMapEntry = {
  key: string;
  legacyKey?: string;
  defaultValue: unknown;
  type: 'string' | 'string[]' | 'boolean' | 'boolean?' | 'number' | 'number[]';
};

const TAG_FILTER_OPTION_MAP = {
  OneOfTags: 'OneOfTags',
  AllTags: 'AllTags',
  AllOfTags: 'AllTags',
} as const satisfies Record<string, 'OneOfTags' | 'AllTags'>;

const LEGACY_QUERY_STATE_FIELDS: LegacyKeyMapEntry[] = [
  { key: 'dateFromStr', legacyKey: 'date_from_str', defaultValue: '', type: 'string' },
  { key: 'timeFromStr', legacyKey: 'time_from_str', defaultValue: '', type: 'string' },
  { key: 'dateToStr', legacyKey: 'date_to_str', defaultValue: '', type: 'string' },
  { key: 'timeToStr', legacyKey: 'time_to_str', defaultValue: '', type: 'string' },
  { key: 'includeOnlyNewFreqs', defaultValue: false, type: 'boolean' },
  { key: 'aorsSelected', legacyKey: 'aors_selected', defaultValue: [], type: 'string[]' },
  { key: 'groupsSelected', legacyKey: 'groups_selected', defaultValue: [], type: 'string[]' },
  { key: 'sendersSelected', legacyKey: 'senders_selected', defaultValue: [], type: 'string[]' },
  { key: 'freqsSelected', legacyKey: 'freqs_selected', defaultValue: [], type: 'string[]' },
  { key: 'callsignsSelected', legacyKey: 'callsigns_selected', defaultValue: [], type: 'string[]' },
  { key: 'unitsSelected', legacyKey: 'units_selected', defaultValue: [], type: 'string[]' },
  { key: 'locationsSelected', legacyKey: 'locations_selected', defaultValue: [], type: 'string[]' },
  { key: 'postsSelected', legacyKey: 'posts_selected', defaultValue: [], type: 'string[]' },
  { key: 'networksSelected', legacyKey: 'networks_selected', defaultValue: [], type: 'string[]' },
  { key: 'withoutNetwork', legacyKey: 'without_network', defaultValue: false, type: 'boolean' },
  {
    key: 'orWithExtendedForm',
    legacyKey: 'or_with_extended_form',
    defaultValue: false,
    type: 'boolean',
  },
  { key: 'orBookmarked', legacyKey: 'or_bookmarked', defaultValue: false, type: 'boolean' },
  { key: 'orImportant', legacyKey: 'or_important', defaultValue: false, type: 'boolean' },
  { key: 'orWithCoords', legacyKey: 'or_with_coords', defaultValue: false, type: 'boolean' },
  { key: 'orWithoutCoords', legacyKey: 'or_without_coords', defaultValue: false, type: 'boolean' },
  { key: 'search', defaultValue: '', type: 'string' },
  { key: 'metadataCc', legacyKey: 'metadata_cc', defaultValue: [], type: 'string[]' },
  { key: 'metadataSender', legacyKey: 'metadata_sender', defaultValue: [], type: 'string[]' },
  { key: 'metadataReceiver', legacyKey: 'metadata_receiver', defaultValue: [], type: 'string[]' },
  { key: 'metadataHash', legacyKey: 'metadata_hash', defaultValue: [], type: 'string[]' },
  {
    key: 'onlyWithMetadata',
    legacyKey: 'only_with_metadata',
    defaultValue: false,
    type: 'boolean',
  },
  { key: 'withoutMetadata', legacyKey: 'without_metadata', defaultValue: false, type: 'boolean' },
  { key: 'tags', defaultValue: [], type: 'number[]' },
  {
    key: 'includePelengLocations',
    legacyKey: 'include_peleng_locations',
    defaultValue: true,
    type: 'boolean',
  },
  {
    key: 'unitsExactMatchOnly',
    legacyKey: 'units_exact_match_only',
    defaultValue: null,
    type: 'boolean?',
  },
  { key: 'adjacentFreqsRange', legacyKey: 'adjacent_freqs_range', defaultValue: 0, type: 'number' },
  {
    key: 'withoutModelTags',
    legacyKey: 'without_model_tags',
    defaultValue: false,
    type: 'boolean',
  },
  {
    key: 'filterTagsOption',
    legacyKey: 'filter_tags_option',
    defaultValue: 'OneOfTags',
    type: 'string',
  },
  {
    key: 'reportTagsOnlyThisUnit',
    legacyKey: 'report_tags_only_this_unit',
    defaultValue: false,
    type: 'boolean',
  },
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
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

function toNullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function composeLegacyDateTime(dateStr: unknown, timeStr: unknown): string | undefined {
  if (typeof dateStr !== 'string' || typeof timeStr !== 'string') {
    return undefined;
  }

  if (dateStr === '' || timeStr === '') {
    return undefined;
  }

  return `${dateStr}T${timeStr}`;
}

function splitDateTimeStr(
  dateTimeStr: string | undefined,
): { dateStr: string; timeStr: string } | null {
  if (typeof dateTimeStr !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dateTimeStr)) {
    return null;
  }

  const [dateStr, timeStr] = dateTimeStr.split('T');
  if (!dateStr || !timeStr) {
    return null;
  }

  return { dateStr, timeStr };
}

function normalizeLegacyValue(field: LegacyKeyMapEntry, value: unknown): unknown {
  if (field.key === 'filterTagsOption' && typeof value === 'string') {
    return TAG_FILTER_OPTION_MAP[value] ?? value;
  }

  return value;
}

function getLegacyFieldValue(state: Record<string, unknown>, field: LegacyKeyMapEntry): unknown {
  if (state[field.key] !== undefined) {
    return state[field.key];
  }

  if (field.legacyKey && state[field.legacyKey] !== undefined) {
    return state[field.legacyKey];
  }

  return undefined;
}

export function parseRawRerAnalysisLegacyState(
  stateParam: string | null,
): RerAnalysisLegacyState | null {
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

export function parseRerAnalysisLegacyState(
  stateParam: string | null,
): RerAnalysisQueryState | null {
  const rawState = parseRawRerAnalysisLegacyState(stateParam);
  if (rawState == null) {
    return null;
  }

  const canonicalState: RerAnalysisQueryState = {};
  for (const field of LEGACY_QUERY_STATE_FIELDS) {
    const value = getLegacyFieldValue(rawState, field);
    if (value === undefined) continue;
    canonicalState[field.key] = normalizeLegacyValue(field, value);
  }

  // Legacy storage still stores split datetime fields; Neo intentionally does not.
  if (canonicalState.fromDateTimeStr == null) {
    const fromDateTimeStr = composeLegacyDateTime(
      canonicalState.dateFromStr,
      canonicalState.timeFromStr,
    );
    if (fromDateTimeStr != null) {
      canonicalState.fromDateTimeStr = fromDateTimeStr;
    }
  }

  if (canonicalState.toDateTimeStr == null) {
    const toDateTimeStr = composeLegacyDateTime(canonicalState.dateToStr, canonicalState.timeToStr);
    if (toDateTimeStr != null) {
      canonicalState.toDateTimeStr = toDateTimeStr;
    }
  }

  const normalized = normalizeRerAnalysisQueryState(canonicalState);
  if (normalized == null) {
    return null;
  }

  if (rawState.unitsExactMatchOnly === undefined && rawState.units_exact_match_only === undefined) {
    normalized.unitsExactMatchOnly = null;
  }

  return normalized;
}

export function toLegacyRerAnalysisQueryState(state: unknown): RerAnalysisLegacyState {
  const normalized = normalizeRerAnalysisQueryState(state) ?? {};
  const legacyState: RerAnalysisLegacyState = {};

  const fromDateTime = splitDateTimeStr(
    typeof normalized.fromDateTimeStr === 'string' ? normalized.fromDateTimeStr : undefined,
  );
  const toDateTime = splitDateTimeStr(
    typeof normalized.toDateTimeStr === 'string' ? normalized.toDateTimeStr : undefined,
  );

  for (const field of LEGACY_QUERY_STATE_FIELDS) {
    const legacyKey = field.legacyKey ?? field.key;
    let value = normalized[field.key];

    if (field.key === 'dateFromStr' && fromDateTime != null) {
      value = fromDateTime.dateStr;
    }
    if (field.key === 'timeFromStr' && fromDateTime != null) {
      value = fromDateTime.timeStr;
    }
    if (field.key === 'dateToStr' && toDateTime != null) {
      value = toDateTime.dateStr;
    }
    if (field.key === 'timeToStr' && toDateTime != null) {
      value = toDateTime.timeStr;
    }

    if (field.type === 'string') {
      legacyState[legacyKey] = typeof value === 'string' ? value : String(field.defaultValue);
      continue;
    }

    if (field.type === 'string[]') {
      legacyState[legacyKey] = toStringArray(value);
      continue;
    }

    if (field.type === 'boolean') {
      legacyState[legacyKey] = toBoolean(value, Boolean(field.defaultValue));
      continue;
    }

    if (field.type === 'boolean?') {
      legacyState[legacyKey] = toNullableBoolean(value);
      continue;
    }

    if (field.type === 'number') {
      legacyState[legacyKey] = toNumber(value, Number(field.defaultValue));
      continue;
    }

    if (field.type === 'number[]') {
      legacyState[legacyKey] = toNumberArray(value);
    }
  }

  return legacyState;
}

export function saveLegacyRerAnalysisQueryState(state: unknown): void {
  try {
    localStorage.setItem(RER_ANALYSIS_LEGACY_QUERY_STATE_KEY, JSON.stringify(state));
  } catch (error) {
    console.error('Failed to save legacy rer analysis query state', error);
  }
}

export function loadLegacyRerAnalysisQueryState(): RerAnalysisQueryState | null {
  try {
    const stored = localStorage.getItem(RER_ANALYSIS_LEGACY_QUERY_STATE_KEY);
    if (!stored) {
      return null;
    }

    return parseRerAnalysisLegacyState(stored);
  } catch (error) {
    console.error('Failed to load legacy rer analysis query state', error);
  }

  return null;
}
