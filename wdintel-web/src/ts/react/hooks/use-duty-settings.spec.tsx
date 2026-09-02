/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { USER_SETTINGS_UPDATED_EVENT } from '../services/api/user-settings';
import { useDutySettings } from './use-duty-settings';

const fetchUserSettingsMock = vi.hoisted(() => vi.fn());

vi.mock('../services/api/user-settings', () => ({
  USER_SETTINGS_UPDATED_EVENT: 'user-settings-updated',
  fetchUserSettings: fetchUserSettingsMock,
  saveUserSettings: vi.fn(),
}));

let rendered: { container: HTMLDivElement; root: Root } | null = null;
let latestSettings: ReturnType<typeof useDutySettings> | null = null;

function HookProbe() {
  latestSettings = useDutySettings();
  return null;
}

function renderHook() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(createElement(HookProbe));
  });

  rendered = { container, root };
}

afterEach(() => {
  if (rendered !== null) {
    act(() => rendered?.root.unmount());
    rendered.container.remove();
    rendered = null;
  }
  latestSettings = null;
});

beforeEach(() => {
  fetchUserSettingsMock.mockReset();
});

// @test-scope safeguard: preserves an explicit “Off” preview preference across initial hydration and external user-settings updates instead of silently restoring message truncation.
describe('useDutySettings', () => {
  it('preserves Off from the initial settings load', async () => {
    fetchUserSettingsMock.mockResolvedValue({ messageTextPreviewLines: null });

    renderHook();
    await act(async () => {});

    expect(latestSettings?.messageTextPreviewLines).toBeNull();
  });

  it('preserves Off from a user-settings update event', async () => {
    fetchUserSettingsMock.mockResolvedValue({ messageTextPreviewLines: 20 });

    renderHook();
    await act(async () => {});

    act(() => {
      window.dispatchEvent(
        new CustomEvent(USER_SETTINGS_UPDATED_EVENT, {
          detail: { messageTextPreviewLines: null },
        }),
      );
    });

    expect(latestSettings?.messageTextPreviewLines).toBeNull();
  });
});
