/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const notificationUnreadCount = vi.hoisted(() => vi.fn());
const importantAdd = vi.hoisted(() => vi.fn());
const currentSystemSettings = vi.hoisted(() => vi.fn());
const fetchUserSettings = vi.hoisted(() => vi.fn());

vi.mock('../services/api/notifications', () => ({
  notificationUnreadCount,
  listNotifications: vi.fn(),
  readAllNotifications: vi.fn(),
  readNotification: vi.fn(),
  NOTIFICATION_POLL_INTERVAL_MS: 30_000,
}));
vi.mock('../services/api/inbox-message-actions', () => ({ importantAdd }));
vi.mock('../services/api/system-settings', () => ({ currentSystemSettings }));
vi.mock('../services/api/user-settings', () => ({
  fetchUserSettings,
  USER_SETTINGS_UPDATED_EVENT: 'user-settings-updated',
}));
vi.mock('../components/app-navbar/ChangelogDropdown', () => ({
  ChangelogDropdown: () => null,
}));
vi.mock('../components/app-navbar/ProfileDropdown', () => ({
  ProfileDropdown: () => null,
}));
vi.mock('../../debug-recorder', () => ({
  DEBUG_RECORDER_SLOT_ID: 'echo-debug-recorder-slot',
  configureBrowserDebugRecorder: vi.fn(),
  clearBrowserDebugRecording: vi.fn(),
  mountDebugRecorderPanelIfNeeded: vi.fn(),
}));
vi.mock('../../logo-coin', () => ({ mountLogoCoin: vi.fn() }));

import '../app-navbar-element';
import { IMPORTANT_MESSAGE_REQUEST_EVENT } from '../components/app-navbar/ImportantMessageDialog';

type NavbarElement = HTMLElement & { props: Record<string, unknown> | null };

const navbarProps = {
  user: {
    name: 'tester',
    roles: ['Rer'],
    goiFullAccessForOrganism: false,
    goiIntegrations: [],
  },
  shared: {
    themeMode: 'light',
    serverInfo: { mode: 'live', version: '2026.10.13' },
    changelogPreview: null,
    userLoaded: true,
    changelogLastSeenLoaded: true,
    changelogLastSeen: null,
    deploymentMaintenance: null,
  },
  activeName: 'rer-duty',
  isNavbarVisible: true,
  supportsFullscreenToggle: false,
};

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mountNavbar() {
  const navbar = document.createElement('app-navbar') as NavbarElement;
  await act(async () => {
    document.body.append(navbar);
    navbar.props = navbarProps;
  });
  await flush();
  return navbar;
}

function alertMessages() {
  return Array.from(document.querySelectorAll('[role="alert"]')).map((alert) => alert.textContent);
}

beforeEach(() => {
  currentSystemSettings.mockResolvedValue({
    defaultNeoAnalysis: false,
    enableAudioTranscription: false,
    showClassicDuty: true,
    showClassicAnalysis: true,
    devicesSectionEnabled: false,
    importantNotifyAllEnabled: true,
  });
  fetchUserSettings.mockResolvedValue({ showClassicDuty: false, showClassicAnalysis: false });
});

afterEach(async () => {
  await act(async () => {
    document.body.replaceChildren();
    await Promise.resolve();
  });
  vi.clearAllMocks();
});

describe('app-navbar custom element', () => {
  // Regression: https://github.com/echoua/echo/issues/3610
  it('keeps a deduplicated Inbox count error visible across prop updates and cleans it up', async () => {
    notificationUnreadCount.mockRejectedValue(new Error('count unavailable'));
    const navbar = await mountNavbar();

    expect(alertMessages()).toEqual(
      expect.arrayContaining([expect.stringContaining('count unavailable')]),
    );

    await act(async () => window.dispatchEvent(new Event('focus')));
    await flush();
    expect(notificationUnreadCount).toHaveBeenCalledTimes(2);
    expect(
      alertMessages().filter((message) => message?.includes('count unavailable')),
    ).toHaveLength(1);

    await act(async () => {
      navbar.props = { ...navbarProps, activeName: 'rer-analysis-neo' };
    });
    await flush();
    expect(alertMessages()).toEqual(
      expect.arrayContaining([expect.stringContaining('count unavailable')]),
    );

    await act(async () => navbar.remove());
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows both inline and snackbar errors for an important-message submission', async () => {
    notificationUnreadCount.mockResolvedValue(0);
    importantAdd.mockRejectedValue(new Error('submit unavailable'));
    await mountNavbar();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(IMPORTANT_MESSAGE_REQUEST_EVENT, {
          detail: { messageId: 17, groupMasterKey: 'group-a' },
        }),
      );
    });
    await act(async () => {
      Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Позначити')
        ?.click();
    });

    expect(
      alertMessages().filter((message) => message?.includes('submit unavailable')),
    ).toHaveLength(2);
  });
});
