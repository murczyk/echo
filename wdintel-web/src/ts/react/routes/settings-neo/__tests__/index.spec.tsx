/**
 * @vitest-environment happy-dom
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SigintZone } from '../../../../../Bindings';

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
  Box: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <div {...props}>{children}</div>
  ),
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Chip: ({ label }: { label?: ReactNode }) => <span>{label}</span>,
  CircularProgress: () => <span>loading</span>,
  Collapse: ({ children, in: inProp }: { children: ReactNode; in?: boolean }) =>
    inProp ? <div>{children}</div> : null,
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
  ToggleButtonGroup: ({
    value,
    onChange,
    children,
  }: {
    value?: unknown;
    onChange?: (_event: unknown, val: unknown) => void;
    children?: ReactNode;
  }) => (
    <div data-toggle-group={String(value)}>
      {React.Children.map(children, (child) => {
        if (!React.isValidElement(child)) return child;
        return React.cloneElement(child as any, {
          onClick: () => onChange?.(new Event('click'), child.props.value),
        });
      })}
    </div>
  ),
  ToggleButton: ({
    value,
    children,
    onClick,
  }: {
    value?: unknown;
    children?: ReactNode;
    onClick?: (event: unknown) => void;
  }) => (
    <button type="button" data-toggle-value={String(value)} onClick={onClick}>
      {children}
    </button>
  ),
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  Typography: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../../components/PageHeader', () => ({
  PageHeader: ({ title }: { title: string }) => <div>{title}</div>,
}));

vi.mock('../../../components/PowerButton', () => ({
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

vi.mock('../../../components/PowerIconButton', () => ({
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

vi.mock('../../../components/PowerMenu', () => ({
  PowerMenu: ({ children, open }: { children: ReactNode; open?: boolean }) =>
    open ? <div>{children}</div> : null,
}));

vi.mock('../../../components/PowerAlert', () => ({
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

vi.mock('../../../components/mui-customized/table/custom-styles', () => ({
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

vi.mock('../../../components/mui-customized/table/get-default-table-options', () => ({
  getDefaultMRTOptions: () => ({}),
  useAppMaterialReactTable: (options: Record<string, unknown>) => ({
    ...options,
    options,
    getState: () => ({ isFullScreen: false }),
  }),
  renderColumnActionsMenuItems: () => [],
}));

vi.mock('../../../components/mui-customized/table/table-state-provider', () => ({
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

vi.mock('../../../services/api/client', () => ({
  isUnauthorizedError: () => false,
}));

vi.mock('../../../services/api/server-info', () => ({
  fetchServerInfo: fetchServerInfoMock,
}));

vi.mock('../../../services/api/system-settings', () => ({
  currentSystemSettings: currentSystemSettingsMock,
}));

vi.mock('../../../services/api/user', () => ({
  fetchCurrentUser: fetchCurrentUserMock,
  saveUserSettings: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../services/api/user-settings', () => ({
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
    mediaSummaryEnabled: true,
    messageTextPreviewLines: 20,
    messageSortBy: 'interception',
  }),
  saveUserSettings: saveUserDutySettings,
}));

vi.mock('../../../services/api/zones', () => ({
  listSigintZones: vi.fn().mockResolvedValue([[1, { name: 'Zone 1' } as SigintZone]]),
  listMyAdminGroups: listMyAdminGroupsMock,
  updateMyAdminGroup: updateMyAdminGroupMock,
  fetchMyAdminGroupEditReference: fetchMyAdminGroupEditReferenceMock,
}));

vi.mock('../SettingsDutySection', async () => {
  const actual =
    await vi.importActual<typeof import('../SettingsDutySection')>('../SettingsDutySection');
  return {
    ...actual,
    SettingsDutySection: (props: any) => (
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
        <actual.SettingsDutySection {...props} />
      </div>
    ),
  };
});

vi.mock('../SettingsMyOrganismSection', () => ({
  SettingsMyOrganismSection: () => <div>my-organism-active</div>,
}));

import { SettingsNeoPage } from '../index';
import {
  isDutyFilterPersistenceDisabled,
  persistDutyFilterState,
  readPersistedDutyFilterState,
} from '../../rer-duty-neo/duty-filter-persistence';

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
    const storage = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });
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

  // @test-scope safeguard: prevents a transient failure from losing a queued preference update.
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
    const changeScroll = buttons.find((button) => button.textContent?.includes('change-scroll'));
    const changeTranscription = buttons.find((button) =>
      button.textContent?.includes('change-duty-transcription'),
    );
    expect(changeScroll).toBeTruthy();
    expect(changeTranscription).toBeTruthy();

    await act(async () => {
      changeScroll?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      changeTranscription?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(saveUserDutySettings).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstSave.reject(new Error('transient'));
      await Promise.resolve();
    });

    expect(saveUserDutySettings).toHaveBeenCalledTimes(2);
    expect(saveUserDutySettings.mock.calls[1]?.[0]).toEqual({
      tagsLayout: 'compact',
      disableAutoScroll: true,
      analysisMapInSidebar: false,
      dutyAudioTranscriptionCollapsed: true,
      analysisAudioTranscriptionCollapsed: false,
      showAnalysisCallsignAddForm: false,
      showClassicDuty: false,
      showClassicAnalysis: false,
      dutyCollapseMediaPreviews: true,
      mediaSummaryEnabled: true,
      messageTextPreviewLines: 20,
      messageSortBy: 'interception',
    });

    await act(async () => {
      secondSave.resolve();
      await Promise.resolve();
    });
  });

  // @test-scope safeguard: prevents a disabled browser persistence setting from retaining the current Duty filter.
  it('disables browser persistence and removes the current Duty filter', async () => {
    persistDutyFilterState({ messageFeeds: [['mf-0', { groupsSelected: ['group-a'] }]] });
    await act(async () => {
      root.render(<SettingsNeoPage section="duty" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const persistenceSwitch = Array.from(container.querySelectorAll('button')).find(
      (button) =>
        (button.textContent === 'on' || button.textContent === 'off') &&
        button.parentElement?.textContent?.includes('Не зберігати поточний фільтр'),
    );
    expect(persistenceSwitch).toBeTruthy();

    await act(async () => persistenceSwitch?.click());

    expect(isDutyFilterPersistenceDisabled()).toBe(true);
    expect(readPersistedDutyFilterState()).toBeNull();
    expect(saveUserDutySettings).not.toHaveBeenCalled();
  });

  // @test-scope safeguard: prevents saving a group edit from dropping its organism membership.
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

  // @test-scope safeguard: prevents saving a group without an administrator.
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
});
