/** @vitest-environment happy-dom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../../../../Bindings';
import { useRerDutyPageSettings, type RerDutyPageSettings } from './useRerDutyPageSettings';

const mocks = vi.hoisted(() => ({
  currentSystemSettings: vi.fn(),
  fetchCurrentUser: vi.fn(),
  fetchUserSettings: vi.fn(),
}));
vi.mock('../../services/api/system-settings', () => ({
  currentSystemSettings: mocks.currentSystemSettings,
}));
vi.mock('../../services/api/user', () => ({ fetchCurrentUser: mocks.fetchCurrentUser }));
vi.mock('../../services/api/user-settings', () => ({
  USER_SETTINGS_UPDATED_EVENT: 'user-settings-updated',
  fetchUserSettings: mocks.fetchUserSettings,
}));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const settings = (devicesSectionEnabled = true, disableBotTags = false) => ({
  devicesSectionEnabled,
  enableAudioTranscription: false,
  disableBotTags,
});
let root: Root;
let container: HTMLDivElement;
let latest: RerDutyPageSettings | null = null;
function render() {
  root = createRoot(container);
  root.render(
    createElement(() => {
      latest = useRerDutyPageSettings();
      return null;
    }),
  );
}
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useRerDutyPageSettings device access', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    latest = null;
    mocks.fetchUserSettings.mockResolvedValue({
      tagsLayout: 'compact',
      messageTextPreviewLines: 20,
    });
  });
  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    vi.clearAllMocks();
  });
  it('remains loading when settings resolve before the user, then allows Cyber', async () => {
    const system = deferred<ReturnType<typeof settings>>();
    const user = deferred<User>();
    mocks.currentSystemSettings.mockReturnValue(system.promise);
    mocks.fetchCurrentUser.mockReturnValue(user.promise);
    render();
    await flush();
    expect(latest?.deviceAccess.status).toBe('loading');
    await act(async () => {
      system.resolve(settings());
      await Promise.resolve();
    });
    expect(latest?.deviceAccess.status).toBe('loading');
    await act(async () => {
      user.resolve({ roles: ['Cyber'] } as User);
      await Promise.resolve();
    });
    expect(latest?.deviceAccess.status).toBe('allowed');
  });
  it('remains loading when the user resolves before settings, then allows Admin', async () => {
    const system = deferred<ReturnType<typeof settings>>();
    const user = deferred<User>();
    mocks.currentSystemSettings.mockReturnValue(system.promise);
    mocks.fetchCurrentUser.mockReturnValue(user.promise);
    render();
    await flush();
    await act(async () => {
      user.resolve({ roles: ['Admin'] } as User);
      await Promise.resolve();
    });
    expect(latest?.deviceAccess.status).toBe('loading');
    await act(async () => {
      system.resolve(settings());
      await Promise.resolve();
    });
    expect(latest?.deviceAccess.status).toBe('allowed');
  });
  it.each([
    { system: true, user: false, message: 'settings lookup failed' },
    { system: false, user: true, message: 'user lookup failed' },
  ])('reports lookup failures as retained errors', async ({ system, user, message }) => {
    mocks.currentSystemSettings.mockImplementation(() =>
      system ? Promise.reject(new Error(message)) : Promise.resolve(settings()),
    );
    mocks.fetchCurrentUser.mockImplementation(() =>
      user ? Promise.reject(new Error(message)) : Promise.resolve({ roles: ['Cyber'] } as User),
    );
    render();
    await flush();
    expect(latest?.deviceAccess).toEqual({ status: 'error', message });
  });
  it.each([
    { enabled: false, roles: ['Cyber'] },
    { enabled: true, roles: ['Rer'] },
  ])('denies only completed authoritative settings or roles', async ({ enabled, roles }) => {
    mocks.currentSystemSettings.mockResolvedValue(settings(enabled));
    mocks.fetchCurrentUser.mockResolvedValue({ roles } as User);
    render();
    await flush();
    expect(latest?.deviceAccess.status).toBe('denied');
  });
  it('exposes the bot tag visibility setting', async () => {
    mocks.currentSystemSettings.mockResolvedValue(settings(true, true));
    mocks.fetchCurrentUser.mockResolvedValue({ roles: ['Rer'] } as User);
    render();
    await flush();
    expect(latest?.hideBotTags).toBe(true);
  });
});
