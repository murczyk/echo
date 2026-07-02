export type RerAnalysisQueryState = {
  search?: string;
  [key: string]: unknown;
};

export const RER_ANALYSIS_LEGACY_STATE_PARAM = 'state';

type QueryStateFieldType = 'string' | 'string[]' | 'boolean' | 'boolean?' | 'number' | 'number[]';

type QueryStateFieldConfig = {
  key: string;
  param: string;
  type: QueryStateFieldType;
};

const QUERY_STATE_FIELD_CONFIGS: QueryStateFieldConfig[] = [
  // Neo intentionally persists only combined datetime params.
  // The legacy split date/time fields are supported only by the old analysis adapter.
  { key: 'fromDateTimeStr', param: 'fromDateTime', type: 'string' },
  { key: 'toDateTimeStr', param: 'toDateTime', type: 'string' },
  { key: 'includeOnlyNewFreqs', param: 'onlyNewFreqs', type: 'boolean' },
  { key: 'aorsSelected', param: 'aors', type: 'string[]' },
  { key: 'groupsSelected', param: 'groups', type: 'string[]' },
  { key: 'sendersSelected', param: 'senders', type: 'string[]' },
  { key: 'freqsSelected', param: 'freqs', type: 'string[]' },
  { key: 'callsignsSelected', param: 'callsigns', type: 'string[]' },
  { key: 'unitsSelected', param: 'units', type: 'string[]' },
  { key: 'locationsSelected', param: 'locations', type: 'string[]' },
  { key: 'postsSelected', param: 'posts', type: 'string[]' },
  { key: 'networksSelected', param: 'networks', type: 'string[]' },
  { key: 'withoutNetwork', param: 'withoutNetwork', type: 'boolean' },
  { key: 'orWithExtendedForm', param: 'orWithExtendedForm', type: 'boolean' },
  { key: 'orBookmarked', param: 'orBookmarked', type: 'boolean' },
  { key: 'orImportant', param: 'orImportant', type: 'boolean' },
  { key: 'orWithCoords', param: 'orWithCoords', type: 'boolean' },
  { key: 'orWithoutCoords', param: 'orWithoutCoords', type: 'boolean' },
  { key: 'search', param: 'search', type: 'string' },
  { key: 'metadataCc', param: 'metadataCc', type: 'string[]' },
  { key: 'metadataSender', param: 'metadataSender', type: 'string[]' },
  { key: 'metadataReceiver', param: 'metadataReceiver', type: 'string[]' },
  { key: 'metadataHash', param: 'metadataHash', type: 'string[]' },
  { key: 'onlyWithMetadata', param: 'onlyWithMetadata', type: 'boolean' },
  { key: 'withoutMetadata', param: 'withoutMetadata', type: 'boolean' },
  { key: 'tags', param: 'tags', type: 'number[]' },
  { key: 'includePelengLocations', param: 'includePelengLocations', type: 'boolean' },
  { key: 'unitsExactMatchOnly', param: 'unitsExactMatchOnly', type: 'boolean?' },
  { key: 'adjacentFreqsRange', param: 'adjacentFreqsRange', type: 'number' },
  { key: 'withoutModelTags', param: 'withoutModelTags', type: 'boolean' },
  { key: 'filterTagsOption', param: 'filterTagsOption', type: 'string' },
  { key: 'reportTagsOnlyThisUnit', param: 'reportTagsOnlyThisUnit', type: 'boolean' },
];

const QUERY_STATE_KEYS = QUERY_STATE_FIELD_CONFIGS.map((field) => field.key);

const MANAGED_QUERY_PARAM_NAMES = new Set<string>([
  RER_ANALYSIS_LEGACY_STATE_PARAM,
  ...QUERY_STATE_FIELD_CONFIGS.map((field) => field.param),
]);

