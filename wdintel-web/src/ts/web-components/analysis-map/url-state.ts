import { parseRerAnalysisQueryStateFromSearchParams } from '../../rer-analysis-query-state';
import { parseRerAnalysisLegacyState } from '../../rer-analysis-query-state-legacy';

export const parseStateFromUrl = parseRerAnalysisLegacyState;

export function getSearchQueryFromCurrentUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URL(window.location.href).searchParams;
  const fromFlatState = parseRerAnalysisQueryStateFromSearchParams(params)?.search;
  if (fromFlatState != null && String(fromFlatState).trim() !== '')
    return String(fromFlatState).trim();
  const state = parseStateFromUrl(params.get('state'));
  const fromState = state?.search;
  if (fromState != null && String(fromState).trim() !== '') return String(fromState).trim();
  return null;
}
