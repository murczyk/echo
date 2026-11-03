export const AI_AGENT_NEW_CONVERSATION_EVENT = 'echo:ai-agent-new-conversation';

export function conversationIdFromUrl(): string | null {
  return new URL(window.location.href).searchParams.get('conversation')?.toLowerCase() ?? null;
}

export function isConversationId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

// The chat owns the home query: params left by other pages must not survive into a conversation URL.
// Late writes after SPA navigation away from home must not touch the next page's URL.
export function writeConversationUrl(id: string | null, replace = false) {
  if (window.location.pathname !== '/') return;
  const url = new URL(window.location.href);
  url.search = '';
  if (id) url.searchParams.set('conversation', id);
  if (url.href === window.location.href) return;
  window.history[replace ? 'replaceState' : 'pushState']({}, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
