/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppNavbar } from '../AppNavbar';

const currentSettingsMock = vi.hoisted(() => vi.fn());
const fetchUserSettingsMock = vi.hoisted(() => vi.fn());
const configureDebugRecorderMock = vi.hoisted(() => vi.fn());
const clearDebugRecorderMock = vi.hoisted(() => vi.fn());
const mountDebugRecorderPanelMock = vi.hoisted(() => vi.fn());

vi.mock('../../../services/api/system-settings', () => ({
  currentSystemSettings: currentSettingsMock,
}));
vi.mock('../../../services/api/user-settings', () => ({
  USER_SETTINGS_UPDATED_EVENT: 'user-settings-updated',
  fetchUserSettings: fetchUserSettingsMock,
}));
vi.mock('../../../../debug-recorder', () => ({
  DEBUG_RECORDER_SLOT_ID: 'echo-debug-recorder-slot',
  configureBrowserDebugRecorder: configureDebugRecorderMock,
  clearBrowserDebugRecording: clearDebugRecorderMock,
  mountDebugRecorderPanelIfNeeded: mountDebugRecorderPanelMock,
}));

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

const rendered: Rendered[] = [];

beforeEach(() => {
  currentSettingsMock.mockReset().mockResolvedValue({
    defaultNeoAnalysis: false,
    enableAudioTranscription: false,
    showClassicDuty: true,
    showClassicAnalysis: true,
    supportNonRerInterceptions: false,
    devicesSectionEnabled: false,
  });
  fetchUserSettingsMock.mockReset().mockResolvedValue({
    showClassicDuty: false,
    showClassicAnalysis: false,
  });
});

afterEach(() => {
  for (const item of rendered.splice(0)) {
    act(() => {
      item.root.unmount();
    });
    item.container.remove();
  }
  vi.clearAllMocks();
});

vi.mock('../ChangelogDropdown', () => ({
  ChangelogDropdown: () => <div data-testid="mock-changelog-dropdown" />,
}));

vi.mock('../ProfileDropdown', () => ({
  ProfileDropdown: ({ onLogout }: { onLogout: () => void }) => (
    <button data-testid="mock-profile-dropdown" onClick={onLogout} />
  ),
}));

function renderComponent(props: any) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(<AppNavbar {...props} />);
  });

  rendered.push({ container, root });
  return { container, root };
}

