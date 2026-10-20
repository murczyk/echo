import type { AnalysisQueryState } from './types';
import type { GroupScope } from '../shared/group-navigation';
import {
  parseRerAnalysisQueryStateFromSearchParams,
  writeRerAnalysisQueryStateToSearchParams,
} from '../../../rer-analysis-query-state';

const STORAGE_KEY = 'rer-analysis-neo-scope-filters-v1';
const ONLY_WITH_MEDIA_PARAM = 'only_with_media';

type StoredScopeFilters = {
  version: 1;
  scopes: Record<string, string>;
};

function scopeKey(scope: GroupScope): string {
  return scope.kind === 'all' ? 'all' : `group:${scope.masterKey}`;
}

function readStoredScopeFilters(): StoredScopeFilters {
  if (typeof window === 'undefined') return { version: 1, scopes: {} };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null') as unknown;
    if (
      typeof parsed === 'object' &&
      parsed != null &&
      'version' in parsed &&
      parsed.version === 1 &&
      'scopes' in parsed &&
      typeof parsed.scopes === 'object' &&
      parsed.scopes != null &&
      Object.values(parsed.scopes).every((value) => typeof value === 'string')
    ) {
      return parsed as StoredScopeFilters;
    }
  } catch {
    // Ignore unavailable or malformed browser storage.
  }
  return { version: 1, scopes: {} };
}

function writeStoredScopeFilters(filters: StoredScopeFilters): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
  } catch {
    // URL state remains the fallback when browser storage is unavailable.
  }
}

export function extractAnalysisScopeFilters(
  state: AnalysisQueryState,
): Partial<AnalysisQueryState> {
  const {
    fromDateTimeStr: _fromDateTimeStr,
    toDateTimeStr: _toDateTimeStr,
    search: _search,
    messageTimeBasis: _messageTimeBasis,
    radioFeaturesAllowed: _radioFeaturesAllowed,
    ...filters
  } = state;
  return filters;
}

function serializeAnalysisScopeFilters(state: AnalysisQueryState): string {
  const params = new URLSearchParams();
  writeRerAnalysisQueryStateToSearchParams(params, extractAnalysisScopeFilters(state));
  if (state.onlyWithMedia) params.set(ONLY_WITH_MEDIA_PARAM, 'true');
  return params.toString();
}

function deserializeAnalysisScopeFilters(value: string): Partial<AnalysisQueryState> {
  const params = new URLSearchParams(value);
  return {
    ...(parseRerAnalysisQueryStateFromSearchParams(params) as Partial<AnalysisQueryState> | null),
    onlyWithMedia: params.get(ONLY_WITH_MEDIA_PARAM) === 'true',
  };
}

export function persistAnalysisScopeFilters(scope: GroupScope, state: AnalysisQueryState): void {
  const stored = readStoredScopeFilters();
  stored.scopes[scopeKey(scope)] = serializeAnalysisScopeFilters(state);
  writeStoredScopeFilters(stored);
}

export function readAnalysisScopeFilters(scope: GroupScope): Partial<AnalysisQueryState> | null {
  const stored = readStoredScopeFilters().scopes[scopeKey(scope)];
  return stored == null ? null : deserializeAnalysisScopeFilters(stored);
}
