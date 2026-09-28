export const AI_AGENT_NEW_CONVERSATION_EVENT = 'echo:ai-agent-new-conversation';

export function conversationIdFromUrl(): string | null {
  return new URL(window.location.href).searchParams.get('conversation')?.toLowerCase() ?? null;
}

export function isConversationId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

export function writeConversationUrl(id: string | null, replace = false) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set('conversation', id);
  else url.searchParams.delete('conversation');
  if (url.href === window.location.href) return;
  window.history[replace ? 'replaceState' : 'pushState']({}, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