describe('AppNavbar', () => {
  const defaultProps = {
    user: {
      name: 'Test',
      roles: ['Basic'],
      goiFullAccessForOrganism: false,
      goiIntegrations: [],
    },
    shared: {
      themeMode: 'light',
      serverInfo: { mode: 'live', version: '2026.10.8' },
      changelogPreview: null,
      userLoaded: true,
      changelogLastSeenLoaded: true,
      changelogLastSeen: null,
    },
    activeName: 'rer-duty',
    isNavbarVisible: true,
    supportsFullscreenToggle: true,
    onLogout: vi.fn(),
    onThemeChange: vi.fn(),
    onNavbarVisibilityChange: vi.fn(),
    onOpenChangelog: vi.fn(),
  };

  it('renders the brand logo and title', () => {
    const { container } = renderComponent(defaultProps);
    const logoImg = Array.from(container.querySelectorAll('img')).find((img) =>
      img.src.includes('echo-logo.svg'),
    );
    const hoverLogoImg = Array.from(container.querySelectorAll('img')).find(
      (img) => img.alt === 'Risk Department',
    );
    expect(logoImg).not.toBeUndefined();
    expect(hoverLogoImg).not.toBeUndefined();
  });

  it('reserves a debug recorder slot immediately before the toolbar', async () => {
    const { container } = renderComponent(defaultProps);
    await act(async () => {
      await Promise.resolve();
    });
    const slot = container.querySelector('#echo-debug-recorder-slot');

    expect(slot).not.toBeNull();
    expect(slot?.nextElementSibling?.classList.contains('app-navbar-toolbar')).toBe(true);
  });

  it.each([
    ['live', 'Live'],
    ['debug', 'Debug'],
  ])('configures debug recorder metadata in %s mode', (mode, deploymentMode) => {
    renderComponent({
      ...defaultProps,
      shared: { ...defaultProps.shared, serverInfo: { mode, version: '2026.10.8' } },
    });
    expect(configureDebugRecorderMock).toHaveBeenCalledWith({
      deploymentMode,
      echoVersion: '2026.10.8',
    });
  });

  it('clears debug recording before dispatching navbar logout', async () => {
    await import('../../../app-navbar-element');
    const order: string[] = [];
    clearDebugRecorderMock.mockImplementation(() => order.push('clear'));
    const host = document.createElement('app-navbar') as HTMLElement & { props: unknown };
    host.addEventListener('navbar-logout', () => order.push('logout'));
    act(() => {
      document.body.append(host);
      host.props = defaultProps;
    });

    const logout = host.querySelector<HTMLButtonElement>('[data-testid="mock-profile-dropdown"]');
    act(() => logout?.click());
    expect(order).toEqual(['clear', 'logout']);
    act(() => host.remove());
  });

  // Regression: https://github.com/echoua/echo/issues/3568
  it.each(['Rer', 'Cyber', 'CyberViewer'])('#3568 renders main navigation for %s', (role) => {
    const { container } = renderComponent({
      ...defaultProps,
      user: { ...defaultProps.user, roles: [role] },
    });
    const content = container.textContent;
    expect(content).toContain('Оперативний');
    expect(content).toContain('Аналіз');
    expect(content).toContain('База даних');
    expect(content).toContain('Конвертери');
    // Admin should not be present
    expect(content).not.toContain('Адмін');
  });

  // Regression: https://github.com/echoua/echo/issues/3568
  it.each([
    ['Cyber'],
    ['CyberViewer'],
    ['Cyber', 'UnitsEditor'],
    ['Rer'],
    ['Rer', 'Cyber'],
    ['Admin'],
    ['Full', 'Cyber'],
  ])(
    '#3568 hides frequency and signal database links only without effective Rer: %j',
    (...roles) => {
      const { container } = renderComponent({
        ...defaultProps,
        user: { ...defaultProps.user, roles },
      });
      const allowed = roles.some((role) => ['Rer', 'Admin', 'Full'].includes(role));
      expect(Boolean(container.querySelector('a[href="/rer-signals"]'))).toBe(allowed);
      expect(Boolean(container.querySelector('a[href="/rer-freqs"]'))).toBe(allowed);
      expect(container.querySelector('a[href="/rer-networks-neo"]')).not.toBeNull();
    },
  );

  it('uses the same mobile left padding for linked and button menu entries', () => {
    const { container } = renderComponent({
      ...defaultProps,
      user: { ...defaultProps.user, roles: ['Rer'] },
    });

    expect(container.querySelector('a[href="/rer-duty-neo"]')?.className).toContain('px-3');
    expect(
      container.querySelector('button[aria-controls="navbar-dropdown-menu-database"]')?.className,
    ).toContain('px-3');
  });

  it('hides globally disabled classic menus and applies the user override', async () => {
    currentSettingsMock.mockResolvedValue({
      defaultNeoAnalysis: false,
      enableAudioTranscription: false,
      showClassicDuty: false,
      showClassicAnalysis: false,
    });
    fetchUserSettingsMock.mockResolvedValue({
      showClassicDuty: true,
      showClassicAnalysis: false,
    });

    const { container } = renderComponent({
      ...defaultProps,
      user: { ...defaultProps.user, roles: ['Rer'] },
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('a[href="/rer-duty"]')).not.toBeNull();
    expect(container.querySelector('a[href="/rer-analysis"]')).toBeNull();
    expect(
      container.querySelector('#navbar-dropdown-menu-operational a[href="/rer-duty-neo"]')
        ?.textContent,
    ).toBe('Новий');
    expect(
      container.querySelector('#navbar-dropdown-menu-analysis a[href="/rer-analysis-neo"]')
        ?.textContent,
    ).toBe('Аналіз');
  });

  it('uses section names for the only visible operative and analysis versions', async () => {
    currentSettingsMock.mockResolvedValue({
      defaultNeoAnalysis: true,
      enableAudioTranscription: false,
      showClassicDuty: false,
      showClassicAnalysis: false,
    });

    const { container } = renderComponent({
      ...defaultProps,
      user: { ...defaultProps.user, roles: ['Rer'] },
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      container.querySelector('#navbar-dropdown-menu-operational a[href="/rer-duty-neo"]')
        ?.textContent,
    ).toBe('Оперативний');
    expect(
      container.querySelector('#navbar-dropdown-menu-analysis a[href="/rer-analysis-neo"]')
        ?.textContent,
    ).toBe('Аналіз');
  });

  it('hides documentation and statistics analysis links when AI chat is disabled', () => {
    const { container } = renderComponent({
      ...defaultProps,
      user: { ...defaultProps.user, roles: ['Rer'] },
    });

    expect(container.textContent).toContain('Документація');
    expect(container.textContent).toContain('Статистика');

    act(() => {
      window.dispatchEvent(
        new CustomEvent('ai-agent-availability', { detail: { enabled: false } }),
      );
    });

    expect(container.textContent).not.toContain('Документація');
    expect(container.textContent).not.toContain('Статистика');
  });

  // Regression: https://github.com/echoua/echo/issues/3568
  it.each(['Rer', 'Cyber', 'CyberViewer'])(
    '#3568 keeps ApiAgent excluded from %s AI chat access',
    (role) => {
      const { container } = renderComponent({
        ...defaultProps,
        user: { ...defaultProps.user, roles: [role, 'ApiAgent'] },
      });

      act(() => {
        window.dispatchEvent(
          new CustomEvent('ai-agent-availability', { detail: { enabled: false } }),
        );
      });

      expect(container.textContent).toContain('Документація');
      expect(container.textContent).toContain('Статистика');
    },
  );

  it('renders Admin menu when user has Admin role', () => {
    const { container } = renderComponent({
      ...defaultProps,
      user: { ...defaultProps.user, roles: ['Admin'] },
    });
    expect(container.textContent).toContain('Адмін');
  });

  it('renders admin groups as right-side flyout menus', () => {
    const { container } = renderComponent({
      ...defaultProps,
      user: { ...defaultProps.user, roles: ['Admin'] },
    });
    const importTrigger = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]'),
    ).find((button) => button.textContent?.includes('Імпорт'));

    expect(importTrigger).toBeDefined();
    expect(importTrigger?.parentElement?.classList.contains('app-navbar-flyout-item')).toBe(true);
    expect(importTrigger?.nextElementSibling?.classList.contains('app-navbar-flyout')).toBe(true);
    expect(importTrigger?.nextElementSibling?.textContent).toContain('Імпорт CSV');
    expect(importTrigger?.nextElementSibling?.textContent).toContain('Імпорт Delta');
  });

  it('shows transcription only when transcription is enabled', () => {
    const disabled = renderComponent({
      ...defaultProps,
      user: { ...defaultProps.user, roles: ['Admin'] },
      shared: {
        ...defaultProps.shared,
        systemSettings: {
          defaultNeoAnalysis: false,
          enableAudioTranscription: false,
          showClassicDuty: true,
          showClassicAnalysis: true,
          supportNonRerInterceptions: false,
          devicesSectionEnabled: false,
        },
      },
    });
    expect(disabled.container.textContent).not.toContain('Транскрибація');

    currentSettingsMock.mockResolvedValue({
      defaultNeoAnalysis: false,
      enableAudioTranscription: true,
      showClassicDuty: true,
      showClassicAnalysis: true,
      supportNonRerInterceptions: false,
      devicesSectionEnabled: false,
    });
    const enabled = renderComponent({
      ...defaultProps,
      user: { ...defaultProps.user, roles: ['Admin'] },
      shared: {
        ...defaultProps.shared,
        systemSettings: {
          defaultNeoAnalysis: false,
          enableAudioTranscription: true,
          showClassicDuty: true,
          showClassicAnalysis: true,
          supportNonRerInterceptions: false,
          devicesSectionEnabled: false,
        },
      },
    });
    const content = enabled.container.textContent ?? '';
    expect(content).toContain('Транскрибація');
    expect(content.indexOf('Транскрибація')).toBeLessThan(content.indexOf('Інтеграції API'));
  });

  it('updates transcription when shared transcription settings change', () => {
    currentSettingsMock.mockReturnValue(Promise.withResolvers<never>().promise);
    const props = {
      ...defaultProps,
      user: { ...defaultProps.user, roles: ['Admin'] },
      shared: {
        ...defaultProps.shared,
        systemSettings: {
          defaultNeoAnalysis: false,
          enableAudioTranscription: false,
          showClassicDuty: true,
          showClassicAnalysis: true,
          supportNonRerInterceptions: false,
          devicesSectionEnabled: false,
        },
      },
    };
    const { container, root } = renderComponent(props);
    expect(container.textContent).not.toContain('Транскрибація');

    act(() => {
      root.render(
        <AppNavbar
          {...props}
          shared={{
            ...props.shared,
            systemSettings: {
              ...props.shared.systemSettings,
              enableAudioTranscription: true,
            },
          }}
        />,
      );
    });
    expect(container.textContent).toContain('Транскрибація');

    act(() => {
      root.render(<AppNavbar {...props} />);
    });
    expect(container.textContent).not.toContain('Транскрибація');
  });

  it('renders Devices in the database menu when the Devices section is enabled', () => {
    const { container } = renderComponent({
      ...defaultProps,
      user: { ...defaultProps.user, roles: ['Cyber'] },
      shared: {
        ...defaultProps.shared,
        systemSettings: {
          defaultNeoAnalysis: false,
          enableAudioTranscription: false,
          showClassicDuty: true,
          showClassicAnalysis: true,
          supportNonRerInterceptions: false,
          devicesSectionEnabled: true,
        },
      },
    });

    const content = container.textContent;
    expect(content).toContain('База даних');
    expect(content).toContain('Пристрої');
    expect(content).toContain('Мережі');
  });

  it('hides Devices when the Devices section is disabled or read role is missing', () => {
    const disabledGate = renderComponent({
      ...defaultProps,
      user: { ...defaultProps.user, roles: ['Cyber'] },
      shared: {
        ...defaultProps.shared,
        systemSettings: {
          defaultNeoAnalysis: false,
          enableAudioTranscription: false,
          showClassicDuty: true,
          showClassicAnalysis: true,
          supportNonRerInterceptions: true,
          devicesSectionEnabled: false,
        },
      },
    });
    expect(disabledGate.container.textContent).not.toContain('Пристрої');

    const missingRole = renderComponent({
      ...defaultProps,
      user: { ...defaultProps.user, roles: ['Basic'] },
      shared: {
        ...defaultProps.shared,
        systemSettings: {
          defaultNeoAnalysis: false,
          enableAudioTranscription: false,
          showClassicDuty: true,
          showClassicAnalysis: true,
          supportNonRerInterceptions: true,
          devicesSectionEnabled: true,
        },
      },
    });
    expect(missingRole.container.textContent).not.toContain('Пристрої');
  });

  it('renders Devices for Admin and keeps RER database items visible', () => {
    const { container } = renderComponent({
      ...defaultProps,
      user: { ...defaultProps.user, roles: ['Admin'] },
      shared: {
        ...defaultProps.shared,
        systemSettings: {
          defaultNeoAnalysis: false,
          enableAudioTranscription: false,
          showClassicDuty: true,
          showClassicAnalysis: true,
          supportNonRerInterceptions: false,
          devicesSectionEnabled: true,
        },
      },
    });

    const content = container.textContent;
    expect(content).toContain('База даних');
    expect(content).toContain('Мережі');
    expect(content).toContain('Пристрої');
  });

  it('refreshes Devices visibility after system settings are saved', async () => {
    currentSettingsMock
      .mockResolvedValueOnce({
        defaultNeoAnalysis: false,
        enableAudioTranscription: false,
        showClassicDuty: true,
        showClassicAnalysis: true,
        supportNonRerInterceptions: true,
        devicesSectionEnabled: false,
      })
      .mockResolvedValueOnce({
        defaultNeoAnalysis: false,
        enableAudioTranscription: false,
        showClassicDuty: true,
        showClassicAnalysis: true,
        supportNonRerInterceptions: false,
        devicesSectionEnabled: true,
      });

    const { container } = renderComponent({
      ...defaultProps,
      user: { ...defaultProps.user, roles: ['Cyber'] },
      shared: {
        ...defaultProps.shared,
        systemSettings: {
          defaultNeoAnalysis: false,
          enableAudioTranscription: false,
          showClassicDuty: true,
          showClassicAnalysis: true,
          supportNonRerInterceptions: true,
          devicesSectionEnabled: false,
        },
      },
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain('Пристрої');

    await act(async () => {
      window.dispatchEvent(new Event('system-settings-saved'));
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Пристрої');
  });

  it('toggles mobile menu on click', () => {
    const { container } = renderComponent(defaultProps);
    const mobileButton = container.querySelector('button[aria-controls="app-navbar-links-panel"]');

    // Initially hidden on mobile (hidden class present on the panel)
    const panel = container.querySelector('#app-navbar-links-panel');
    expect(panel?.className).toContain('hidden');
    expect(panel?.className.split(/\s+/)).not.toContain('border-t');

    act(() => {
      mobileButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // After click, 'flex' should replace 'hidden lg:flex' for mobile
    expect(panel?.className).not.toContain('hidden');
  });

  it('calls onNavbarVisibilityChange when fullscreen toggle is clicked', () => {
    const onNavbarVisibilityChange = vi.fn();
    const { container } = renderComponent({
      ...defaultProps,
      onNavbarVisibilityChange,
    });

    // Find the fullscreen toggle button
    const toggleButton = container.querySelector('button[title="Повноекранний режим"]');
    expect(toggleButton).not.toBeNull();
    expect(toggleButton?.className).toContain('rounded');

    act(() => {
      toggleButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onNavbarVisibilityChange).toHaveBeenCalled();
  });

  it('renders child components ProfileDropdown and ChangelogDropdown', () => {
    const { container } = renderComponent(defaultProps);
    expect(container.querySelector('[data-testid="mock-changelog-dropdown"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="mock-profile-dropdown"]')).not.toBeNull();
  });

  it('shows a spinner instead of the anonymous profile while the user is loading', () => {
    const { container } = renderComponent({
      ...defaultProps,
      user: { ...defaultProps.user, name: 'anonymous' },
      shared: { ...defaultProps.shared, userLoaded: false },
    });

    expect(container.querySelector('[data-testid="mock-profile-dropdown"]')).toBeNull();
    expect(container.querySelector('[aria-label="Завантаження користувача"]')).not.toBeNull();
    expect(container.querySelector('.MuiCircularProgress-root')).not.toBeNull();
    expect(container.textContent).not.toContain('anonymous');
  });
});
