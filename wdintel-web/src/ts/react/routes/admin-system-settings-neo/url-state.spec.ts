/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readAiEngineUrlScreen,
  readSystemSettingsTab,
  replaceSystemSettingsTabUrl,
  returnToAiEngineList,
  updateAiEngineUrl,
} from './url-state';

describe('system settings URL state', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/admin/system-settings-neo');
    vi.restoreAllMocks();
  });

  it('reads tabs and AI engine screens from anchors', () => {
    expect(readSystemSettingsTab('#notifications')).toBe('notifications');
    expect(readSystemSettingsTab('#cache')).toBe('cache');
    expect(readSystemSettingsTab('#analysis')).toBe('analysis');
    expect(readSystemSettingsTab('#ai/engines/engine-id')).toBe('ai');
    expect(readSystemSettingsTab('#unknown')).toBe('main');
    expect(readAiEngineUrlScreen('#ai')).toEqual({ kind: 'list' });
    expect(readAiEngineUrlScreen('#ai/engines/engine-id')).toEqual({
      kind: 'details',
      aiEngineId: 'engine-id',
    });
    expect(readAiEngineUrlScreen('#ai/engines/engine-id/edit')).toEqual({
      kind: 'edit',
      aiEngineId: 'engine-id',
    });
  });

  it('replaces tab anchors without adding history entries', () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const pushState = vi.spyOn(window.history, 'pushState');

    replaceSystemSettingsTabUrl('duty');
    replaceSystemSettingsTabUrl('ai');

    expect(window.location.hash).toBe('#ai');
    expect(replaceState).toHaveBeenCalledTimes(2);
    expect(pushState).not.toHaveBeenCalled();
  });

  it('pushes details and replaces them with the edit URL', () => {
    updateAiEngineUrl('engine-id', 'details', 'push');
    expect(window.location.hash).toBe('#ai/engines/engine-id');

    updateAiEngineUrl('engine-id', 'edit', 'replace');
    expect(window.location.hash).toBe('#ai/engines/engine-id/edit');

    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    returnToAiEngineList();
    expect(back).toHaveBeenCalledOnce();
  });

  it('returns direct detail links to the AI tab without leaving the page', () => {
    window.history.replaceState({}, '', '/admin/system-settings-neo#ai/engines/engine-id');
    const popState = vi.fn();
    window.addEventListener('popstate', popState);

    returnToAiEngineList();

    expect(window.location.hash).toBe('#ai');
    expect(popState).toHaveBeenCalledOnce();
    window.removeEventListener('popstate', popState);
  });
});
