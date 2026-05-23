export const KEYWORD_SET_ID_SEARCH_PARAM = 'setId';

export function readIntegerSearchParam(name: string): number | null {
  const raw = new URLSearchParams(window.location.search).get(name);
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function replaceSettingsUrlSearchParams(mutator: (params: URLSearchParams) => void) {
  const url = new URL(window.location.href);
  mutator(url.searchParams);
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
}

export function readKeywordSetIdFromUrl(): number | null {
  return readIntegerSearchParam(KEYWORD_SET_ID_SEARCH_PARAM);
}

export function writeKeywordSetIdToUrl(setId: number | null) {
  replaceSettingsUrlSearchParams((params) => {
    if (setId == null) {
      params.delete(KEYWORD_SET_ID_SEARCH_PARAM);
    } else {
      params.set(KEYWORD_SET_ID_SEARCH_PARAM, String(setId));
    }
  });
}
