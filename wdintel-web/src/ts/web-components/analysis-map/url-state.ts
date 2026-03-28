import {
  loadRerAnalysisQueryState,
  normalizeRerAnalysisQueryState,
  parseRerAnalysisQueryStateFromSearchParams,
  RerAnalysisQueryState,
  saveRerAnalysisQueryState,
  writeRerAnalysisQueryStateToSearchParams,
} from '../../rer-analysis-query-state';

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
    const baseState =
      parseRerAnalysisQueryStateFromSearchParams(url.searchParams) ??
      storedState ??
      parseStateFromUrl(url.searchParams.get('state')) ??
      {};
    const stateObject: RerAnalysisQueryState = { ...(baseState as RerAnalysisQueryState), search: messageUid };
    saveRerAnalysisQueryState(stateObject);
    writeRerAnalysisQueryStateToSearchParams(url.searchParams, stateObject);
    return url.href;
  } catch (error) {
    console.error('Error updating URL state:', error);
    return currentUrl;
  }
}
