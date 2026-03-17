import { loadRerAnalysisQueryState, RerAnalysisQueryState, saveRerAnalysisQueryState } from '../../rer-analysis-query-state';

export function parseStateFromUrl(stateParam: string | null): RerAnalysisQueryState | null {
  if (!stateParam) {
    return null;
  }

  try {
    const parsed = JSON.parse(stateParam);
    if (parsed && typeof parsed === 'object') {
      return parsed as RerAnalysisQueryState;
    }
  } catch (_error) {
    try {
      const decodedState = decodeURIComponent(stateParam);
      const parsed = JSON.parse(decodedState);
      if (parsed && typeof parsed === 'object') {
        return parsed as RerAnalysisQueryState;
      }
    } catch (_) {
      // ignore malformed state
    }
  }

  return null;
}

export function getSearchQueryFromCurrentUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URL(window.location.href).searchParams;
  const fromParam = params.get('search');
  if (fromParam != null && String(fromParam).trim() !== '') return String(fromParam).trim();
  const state = parseStateFromUrl(params.get('state'));
  const fromState = state?.search;
  if (fromState != null && String(fromState).trim() !== '') return String(fromState).trim();
  return null;
}

export function updateStateUrl(currentUrl: string, messageUid: string): string {
  try {
    const url = new URL(currentUrl);
    const storedState = loadRerAnalysisQueryState();
    const baseState = storedState ?? parseStateFromUrl(url.searchParams.get('state')) ?? {};
    const stateObject: RerAnalysisQueryState = { ...(baseState as RerAnalysisQueryState), search: messageUid };
    saveRerAnalysisQueryState(stateObject);

    url.searchParams.set('state', JSON.stringify(stateObject));
    return url.href;
  } catch (error) {
    console.error('Error updating URL state:', error);
    return currentUrl;
  }
}
