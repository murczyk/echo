export function readAiAgentRequestDeepLink(search = window.location.search): string | null {
  const requestId = new URLSearchParams(search).get('requestId')?.trim();
  return requestId || null;
}