const QUERY_STATE_DEFAULTS: RerAnalysisQueryState = {
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
  unitsExactMatchOnly: null,
  adjacentFreqsRange: 0,
  withoutModelTags: false,
  filterTagsOption: 'OneOfTags',
  reportTagsOnlyThisUnit: false,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function isSameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseBooleanParam(value: string | null): boolean | null {
  if (value == null) return null;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return null;
}

function parseNullableBooleanParam(value: string | null): boolean | null | undefined {
  if (value == null) return undefined;
  if (value === 'null') return null;
  return parseBooleanParam(value);
}

function parseNumberParam(value: string | null): number | null {
  if (value == null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNumberList(values: string[]): number[] {
  return values
    .map((value) => parseNumberParam(value))
    .filter((value): value is number => value != null);
}

export function normalizeRerAnalysisQueryState(state: unknown): RerAnalysisQueryState | null {
  if (!isPlainObject(state)) {
    return null;
  }

  const normalized: RerAnalysisQueryState = {};

  for (const key of QUERY_STATE_KEYS) {
    const value = state[key];
    if (value !== undefined) {
      normalized[key] = value;
    }
  }

  return normalized;
}

export function compactRerAnalysisQueryState(state: unknown): RerAnalysisQueryState {
  const normalized = normalizeRerAnalysisQueryState(state) ?? {};
  const compacted: RerAnalysisQueryState = {};

  for (const key of QUERY_STATE_KEYS) {
    const value = normalized[key];
    if (value === undefined) continue;
    if (isSameValue(value, QUERY_STATE_DEFAULTS[key])) continue;
    compacted[key] = value;
  }

  return compacted;
}

export function parseRerAnalysisQueryStateFromSearchParams(
  params: URLSearchParams,
): RerAnalysisQueryState | null {
  const parsed: RerAnalysisQueryState = {};

  for (const field of QUERY_STATE_FIELD_CONFIGS) {
    if (!params.has(field.param)) continue;

    if (field.type === 'string') {
      parsed[field.key] = params.get(field.param) ?? '';
      continue;
    }

    if (field.type === 'string[]') {
      parsed[field.key] = params.getAll(field.param).filter((value) => value !== '');
      continue;
    }

    if (field.type === 'boolean') {
      const value = parseBooleanParam(params.get(field.param));
      if (value != null) parsed[field.key] = value;
      continue;
    }

    if (field.type === 'boolean?') {
      const value = parseNullableBooleanParam(params.get(field.param));
      if (value !== undefined) parsed[field.key] = value;
      continue;
    }

    if (field.type === 'number') {
      const value = parseNumberParam(params.get(field.param));
      if (value != null) parsed[field.key] = value;
      continue;
    }

    if (field.type === 'number[]') {
      parsed[field.key] = parseNumberList(params.getAll(field.param));
    }
  }

  return Object.keys(parsed).length > 0 ? parsed : null;
}

export function hasRerAnalysisQueryStateParams(params: URLSearchParams): boolean {
  return QUERY_STATE_FIELD_CONFIGS.some((field) => params.has(field.param));
}

export function clearRerAnalysisQueryStateSearchParams(params: URLSearchParams): void {
  for (const paramName of MANAGED_QUERY_PARAM_NAMES) {
    params.delete(paramName);
  }
}

export function writeRerAnalysisQueryStateToSearchParams(
  params: URLSearchParams,
  state: unknown,
): void {
  const compactState = compactRerAnalysisQueryState(state);

  clearRerAnalysisQueryStateSearchParams(params);

  for (const field of QUERY_STATE_FIELD_CONFIGS) {
    const value = compactState[field.key];
    if (value === undefined) continue;

    if (field.type === 'string') {
      params.set(field.param, String(value));
      continue;
    }

    if (field.type === 'string[]') {
      for (const item of value as string[]) {
        params.append(field.param, item);
      }
      continue;
    }

    if (field.type === 'boolean') {
      params.set(field.param, String(value));
      continue;
    }

    if (field.type === 'boolean?') {
      params.set(field.param, value === null ? 'null' : String(value));
      continue;
    }

    if (field.type === 'number') {
      params.set(field.param, String(value));
      continue;
    }

    if (field.type === 'number[]') {
      for (const item of value as number[]) {
        params.append(field.param, String(item));
      }
    }
  }
}
