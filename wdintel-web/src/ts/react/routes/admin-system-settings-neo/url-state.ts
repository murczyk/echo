export type SystemSettingsTab =
  'main' | 'duty' | 'analysis' | 'control' | 'pelengs' | 'notifications' | 'cache';

export type AiEngineUrlScreen =
  { kind: 'list' } | { kind: 'details'; aiEngineId: string } | { kind: 'edit'; aiEngineId: string };

const SYSTEM_SETTINGS_TABS = new Set<SystemSettingsTab>([
  'main',
  'duty',
  'analysis',
  'control',
  'pelengs',
  'notifications',
  'cache',
]);
const AI_ENGINE_HISTORY_ENTRY = 'systemSettingsAiEngineHistoryEntry';
const AI_ENGINE_EDIT_RETURN_TO_DETAILS = 'systemSettingsAiEngineEditReturnToDetails';

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
  const legacyPath = tab === 'ai' && section === 'engines';
  const providerPath = tab === 'engines';
  const id = providerPath ? section : aiEngineId;
  const requestedAction = providerPath ? aiEngineId : action;
  if ((!legacyPath && !providerPath) || !id) {
    return { kind: 'list' };
  }
  if (requestedAction === 'edit') {
    return { kind: 'edit', aiEngineId: id };
  }
  return { kind: 'details', aiEngineId: id };
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
  const nextUrl = buildHashUrl(`engines/${encodeURIComponent(aiEngineId)}${suffix}`);
  const currentState = historyStateWithAiEngineMarker();
  const nextState = { ...currentState };
  if (screen === 'edit' && mode === 'replace') {
    nextState[AI_ENGINE_EDIT_RETURN_TO_DETAILS] = aiEngineId;
  } else {
    delete nextState[AI_ENGINE_EDIT_RETURN_TO_DETAILS];
  }
  if (mode === 'push') {
    window.history.pushState(nextState, '', nextUrl);
    return;
  }
  window.history.replaceState(nextState, '', nextUrl);
}

export function shouldReturnAiEngineEditToDetails(aiEngineId: string): boolean {
  return window.history.state?.[AI_ENGINE_EDIT_RETURN_TO_DETAILS] === aiEngineId;
}

export function returnToAiEngineList(): void {
  if (window.history.state?.[AI_ENGINE_HISTORY_ENTRY] === true) {
    window.history.back();
    return;
  }
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${window.location.search}`,
  );
  window.dispatchEvent(new PopStateEvent('popstate'));
}
