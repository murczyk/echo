/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readAiEngineUrlScreen,
  readSystemSettingsTab,
  replaceSystemSettingsTabUrl,
  returnToAiEngineList,
  shouldReturnAiEngineEditToDetails,
  updateAiEngineUrl,
} from './url-state';

describe('system settings URL state', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/admin/system-settings-neo');
    vi.restoreAllMocks();
  });

  it('reads settings tabs and provider engine screens from anchors', () => {
    expect(readSystemSettingsTab('#notifications')).toBe('notifications');
    expect(readSystemSettingsTab('#cache')).toBe('cache');
    expect(readSystemSettingsTab('#analysis')).toBe('analysis');
    expect(readSystemSettingsTab('#ai/engines/engine-id')).toBe('main');
    expect(readSystemSettingsTab('#unknown')).toBe('main');
    expect(readAiEngineUrlScreen('')).toEqual({ kind: 'list' });
    expect(readAiEngineUrlScreen('#engines/engine-id')).toEqual({
      kind: 'details',
      aiEngineId: 'engine-id',
    });
    expect(readAiEngineUrlScreen('#engines/engine-id/edit')).toEqual({
      kind: 'edit',
      aiEngineId: 'engine-id',
    });
  });

  it('replaces tab anchors without adding history entries', () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const pushState = vi.spyOn(window.history, 'pushState');

    replaceSystemSettingsTabUrl('duty');
    replaceSystemSettingsTabUrl('cache');

    expect(window.location.hash).toBe('#cache');
    expect(replaceState).toHaveBeenCalledTimes(2);
    expect(pushState).not.toHaveBeenCalled();
  });

  it('pushes details and replaces them with the edit URL', () => {
    updateAiEngineUrl('engine-id', 'details', 'push');
    expect(window.location.hash).toBe('#engines/engine-id');

    updateAiEngineUrl('engine-id', 'edit', 'replace');
    expect(window.location.hash).toBe('#engines/engine-id/edit');
    expect(shouldReturnAiEngineEditToDetails('engine-id')).toBe(true);

    updateAiEngineUrl('engine-id', 'details', 'replace');
    expect(shouldReturnAiEngineEditToDetails('engine-id')).toBe(false);

    updateAiEngineUrl('engine-id', 'edit', 'replace');

    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    returnToAiEngineList();
    expect(back).toHaveBeenCalledOnce();
  });

  it('returns direct detail links to the provider list without leaving the page', () => {
    window.history.replaceState({}, '', '/admin/ai/providers#engines/engine-id');
    const popState = vi.fn();
    window.addEventListener('popstate', popState);

    returnToAiEngineList();

    expect(window.location.hash).toBe('');
    expect(popState).toHaveBeenCalledOnce();
    window.removeEventListener('popstate', popState);
  });
});
