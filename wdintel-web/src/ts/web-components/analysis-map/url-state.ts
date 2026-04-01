import {
  clearRerAnalysisQueryStateSearchParams,
  loadRerAnalysisQueryState,
  parseRerAnalysisQueryStateFromSearchParams,
  RER_ANALYSIS_LEGACY_STATE_PARAM,
  saveRerAnalysisQueryState,
  writeRerAnalysisQueryStateToSearchParams,
} from '../../rer-analysis-query-state';
import {
  loadLegacyRerAnalysisQueryState,
  parseRawRerAnalysisLegacyState,
  parseRerAnalysisLegacyState,
  saveLegacyRerAnalysisQueryState,
  toLegacyRerAnalysisQueryState,
} from '../../rer-analysis-query-state-legacy';

const CLASSIC_RER_ANALYSIS_PATH = '/rer-analysis';
export const parseStateFromUrl = parseRerAnalysisLegacyState;

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
    if (url.pathname === CLASSIC_RER_ANALYSIS_PATH) {
      const storedState = loadLegacyRerAnalysisQueryState();
      const rawStateFromUrl = parseRawRerAnalysisLegacyState(url.searchParams.get(RER_ANALYSIS_LEGACY_STATE_PARAM));
      const baseState =
        parseStateFromUrl(url.searchParams.get(RER_ANALYSIS_LEGACY_STATE_PARAM)) ??
        parseRerAnalysisQueryStateFromSearchParams(url.searchParams) ??
        storedState ??
        {};
      const stateObject = { ...baseState, search: messageUid };
      saveLegacyRerAnalysisQueryState(toLegacyRerAnalysisQueryState(stateObject));
      const canonicalLegacyState = toLegacyRerAnalysisQueryState(stateObject);
      const legacyState =
        rawStateFromUrl != null ? { ...rawStateFromUrl, ...canonicalLegacyState, search: messageUid } : canonicalLegacyState;
      clearRerAnalysisQueryStateSearchParams(url.searchParams);
      url.searchParams.set(RER_ANALYSIS_LEGACY_STATE_PARAM, JSON.stringify(legacyState));
    } else {
      const storedState = loadRerAnalysisQueryState();
      const baseState = parseRerAnalysisQueryStateFromSearchParams(url.searchParams) ?? storedState ?? {};
      const stateObject = { ...baseState, search: messageUid };
      saveRerAnalysisQueryState(stateObject);
      writeRerAnalysisQueryStateToSearchParams(url.searchParams, stateObject);
    }
    return url.href;
  } catch (error) {
    console.error('Error updating URL state:', error);
    return currentUrl;
  }
}
