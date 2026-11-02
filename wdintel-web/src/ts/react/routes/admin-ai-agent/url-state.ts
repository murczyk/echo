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
