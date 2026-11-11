export function readAiAgentRequestDeepLink(search = window.location.search): string | null {
  const requestId = new URLSearchParams(search).get('requestId')?.trim();
  return requestId || null;
}

export function writeAiAgentRequestDeepLink(requestId: string | null) {
  const url = new URL(window.location.href);
  if (requestId) url.searchParams.set('requestId', requestId);
  else url.searchParams.delete('requestId');
  if (url.href === window.location.href) return;
  window.history.pushState({}, '', url);
}

const REQUEST_SEARCH_PARAM = 'id';
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The first request or conversation ID in pasted text, such as a chat URL. */
export function extractAiAgentRequestSearchId(text: string): string | null {
  return text.match(UUID_PATTERN)?.[0].toLowerCase() ?? null;
}

export function readAiAgentRequestSearch(search = window.location.search): string | null {
  return extractAiAgentRequestSearchId(new URLSearchParams(search).get(REQUEST_SEARCH_PARAM) ?? '');
}

export function writeAiAgentRequestSearch(searchId: string | null) {
  const url = new URL(window.location.href);
  if (searchId) url.searchParams.set(REQUEST_SEARCH_PARAM, searchId);
  else url.searchParams.delete(REQUEST_SEARCH_PARAM);
  if (url.href === window.location.href) return;
  window.history.pushState({}, '', url);
}
