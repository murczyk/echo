export type SystemSettingsTab =
  'main' | 'duty' | 'analysis' | 'control' | 'pelengs' | 'notifications' | 'ai';

export type AiEngineUrlScreen =
  { kind: 'list' } | { kind: 'details'; aiEngineId: string } | { kind: 'edit'; aiEngineId: string };

const SYSTEM_SETTINGS_TABS = new Set<SystemSettingsTab>([
  'main',
  'duty',
  'analysis',
  'control',
  'pelengs',
  'notifications',
  'ai',
]);
const AI_ENGINE_HISTORY_ENTRY = 'systemSettingsAiEngineHistoryEntry';

function hashParts(hash: string): string[] {
  return hash
    .replace(/^#/, '')
    .split('/')
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}

function buildHashUrl(hash: string): string {
  return `${window.location.pathname}${window.location.search}#${hash}`;
}

function historyStateWithAiEngineMarker(): Record<string, unknown> {
  const currentState =
    typeof window.history.state === 'object' && window.history.state !== null
      ? window.history.state
      : {};
  return { ...currentState, [AI_ENGINE_HISTORY_ENTRY]: true };
}

export function readSystemSettingsTab(hash = window.location.hash): SystemSettingsTab {
  const [tab] = hashParts(hash);
  return SYSTEM_SETTINGS_TABS.has(tab as SystemSettingsTab) ? (tab as SystemSettingsTab) : 'main';
}

export function readAiEngineUrlScreen(hash = window.location.hash): AiEngineUrlScreen {
  const [tab, section, aiEngineId, action] = hashParts(hash);
  if (tab !== 'ai' || section !== 'engines' || !aiEngineId) {
    return { kind: 'list' };
  }
  if (action === 'edit') {
    return { kind: 'edit', aiEngineId };
  }
  return { kind: 'details', aiEngineId };
}

export function replaceSystemSettingsTabUrl(tab: SystemSettingsTab): void {
  window.history.replaceState(window.history.state, '', buildHashUrl(tab));
}

export function updateAiEngineUrl(
  aiEngineId: string,
  screen: 'details' | 'edit',
  mode: 'push' | 'replace',
): void {
  const suffix = screen === 'edit' ? '/edit' : '';
  const nextUrl = buildHashUrl(`ai/engines/${encodeURIComponent(aiEngineId)}${suffix}`);
  if (mode === 'push') {
    window.history.pushState(historyStateWithAiEngineMarker(), '', nextUrl);
    return;
  }
  window.history.replaceState(window.history.state, '', nextUrl);
}

export function returnToAiEngineList(): void {
  if (window.history.state?.[AI_ENGINE_HISTORY_ENTRY] === true) {
    window.history.back();
    return;
  }
  replaceSystemSettingsTabUrl('ai');
  window.dispatchEvent(new PopStateEvent('popstate'));
}
