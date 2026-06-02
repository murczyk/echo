/**
 * @vitest-environment happy-dom
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SigintZone } from '../../../../Bindings';

const saveUserDutySettings = vi.hoisted(() => vi.fn());
const fetchServerInfoMock = vi.hoisted(() => vi.fn().mockResolvedValue({ version: '1.0.0' }));
const fetchCurrentUserMock = vi.hoisted(() => vi.fn().mockResolvedValue({ sigintZoneId: 1, roles: [] }));
const listMyAdminGroupsMock = vi.hoisted(() => vi.fn().mockResolvedValue({ groups: [] }));

vi.mock('@mui/material', () => ({
  Autocomplete: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Box: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CircularProgress: () => <span>loading</span>,
  FormControlLabel: ({ control, label }: { control: ReactNode; label: ReactNode }) => (
    <div>
      {control}
      {label}
    </div>
  ),
  Stack: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Table: ({ children }: { children: ReactNode }) => <table>{children}</table>,
  TableBody: ({ children }: { children: ReactNode }) => <tbody>{children}</tbody>,
  TableCell: ({ children }: { children: ReactNode }) => <td>{children}</td>,
  TableContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TableHead: ({ children }: { children: ReactNode }) => <thead>{children}</thead>,
  TableRow: ({ children }: { children: ReactNode }) => <tr>{children}</tr>,
  Tab: ({ label }: { label?: ReactNode }) => <div>{label}</div>,
  Tabs: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Switch: ({ checked, onChange }: { checked?: boolean; onChange?: (_event: unknown, value: boolean) => void }) => (
    <button type="button" onClick={() => onChange?.(new Event('change'), !checked)}>
      {checked ? 'on' : 'off'}
    </button>
  ),
  TextField: ({ label }: { label?: ReactNode }) => <label>{label}</label>,
  Typography: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../components/PageHeader', () => ({
  PageHeader: ({ title }: { title: string }) => <div>{title}</div>,
}));

vi.mock('../../components/PowerButton', () => ({
  PowerButton: (props: { children: ReactNode; onClick?: () => void; type?: 'button' | 'submit'; disabled?: boolean }) => (
    <button type={props.type ?? 'button'} onClick={props.onClick} disabled={props.disabled}>
      {props.children}
    </button>
  ),
}));

vi.mock('../../components/PowerAlert', () => ({
  PowerAlert: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../services/api/client', () => ({
  isUnauthorizedError: () => false,
}));

vi.mock('../../services/api/server-info', () => ({
  fetchServerInfo: fetchServerInfoMock,
}));

vi.mock('../../services/api/user', () => ({
  fetchCurrentUser: fetchCurrentUserMock,
  saveUserSettings: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/api/user-settings', () => ({
  USER_SETTINGS_UPDATED_EVENT: 'user-settings-updated',
  fetchUserSettings: vi.fn().mockResolvedValue({ tagsLayout: 'compact', disableAutoScroll: false, analysisMapInSidebar: false }),
  saveUserSettings: saveUserDutySettings,
}));

vi.mock('../../services/api/zones', () => ({
  listSigintZones: vi.fn().mockResolvedValue([[1, { name: 'Zone 1' } as SigintZone]]),
  listMyAdminGroups: listMyAdminGroupsMock,
}));

vi.mock('./SettingsDutySection', () => ({
  SettingsDutySection: (props: {
    onTagsLayoutChange: (layout: 'full' | 'compact' | 'hidden') => void;
    onDisableAutoScrollChange: (value: boolean) => void;
  }) => (
    <div>
      <button type="button" onClick={() => props.onTagsLayoutChange('full')}>
        change-layout
      </button>
      <button type="button" onClick={() => props.onDisableAutoScrollChange(true)}>
        change-scroll
      </button>
    </div>
  ),
}));

vi.mock('./SettingsSharedTagsLayoutCard', () => ({
  SettingsSharedTagsLayoutCard: () => <div />,
}));

vi.mock('./SettingsReportsSection', () => ({
  SettingsReportsSection: ({ userRoles, rolesLoading }: { userRoles: string[]; rolesLoading: boolean }) => (
    <div>
      <span>rolesLoading:{String(rolesLoading)}</span>
      <span>{userRoles.join(',')}</span>
    </div>
  ),
}));

import { SettingsNeoPage } from './index';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe('SettingsNeoPage', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    saveUserDutySettings.mockReset();
    saveUserDutySettings.mockResolvedValue(undefined);
    fetchServerInfoMock.mockReset();
    fetchServerInfoMock.mockResolvedValue({ version: '1.0.0' });
    fetchCurrentUserMock.mockReset();
    fetchCurrentUserMock.mockResolvedValue({ sigintZoneId: 1, roles: [] });
    listMyAdminGroupsMock.mockReset();
    listMyAdminGroupsMock.mockResolvedValue({ groups: [] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
  });

  it('drains queued duty saves after a transient failure', async () => {
    const firstSave = deferred<void>();
    const secondSave = deferred<void>();
    saveUserDutySettings
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementationOnce(() => secondSave.promise);

    await act(async () => {
      root.render(<SettingsNeoPage section="duty" />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const buttons = Array.from(container.querySelectorAll('button'));
    const changeLayout = buttons.find((button) => button.textContent?.includes('change-layout'));
    const changeScroll = buttons.find((button) => button.textContent?.includes('change-scroll'));
    expect(changeLayout).toBeTruthy();
    expect(changeScroll).toBeTruthy();

    await act(async () => {
      changeLayout?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      changeScroll?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(saveUserDutySettings).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstSave.reject(new Error('transient'));
      await Promise.resolve();
    });

    expect(saveUserDutySettings).toHaveBeenCalledTimes(2);
    expect(saveUserDutySettings.mock.calls[1]?.[0]).toEqual({
      tagsLayout: 'full',
      disableAutoScroll: true,
      analysisMapInSidebar: false,
    });

    await act(async () => {
      secondSave.resolve();
      await Promise.resolve();
    });
  });

  it('saves analysis map placement and emits the updated settings event', async () => {
    await act(async () => {
      root.render(<SettingsNeoPage section="analysis" />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const switchButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'off');
    expect(switchButton).toBeTruthy();

    await act(async () => {
      switchButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(saveUserDutySettings).toHaveBeenCalledWith({
      tagsLayout: 'compact',
      disableAutoScroll: false,
      analysisMapInSidebar: true,
    });
  });

  it('renders general settings', async () => {
    await act(async () => {
      root.render(<SettingsNeoPage section="general" />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Загальні');
    expect(container.textContent).toContain('Версія: 1.0.0');
  });

  it('keeps general settings active when admin groups exist', async () => {
    listMyAdminGroupsMock.mockResolvedValueOnce({
      groups: [
        {
          masterKey: 'signal:group-1',
          name: 'Group 1',
          datasourceName: null,
          datasourceKind: 'signal',
          isGroupSecret: false,
          allowedUsers: [],
          adminLogins: ['DeltaUser'],
          areasOfResponsibility: null,
        },
      ],
    });

    await act(async () => {
      root.render(<SettingsNeoPage section="general" />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Загальні');
    expect(container.textContent).toContain('Мої групи');
    expect(container.textContent).toContain('Версія: 1.0.0');
    expect(container.textContent).not.toContain('Group 1');
  });

  it('keeps required settings loaded when server info fails', async () => {
    fetchServerInfoMock.mockRejectedValueOnce(new Error('server down'));
    fetchCurrentUserMock.mockResolvedValueOnce({ sigintZoneId: 1, roles: ['Admin'] });

    await act(async () => {
      root.render(<SettingsNeoPage section="reports" />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('rolesLoading:false');
    expect(container.textContent).toContain('Admin');
  });
});
