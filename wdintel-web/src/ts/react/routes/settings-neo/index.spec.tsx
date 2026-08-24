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
const currentSystemSettingsMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ enableAudioTranscription: true }),
);
const fetchCurrentUserMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ sigintZoneId: 1, roles: [] }),
);
const listMyAdminGroupsMock = vi.hoisted(() => vi.fn().mockResolvedValue({ groups: [] }));
const updateMyAdminGroupMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const fetchMyAdminGroupEditReferenceMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ logins: [], organisms: [], areasOfResponsibility: [] }),
);

vi.mock('@mui/material', () => ({
  Autocomplete: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Box: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CircularProgress: () => <span>loading</span>,
  Dialog: ({ children, open }: { children: ReactNode; open?: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogActions: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  FormControlLabel: ({ control, label }: { control: ReactNode; label: ReactNode }) => (
    <div>
      {control}
      {label}
    </div>
  ),
  ListItemIcon: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  ListItemText: ({ primary }: { primary?: ReactNode }) => <span>{primary}</span>,
  MenuItem: ({ children, onClick }: { children: ReactNode; onClick?: (event: any) => void }) => (
    <button type="button" onClick={(event) => onClick?.(event)}>
      {children}
    </button>
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
  Switch: ({
    checked,
    onChange,
  }: {
    checked?: boolean;
    onChange?: (_event: unknown, value: boolean) => void;
  }) => (
    <button type="button" onClick={() => onChange?.(new Event('change'), !checked)}>
      {checked ? 'on' : 'off'}
    </button>
  ),
  TextField: ({ label }: { label?: ReactNode }) => <label>{label}</label>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  Typography: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../components/PageHeader', () => ({
  PageHeader: ({ title }: { title: string }) => <div>{title}</div>,
}));

vi.mock('../../components/PowerButton', () => ({
  PowerButton: (props: {
    children: ReactNode;
    onClick?: () => void;
    type?: 'button' | 'submit';
    disabled?: boolean;
  }) => (
    <button type={props.type ?? 'button'} onClick={props.onClick} disabled={props.disabled}>
      {props.children}
    </button>
  ),
}));

vi.mock('../../components/PowerIconButton', () => ({
  PowerIconButton: ({
    children,
    onClick,
    disabled,
    type,
    ...rest
  }: {
    children: ReactNode;
    onClick?: (event: any) => void;
    disabled?: boolean;
    type?: 'button';
    [key: string]: unknown;
  }) => (
    <button
      {...rest}
      type={type ?? 'button'}
      onClick={(event) => onClick?.(event)}
      disabled={disabled}
    >
      {children}
    </button>
  ),
}));

vi.mock('../../components/PowerMenu', () => ({
  PowerMenu: ({ children, open }: { children: ReactNode; open?: boolean }) =>
    open ? <div>{children}</div> : null,
}));

vi.mock('../../components/PowerAlert', () => ({
  PowerAlert: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('material-react-table', () => ({
  useMaterialReactTable: (config: any) => config,
  MaterialReactTable: ({ table }: { table: any }) => (
    <div>
      {table.columns.map((column: any) => (
        <span key={column.id ?? column.accessorKey}>{column.header}</span>
      ))}
      {table.data.map((row: any) => (
        <div key={row.masterKey}>
          {table.columns.map((column: any) => (
            <span key={column.id ?? column.accessorKey}>
              {column.Cell
                ? column.Cell({ row: { original: row } })
                : String(
                    column.accessorFn ? column.accessorFn(row) : (row[column.accessorKey] ?? ''),
                  )}
            </span>
          ))}
        </div>
      ))}
    </div>
  ),
}));

vi.mock('../../components/mui-customized/table/custom-styles', () => ({
  CUSTOM_CELL_STYLES: {},
  CUSTOM_STYLES: {
    displayColumnDefOptions: { 'mrt-row-numbers': {} },
    muiTableContainerProps: {},
    muiTablePaperProps: {},
  },
  FULL_HEIGHT_LOADING_ROW_COUNT: 2,
  FULL_WIDTH_TABLE_PAPER_SX: {},
  getPageScrollTableContainerSx: () => ({}),
}));

vi.mock('../../components/mui-customized/table/get-default-table-options', () => ({
  getDefaultMRTOptions: () => ({}),
  useAppMaterialReactTable: (options: Record<string, unknown>) => ({
    ...options,
    options,
    getState: () => ({ isFullScreen: false }),
  }),
  renderColumnActionsMenuItems: () => [],
}));

vi.mock('../../components/mui-customized/table/table-state-provider', () => ({
  TableStateProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useTableStateContext: () => ({
    enableColumnOrdering: false,
    enableColumnResizing: true,
    globalFilter: '',
    columnVisibility: {},
    columnFilters: [],
    density: 'compact',
    sorting: [],
    columnOrder: [],
    columnSizing: {},
    onColumnVisibilityChange: vi.fn(),
    onColumnFiltersChange: vi.fn(),
    onColumnOrderChange: vi.fn(),
    onColumnSizingChange: vi.fn(),
    onSortingChange: vi.fn(),
    onChangeGlobalFilter: vi.fn(),
    onTableInitialized: vi.fn(),
  }),
}));

vi.mock('../../services/api/client', () => ({
  isUnauthorizedError: () => false,
}));

vi.mock('../../services/api/server-info', () => ({
  fetchServerInfo: fetchServerInfoMock,
}));

vi.mock('../../services/api/system-settings', () => ({
  currentSystemSettings: currentSystemSettingsMock,
}));

vi.mock('../../services/api/user', () => ({
  fetchCurrentUser: fetchCurrentUserMock,
  saveUserSettings: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/api/user-settings', () => ({
  USER_SETTINGS_UPDATED_EVENT: 'user-settings-updated',
  fetchUserSettings: vi.fn().mockResolvedValue({
    tagsLayout: 'compact',
    disableAutoScroll: false,
    analysisMapInSidebar: false,
    dutyAudioTranscriptionCollapsed: false,
    analysisAudioTranscriptionCollapsed: false,
    showAnalysisCallsignAddForm: false,
    showClassicDuty: false,
    showClassicAnalysis: false,
    dutyCollapseMediaPreviews: true,
  }),
  saveUserSettings: saveUserDutySettings,
}));

vi.mock('../../services/api/zones', () => ({
  listSigintZones: vi.fn().mockResolvedValue([[1, { name: 'Zone 1' } as SigintZone]]),
  listMyAdminGroups: listMyAdminGroupsMock,
  updateMyAdminGroup: updateMyAdminGroupMock,
  fetchMyAdminGroupEditReference: fetchMyAdminGroupEditReferenceMock,
}));

vi.mock('./SettingsDutySection', () => ({
  SettingsDutySection: (props: {
    onTagsLayoutChange: (layout: 'full' | 'compact' | 'hidden') => void;
    onDisableAutoScrollChange: (value: boolean) => void;
    onAudioTranscriptionCollapsedChange: (value: boolean) => void;
    showAudioTranscriptionSettings: boolean;
  }) => (
    <div>
      <button type="button" onClick={() => props.onTagsLayoutChange('full')}>
        change-layout
      </button>
      <button type="button" onClick={() => props.onDisableAutoScrollChange(true)}>
        change-scroll
      </button>
      {props.showAudioTranscriptionSettings ? (
        <button type="button" onClick={() => props.onAudioTranscriptionCollapsedChange(true)}>
          change-duty-transcription
        </button>
      ) : null}
    </div>
  ),
}));

vi.mock('./SettingsSharedTagsLayoutCard', () => ({
  SettingsSharedTagsLayoutCard: () => <div />,
}));

vi.mock('./SettingsMyOrganismSection', () => ({
  SettingsMyOrganismSection: () => <div>my-organism-active</div>,
}));

import { SettingsNeoPage } from './index';
import { preserveUnknownOrganismIds } from './SettingsMyGroupsSection';

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
    window.history.replaceState({}, '', '/settings-neo');
    saveUserDutySettings.mockReset();
    saveUserDutySettings.mockImplementation(async (settings) => settings);
    fetchServerInfoMock.mockReset();
    fetchServerInfoMock.mockResolvedValue({ version: '1.0.0' });
    currentSystemSettingsMock.mockReset();
    currentSystemSettingsMock.mockResolvedValue({ enableAudioTranscription: true });
    fetchCurrentUserMock.mockReset();
    fetchCurrentUserMock.mockResolvedValue({ sigintZoneId: 1, roles: [] });
    listMyAdminGroupsMock.mockReset();
    listMyAdminGroupsMock.mockResolvedValue({ groups: [] });
    updateMyAdminGroupMock.mockReset();
    updateMyAdminGroupMock.mockResolvedValue(undefined);
    fetchMyAdminGroupEditReferenceMock.mockReset();
    fetchMyAdminGroupEditReferenceMock.mockResolvedValue({
      logins: [],
      organisms: [],
      areasOfResponsibility: [],
    });
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
      dutyAudioTranscriptionCollapsed: false,
      analysisAudioTranscriptionCollapsed: false,
      showAnalysisCallsignAddForm: false,
      showClassicDuty: false,
      showClassicAnalysis: false,
      dutyCollapseMediaPreviews: true,
      mediaSummaryEnabled: true,
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

    const switchButtons = Array.from(container.querySelectorAll('button')).filter(
      (button) => button.textContent === 'off',
    );
    const switchButton = switchButtons[switchButtons.length - 1];
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
      dutyAudioTranscriptionCollapsed: false,
      analysisAudioTranscriptionCollapsed: false,
      showAnalysisCallsignAddForm: false,
      showClassicDuty: false,
      showClassicAnalysis: false,
      dutyCollapseMediaPreviews: true,
      mediaSummaryEnabled: true,
    });
  });

  it('enables the inline callsign form for analysis', async () => {
    await act(async () => {
      root.render(<SettingsNeoPage section="analysis" />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const switchButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.parentElement?.textContent?.includes('Відображати форму додавання позивного'),
    );
    expect(switchButton).toBeTruthy();

    await act(async () => {
      switchButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(saveUserDutySettings).toHaveBeenLastCalledWith({
      tagsLayout: 'compact',
      disableAutoScroll: false,
      analysisMapInSidebar: false,
      dutyAudioTranscriptionCollapsed: false,
      analysisAudioTranscriptionCollapsed: false,
      showAnalysisCallsignAddForm: true,
      showClassicDuty: false,
      showClassicAnalysis: false,
      dutyCollapseMediaPreviews: true,
      mediaSummaryEnabled: true,
    });
  });

  it('saves separate duty and analysis transcription defaults', async () => {
    await act(async () => {
      root.render(<SettingsNeoPage section="duty" />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const dutyButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('change-duty-transcription'),
    );
    expect(dutyButton).toBeTruthy();

    await act(async () => {
      dutyButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(saveUserDutySettings).toHaveBeenLastCalledWith({
      tagsLayout: 'compact',
      disableAutoScroll: false,
      analysisMapInSidebar: false,
      dutyAudioTranscriptionCollapsed: true,
      analysisAudioTranscriptionCollapsed: false,
      showAnalysisCallsignAddForm: false,
      showClassicDuty: false,
      showClassicAnalysis: false,
      dutyCollapseMediaPreviews: true,
      mediaSummaryEnabled: true,
    });

    saveUserDutySettings.mockClear();
    await act(async () => {
      root.render(<SettingsNeoPage section="analysis" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const analysisSwitch = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'off',
    );
    expect(analysisSwitch).toBeTruthy();

    await act(async () => {
      analysisSwitch?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(saveUserDutySettings).toHaveBeenLastCalledWith({
      tagsLayout: 'compact',
      disableAutoScroll: false,
      analysisMapInSidebar: false,
      dutyAudioTranscriptionCollapsed: true,
      analysisAudioTranscriptionCollapsed: true,
      showAnalysisCallsignAddForm: false,
      showClassicDuty: false,
      showClassicAnalysis: false,
      dutyCollapseMediaPreviews: true,
      mediaSummaryEnabled: true,
    });
  });

  it('saves media summary preference from the ai settings tab', async () => {
    await act(async () => {
      root.render(<SettingsNeoPage section="ai" />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Штучний інтелект');
    expect(container.textContent).toContain('Стислий опис файлів у картках');

    const switchButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.parentElement?.textContent?.includes('Стислий опис файлів у картках'),
    );
    expect(switchButton).toBeTruthy();

    await act(async () => {
      switchButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(saveUserDutySettings).toHaveBeenLastCalledWith({
      tagsLayout: 'compact',
      disableAutoScroll: false,
      analysisMapInSidebar: false,
      dutyAudioTranscriptionCollapsed: false,
      analysisAudioTranscriptionCollapsed: false,
      showAnalysisCallsignAddForm: false,
      showClassicDuty: false,
      showClassicAnalysis: false,
      dutyCollapseMediaPreviews: true,
      mediaSummaryEnabled: false,
    });
  });

  it('hides transcription preferences when audio transcription is disabled', async () => {
    currentSystemSettingsMock.mockResolvedValueOnce({ enableAudioTranscription: false });

    await act(async () => {
      root.render(<SettingsNeoPage section="duty" />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain('change-duty-transcription');

    await act(async () => {
      root.render(<SettingsNeoPage section="analysis" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain('Транскрипція аудіо');
  });

  it('hides general settings and opens my groups for the legacy general section', async () => {
    await act(async () => {
      root.render(<SettingsNeoPage section="general" />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain('Загальні');
    expect(container.textContent).toContain('Мої групи');
  });

  it('renders the my reports tab as a redirect', async () => {
    await act(async () => {
      root.render(<SettingsNeoPage section="my-groups" />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Мої звіти');
    expect(container.textContent).not.toContain('BETA');
    expect(container.querySelector('[data-testid=OpenInNewIcon]')).not.toBeNull();
  });

  it('redirects the canonical my reports section to the dedicated page', async () => {
    await act(async () => {
      root.render(<SettingsNeoPage section="my-reports" />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(window.location.pathname).toBe('/my-reports');
    expect(container.textContent).not.toContain('reports-active');
  });

  it('accepts the my organism section and shows its tab', async () => {
    await act(async () => {
      root.render(<SettingsNeoPage section="my-organism" />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Мій організм');
    expect(container.textContent).toContain('my-organism-active');
  });

  it('always shows the my groups tab after an empty successful load', async () => {
    await act(async () => {
      root.render(<SettingsNeoPage section="duty" />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain('Загальні');
    expect(container.textContent).toContain('Мої групи');
    expect(container.textContent).toContain('change-layout');
  });

  it('shows the my groups tab when groups exist', async () => {
    listMyAdminGroupsMock.mockResolvedValueOnce({
      groups: [
        {
          masterKey: 'signal:group-1',
          name: 'Group 1',
          datasourceName: null,
          datasourceKind: 'signal',
          isGroupSecret: false,
          disableNetworkAssignment: false,
          allowedUsers: [],
          allowedOrganismIds: [],
          adminLogins: [{ loginId: 'admin-id', login: 'DeltaUser', deltaLogin: null }],
          areasOfResponsibility: null,
        },
      ],
    });

    await act(async () => {
      root.render(<SettingsNeoPage section="duty" />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain('Загальні');
    expect(container.textContent).toContain('Мої групи');
    expect(container.textContent).toContain('change-layout');
    expect(container.textContent).not.toContain('Group 1');
  });

  it('shows an empty state on the direct my groups section when there are no groups', async () => {
    await act(async () => {
      root.render(<SettingsNeoPage section="my-groups" />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Мої групи');
    expect(container.textContent).toContain('Груп не знайдено');
    expect(container.textContent).toContain('Тут з');
  });

  it('renders the groups table when groups exist', async () => {
    listMyAdminGroupsMock.mockResolvedValueOnce({
      groups: [
        {
          masterKey: 'signal:group-1',
          name: 'Group 1',
          datasourceName: 'Source 1',
          datasourceKind: 'signal',
          isGroupSecret: true,
          disableNetworkAssignment: false,
          allowedUsers: [
            { loginId: 'user-a-id', login: 'user-a', deltaLogin: 'DeltaUserA' },
            { loginId: 'user-b-id', login: 'user-b', deltaLogin: 'USER-B' },
          ],
          allowedOrganismIds: [],
          adminLogins: [{ loginId: 'admin-id', login: 'DeltaUser', deltaLogin: 'AdminDelta' }],
          areasOfResponsibility: [{ id: 1, name: 'AOR 1' }],
        },
      ],
    });

    await act(async () => {
      root.render(<SettingsNeoPage section="my-groups" />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Мої групи');
    expect(container.textContent).toContain('Group 1');
    expect(container.textContent).not.toContain('Джерело');
    expect(container.textContent).toContain('Адміни');
    expect(container.textContent).not.toContain('Source 1');
    expect(container.textContent).toContain('AOR 1');
    expect(container.textContent).toContain('Є приватною');
    expect(container.textContent).toContain('так');
    expect(container.textContent).not.toContain('Дії');
    expect(container.textContent).not.toContain('приватна');
    expect(container.textContent).toContain('DeltaUser (AdminDelta)');
    expect(container.textContent).toContain('user-a (DeltaUserA), user-b');
  });

  it('shows the my groups edit action behind the feature flag', async () => {
    fetchServerInfoMock.mockResolvedValueOnce({ version: '1.0.0', featureMyAdminGroupsEdit: true });
    listMyAdminGroupsMock.mockResolvedValue({
      groups: [
        {
          masterKey: 'signal:group-1',
          name: 'Group 1',
          datasourceName: null,
          datasourceKind: 'signal',
          isGroupSecret: true,
          disableNetworkAssignment: false,
          allowedUsers: [{ loginId: 'user-a-id', login: 'user-a', deltaLogin: null }],
          allowedOrganismIds: [],
          adminLogins: [{ loginId: 'admin-a-id', login: 'admin-a', deltaLogin: null }],
          areasOfResponsibility: [{ id: 1, name: 'AOR 1' }],
        },
      ],
    });
    fetchMyAdminGroupEditReferenceMock.mockResolvedValue({
      logins: [
        { loginId: 'admin-a-id', login: 'admin-a', deltaLogin: null },
        { loginId: 'user-a-id', login: 'user-a', deltaLogin: null },
      ],
      organisms: [],
      areasOfResponsibility: [{ id: 1, name: 'AOR 1' }],
    });

    await act(async () => {
      root.render(<SettingsNeoPage section="myGroups" />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Дії');

    const actionsButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.getAttribute('aria-label')?.includes('Дії'),
    );
    expect(actionsButton).toBeTruthy();

    await act(async () => {
      actionsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('Редагувати');

    const editButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Редагувати'),
    );
    await act(async () => {
      editButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Редагувати групу');
    expect(container.textContent).toContain('Прихована група');
    expect(container.textContent).not.toContain('Коротка нотатка');
    expect(container.textContent).not.toContain('Довга нотатка');
  });

  it('sends organism ids when saving my group edits', async () => {
    fetchServerInfoMock.mockResolvedValueOnce({ version: '1.0.0', featureMyAdminGroupsEdit: true });
    listMyAdminGroupsMock.mockResolvedValue({
      groups: [
        {
          masterKey: 'signal:group-1',
          name: 'Group 1',
          datasourceName: null,
          datasourceKind: 'signal',
          isGroupSecret: true,
          disableNetworkAssignment: false,
          allowedUsers: [],
          allowedOrganismIds: [7],
          adminLogins: [{ loginId: 'admin-a-id', login: 'admin-a', deltaLogin: null }],
          areasOfResponsibility: null,
        },
      ],
    });
    fetchMyAdminGroupEditReferenceMock.mockResolvedValue({
      logins: [{ loginId: 'admin-a-id', login: 'admin-a', deltaLogin: null }],
      organisms: [{ id: 7, name: 'Own Org' }],
      areasOfResponsibility: [],
    });

    await act(async () => {
      root.render(<SettingsNeoPage section="myGroups" />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const actionsButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.getAttribute('aria-label')?.includes('Дії'),
    );
    await act(async () => {
      actionsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const editButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Редагувати'),
    );
    await act(async () => {
      editButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      await Promise.resolve();
      await Promise.resolve();
    });

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Зберегти'),
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(updateMyAdminGroupMock).toHaveBeenCalledWith(
      expect.objectContaining({
        masterKey: 'signal:group-1',
        isSecret: true,
        userLogins: [],
        organismIds: [7],
        adminLogins: ['admin-a-id'],
      }),
    );
  });

  it('preserves hidden existing organism ids when selection changes', () => {
    expect(
      preserveUnknownOrganismIds(
        [{ id: 7, name: 'Own Org' }],
        [7, 8],
        [{ id: 7, name: 'Own Org' }],
      ),
    ).toEqual([8, 7]);
  });

  it('does not save my group edits without admins', async () => {
    fetchServerInfoMock.mockResolvedValueOnce({ version: '1.0.0', featureMyAdminGroupsEdit: true });
    listMyAdminGroupsMock.mockResolvedValue({
      groups: [
        {
          masterKey: 'signal:group-1',
          name: 'Group 1',
          datasourceName: null,
          datasourceKind: 'signal',
          isGroupSecret: false,
          disableNetworkAssignment: false,
          allowedUsers: [],
          allowedOrganismIds: [],
          adminLogins: [],
          areasOfResponsibility: null,
        },
      ],
    });
    fetchMyAdminGroupEditReferenceMock.mockResolvedValue({
      logins: [{ loginId: 'admin-a-id', login: 'admin-a', deltaLogin: null }],
      organisms: [],
      areasOfResponsibility: [],
    });

    await act(async () => {
      root.render(<SettingsNeoPage section="myGroups" />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const actionsButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.getAttribute('aria-label')?.includes('Дії'),
    );
    await act(async () => {
      actionsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const editButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Редагувати'),
    );
    await act(async () => {
      editButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      await Promise.resolve();
      await Promise.resolve();
    });

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Зберегти'),
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(updateMyAdminGroupMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      'Потрібно залишити щонайменше одного адміністратора групи',
    );
  });

  it('keeps required settings loaded when server info fails', async () => {
    fetchServerInfoMock.mockRejectedValueOnce(new Error('server down'));
    fetchCurrentUserMock.mockResolvedValueOnce({ sigintZoneId: 1, roles: ['Admin'] });

    await act(async () => {
      root.render(<SettingsNeoPage section="analysis" />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Аналіз');
    expect(container.textContent).toContain('Мапа');
  });
});
