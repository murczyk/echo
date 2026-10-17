/**
 * @vitest-environment happy-dom
 */
import { createRoot } from 'react-dom/client';
import { act, forwardRef, useImperativeHandle, useState } from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emptyQueryState } from '.././helpers';

const useRerAnalysisNeoPageMock = vi.hoisted(() => vi.fn());
const useMediaQueryMock = vi.hoisted(() => vi.fn(() => false));
const notifyMock = vi.hoisted(() => vi.fn());
const createMessageFabPropsHistory = vi.hoisted(() => [] as Array<{ onClick?: () => void }>);
const editorGuardMocks = vi.hoisted(() => ({ dirty: false }));
const messagesPanePropsHistory = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const debugRuntime = vi.hoisted(() => {
  let recording = false;
  let recordingId: string | null = null;
  const aliases = new Map<string, string>();
  return {
    record: vi.fn(),
    alias: vi.fn((scope: string, value: string | number) => {
      const key = `${scope}:${value}`;
      if (!aliases.has(key)) aliases.set(key, `{${scope}_${aliases.size + 1}}`);
      return aliases.get(key)!;
    }),
    isRecording: vi.fn(() => recording),
    subscribe: vi.fn(() => () => {}),
    snapshot: vi.fn(() => ({ state: recording ? 'recording' : 'idle', recordingId })),
    start() {
      recording = true;
      recordingId = 'recording-1';
    },
    reset() {
      recording = false;
      recordingId = null;
      aliases.clear();
      this.record.mockReset();
      this.alias.mockClear();
      this.isRecording.mockClear();
      this.subscribe.mockClear();
      this.snapshot.mockClear();
    },
  };
});
const manageMessageDrawerPropsHistory = vi.hoisted(
  () =>
    [] as Array<{
      open: boolean;
      onClose: () => void;
      onCreated?: (result: unknown) => Promise<void> | void;
      onSubmitEdit?: (id: number, message: unknown) => Promise<void> | void;
      onEditSuccess?: (result: unknown) => Promise<void> | void;
      onDeleteSuccess?: (messageId: number) => Promise<void> | void;
      editTarget?: unknown;
      editAsReport?: boolean;
      reportSource?: unknown;
      intentKey?: string;
      presentation?: string;
      interactionActive?: boolean;
      adaptiveEmbeddedForm?: boolean;
      fillEmbeddedSurface?: boolean;
      transparentEmbeddedSurface?: boolean;
      initialGroupMasterKey?: string | null;
      initialFocusTarget?: HTMLElement | null;
      initialGroupMasterKey?: string | null;
    }>,
);

vi.mock('@mui/material', () => ({
  Badge: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Box: forwardRef<HTMLDivElement, { children?: ReactNode } & Record<string, unknown>>(
    function BoxMock({ children, component = 'div', sx: _sx, ...props }, ref) {
      const Component = component as keyof HTMLElementTagNameMap;
      return (
        <Component {...props} ref={ref as never}>
          {children}
        </Component>
      );
    },
  ),
  ButtonBase: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Chip: ({ label }: { label?: ReactNode }) => <div>{label}</div>,
  CircularProgress: () => <div data-testid="circular-progress" />,
  ClickAwayListener: ({ children }: { children: ReactNode }) => children,
  Collapse: ({ children, in: open }: { children: ReactNode; in?: boolean }) =>
    open ? <div>{children}</div> : null,
  Drawer: ({
    anchor,
    open,
    children,
    slotProps,
  }: {
    anchor: 'left' | 'right';
    open: boolean;
    children: ReactNode;
    slotProps?: {
      paper?: {
        sx?: {
          width?: unknown;
        };
      };
    };
  }) =>
    open ? (
      <div
        data-testid={`analysis-drawer-${anchor}`}
        data-width={JSON.stringify(slotProps?.paper?.sx?.width)}
      >
        {children}
      </div>
    ) : null,
  FormControlLabel: ({ control, label }: { control: ReactNode; label: ReactNode }) => (
    <div>
      {control}
      {label}
    </div>
  ),
  IconButton: ({
    children,
    onClick,
    disabled,
    'aria-label': ariaLabel,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    'aria-label'?: string;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={ariaLabel}>
      {children}
    </button>
  ),
  ListItemIcon: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  ListItemText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Menu: ({ children, open }: { children: ReactNode; open?: boolean }) =>
    open ? <div role="menu">{children}</div> : null,
  MenuItem: ({
    children,
    disabled,
    onClick,
    role,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
    role?: string;
  }) => (
    <button type="button" disabled={disabled} onClick={onClick} role={role ?? 'menuitem'}>
      {children}
    </button>
  ),
  MenuList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Paper: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  Popper: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  Skeleton: ({ children }: { children?: ReactNode }) => <div>{children ?? 'skeleton'}</div>,
  Stack: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Switch: ({
    checked,
    onChange,
  }: {
    checked?: boolean;
    onChange?: (_event: Event, value: boolean) => void;
  }) => (
    <button type="button" onClick={() => onChange?.(new Event('change'), !checked)}>
      {checked ? 'on' : 'off'}
    </button>
  ),
  Tab: ({ label, value }: { label?: ReactNode; value?: string }) => (
    <button role="tab" data-value={value}>
      {label}
    </button>
  ),
  Tabs: ({ children, value }: { children: ReactNode; value?: string }) => (
    <div role="tablist" data-value={value}>
      {children}
    </div>
  ),
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  Typography: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  useMediaQuery: useMediaQueryMock,
}));

vi.mock('@mui/material/styles', () => ({
  useTheme: () => ({
    breakpoints: { down: (key: string) => key },
    palette: {
      mode: 'dark',
      action: { selected: '#2c2c2c' },
      background: { default: '#121212' },
      common: { black: '#000000', white: '#ffffff' },
      text: { primary: '#ffffff' },
    },
  }),
}));

vi.mock('@mui/material/Alert', () => ({
  default: ({
    children,
    onClose,
    role = 'alert',
  }: {
    children: ReactNode;
    onClose?: (event: React.SyntheticEvent) => void;
    role?: string;
  }) => (
    <div role={role}>
      {children}
      {onClose ? (
        <button type="button" aria-label="Закрити" onClick={(event) => onClose(event)} />
      ) : null}
    </div>
  ),
}));

vi.mock('../use-rer-analysis-neo-page', () => ({
  useRerAnalysisNeoPage: useRerAnalysisNeoPageMock,
}));

vi.mock('../../../../debug-recorder', () => ({
  recordDebugEvent: debugRuntime.record,
  aliasDebugIdentifier: debugRuntime.alias,
  isBrowserDebugRecording: debugRuntime.isRecording,
  subscribeBrowserDebugRecorder: debugRuntime.subscribe,
  getBrowserDebugRecorderSnapshot: debugRuntime.snapshot,
}));

vi.mock('../../../components/PageHeader', () => ({
  PageHeader: ({
    title,
    titleLeadingActions,
    titleActions,
    middle,
    actions,
  }: {
    title: ReactNode;
    titleLeadingActions?: ReactNode;
    titleActions?: ReactNode;
    middle?: ReactNode;
    actions?: ReactNode;
  }) => (
    <header>
      {titleLeadingActions}
      <div>{title}</div>
      {titleActions}
      {middle}
      {actions}
    </header>
  ),
}));

vi.mock('../../../components/PowerChip', () => ({
  PowerChip: ({ label }: { label: ReactNode }) => <div>{label}</div>,
}));

vi.mock('../../../components/SidePanelToggleButton', () => ({
  SidePanelToggleButton: ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button type="button" aria-label={label} onClick={onClick}>
      {label}
    </button>
  ),
}));

vi.mock('.././components/AnalysisFiltersPanel', () => ({
  AnalysisFiltersPanel: () => <div data-testid="filters-panel" />,
}));

vi.mock('.././components/AnalysisHeaderControls', () => ({
  AnalysisHeaderControls: () => <div data-testid="header-controls" />,
}));

vi.mock('.././components/AnalysisMapPane', () => ({
  ANALYSIS_NARROW_MAP_HEIGHT: 'clamp(480px, 70svh, 720px)',
  AnalysisMapPane: () => <div data-testid="map-pane" />,
}));

vi.mock('.././components/AnalysisMessagesPane', () => ({
  AnalysisMessagesPane: (props: {
    onOpenEditor?: (messageId: number, focusTarget?: HTMLElement) => void;
    onCreateReport?: (
      messageId: number,
      etalonDisplayModel: unknown,
      focusTarget: HTMLElement,
    ) => void;
    onEditReport?: (reportId: number, sourceMessageId: number) => void;
  }) => {
    messagesPanePropsHistory.push(props);
    return (
      <div data-testid="messages-pane">
        <button
          type="button"
          aria-label="analysis-edit-message"
          onClick={(event) => props.onOpenEditor?.(42, event.currentTarget)}
        />
        <button
          type="button"
          aria-label="analysis-create-report"
          onClick={(event) => props.onCreateReport?.(42, {}, event.currentTarget)}
        />
        <button
          type="button"
          aria-label="analysis-edit-report"
          onClick={() => props.onEditReport?.(91, 42)}
        />
      </div>
    );
  },
}));

vi.mock('.././components/AnalysisReportDialog', () => ({
  AnalysisReportDialog: () => <div data-testid="report-dialog" />,
}));

vi.mock('.././components/AnalysisSidebar', () => ({
  AnalysisSidebar: () => <div data-testid="sidebar" />,
}));

vi.mock('.././components/AnalysisSummaryTableCard', () => ({
  AnalysisSummaryTableCard: () => <div data-testid="summary-card" />,
}));

vi.mock('../../shared/manage-message/CreateMessageFab', () => ({
  CreateMessageFab: ({ onClick }: { onClick?: () => void }) => {
    createMessageFabPropsHistory.push({ onClick });
    return (
      <button type="button" aria-label="create-message-fab" onClick={onClick}>
        create message
      </button>
    );
  },
}));
vi.mock('../../../components/PowerSnackbar', () => ({
  usePowerSnackbar: () => ({ notify: notifyMock }),
}));

vi.mock('../../shared/manage-message/ManageMessageDrawer', () => ({
  ManageMessageDrawer: forwardRef(function ManageMessageDrawerMock(
    props: {
      open: boolean;
      onClose: () => void;
      onCreated?: (result: unknown) => Promise<void> | void;
      onSubmitEdit?: (id: number, message: unknown) => Promise<void> | void;
      onEditSuccess?: (result: unknown) => Promise<void> | void;
      onDeleteSuccess?: (messageId: number) => Promise<void> | void;
      editTarget?: unknown;
      editAsReport?: boolean;
      reportSource?: unknown;
      intentKey?: string;
      presentation?: string;
      interactionActive?: boolean;
      adaptiveEmbeddedForm?: boolean;
      fillEmbeddedSurface?: boolean;
      transparentEmbeddedSurface?: boolean;
    },
    ref,
  ) {
    const [pendingIntent, setPendingIntent] = useState<null | {
      key: string;
      commit: () => void;
    }>(null);
    useImperativeHandle(ref, () => ({
      requestIntentChange(change: {
        key: string;
        focusTarget?: HTMLElement | null;
        commit: () => void;
      }) {
        if (change.key === props.intentKey) return;
        if (editorGuardMocks.dirty) setPendingIntent(change);
        else change.commit();
      },
      closeWithoutConfirmation: props.onClose,
      focus: () => {},
    }));
    manageMessageDrawerPropsHistory.push(props);
    return props.open ? (
      <div data-testid="manage-message-drawer">
        {pendingIntent ? (
          <div role="alertdialog">
            <button type="button" onClick={() => setPendingIntent(null)}>
              Продовжити редагування
            </button>
            <button
              type="button"
              onClick={() => {
                editorGuardMocks.dirty = false;
                setPendingIntent(null);
                pendingIntent.commit();
              }}
            >
              Відхилити зміни
            </button>
          </div>
        ) : null}
      </div>
    ) : null;
  }),
}));

vi.mock('@mui/icons-material/BarChartOutlined', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/ChevronLeftOutlined', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/ChevronRightOutlined', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/Close', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/DescriptionOutlined', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/FirstPageOutlined', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/FilterAltOutlined', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/PeopleOutlineOutlined', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/MapOutlined', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/LastPageOutlined', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/MessageOutlined', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/PersonAddOutlined', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/TableRowsOutlined', () => ({ default: () => <span /> }));

import { RerAnalysisNeoPage } from '.././index';

function buildPage() {
  return {
    authUserName: null,
    aorEntries: [],
    canResetFilters: false,
    analysisMapInSidebar: false,
    showAnalysisCallsignAddForm: false,
    centerTab: 'messages',
    centerTabPending: false,
    copiedFeedbackId: null,
    currentUser: { roles: ['Rer'] },
    counts: null,
    countsLoading: true,
    directMessageError: null,
    error: null,
    editorMessage: null,
    editorEditAsReport: false,
    reportSource: null,
    editorSaveInFlight: false,
    editTargetLoadState: { status: 'idle' },
    filtersLoading: false,
    groupInfos: {},
    groupNavigation: {
      groups: [
        {
          kind: 'all',
          masterKey: null,
          name: 'Всі групи',
          unreadCount: 0,
          oldestUnreadMessageRef: null,
          latestCursor: null,
        },
      ],
      scope: { kind: 'all' },
      ready: true,
      loading: false,
      error: null,
      select: vi.fn(),
      refresh: vi.fn(),
      acknowledge: vi.fn(),
      selectedGroup: {
        kind: 'all',
        masterKey: null,
        name: 'Всі групи',
        unreadCount: 0,
        oldestUnreadMessageRef: null,
        latestCursor: null,
      },
      selectedCursor: null,
    },
    includeOnlyNewFreqs: false,
    inboxReq: null,
    isDirty: false,
    loadedSavedFilter: null,
    leftPanelOpen: true,
    callsignGraph: null,
    callsignGraphLoading: false,
    callsignGraphLoadVersion: 0,
    correlatedFreqs: [],
    correlatedFreqsLoaded: false,
    correlatedFreqsLoading: false,
    groupsActivity: null,
    groupsActivityLoadedFreq: null,
    groupsActivityLoadedPeriod: null,
    groupsActivityLoading: false,
    hasLoadedInitialMessages: true,
    groupScopeTransitionPending: false,
    mapAttrs: {
      daterange: '',
      daterangeLoading: '',
      messages: '',
      palitras: '',
      palitrasLoaded: '',
      palitrasLoadState: 'idle',
      points: '',
      selectedUnits: '',
    },
    messageActionLoading: false,
    messageComments: {},
    messages: [],
    messagesLoading: false,
    messagesOverallCount: null,
    messagesPaging: false,
    messagesTotalCount: null,
    messagesTotalLoading: true,
    networkDisplayMap: {},
    networks: [],
    newCallsigns: { notSeen24h: [], notSeen7days: [], notSeen30days: [] },
    newCallsignsLoading: false,
    noMoreToLoad: false,
    newestFirst: true,
    nolimitShown: false,
    pageIndex: 0,
    options: {
      tags: [],
      aors: [],
      groups: [],
      senders: [],
      freqs: [],
      newFreqs: [],
      callsigns: [],
      units: [],
      locations: [],
      posts: [],
      networks: [],
      metadataCcs: [],
      metadataSenders: [],
      metadataReceivers: [],
      metadataHashes: [],
    },
    profiles: {},
    queryState: emptyQueryState(),
    report: { open: false },
    reportDownloadInFlight: false,
    reportProgressExpanded: false,
    reportTaskRuns: [],
    rightPanelOpen: false,
    rightSidebarLoading: false,
    rightSidebarTab: null,
    saveInFlight: false,
    savedFilterName: '',
    savedFilters: [],
    summaryCallsignsInfo: {},
    summaryHasLoadedOnce: false,
    summaryLoading: false,
    summaryLoaded: false,
    summaryRows: [],
    tagsLayout: 'compact',
    hideBotTags: false,
    tagsMap: {},
    tagsOrder: [],
    topCallsigns: [],
    topFreqs: [],
    topLocations: [],
    topUnits: [],
    unitsMap: {},
    validationError: null,
    openEditor: vi.fn(),
    openReportCreator: vi.fn(),
    openReportEditor: vi.fn(),
    closeEditor: vi.fn(),
    saveEditor: vi.fn(),
    saveMessageUpdate: vi.fn(),
    onDeleteMessage: vi.fn(),
    onToggleMessageBookmark: vi.fn(),
    onToggleMessageImportant: vi.fn(),
    onToggleMessageTag: vi.fn(),
    onUpdateLocalMessage: vi.fn(),
    addFrequencyToFilter: vi.fn(),
    closeReport: vi.fn(),
    downloadGeojson: vi.fn(),
    downloadKmz: vi.fn(),
    downloadReport: vi.fn(),
    downloadSummaryXlsx: vi.fn(),
    loadAllMessages: vi.fn(),
    loadCallsignGraph: vi.fn(),
    loadCorrelatedFreqs: vi.fn(),
    loadFilterSection: vi.fn(),
    loadGroupsActivity: vi.fn(),
    loadMessagesForMap: vi.fn(),
    loadFirstPage: vi.fn(),
    loadLastPage: vi.fn(),
    loadNextPage: vi.fn(),
    loadMoreMessages: vi.fn(),
    loadPrevPage: vi.fn(),
    loadNewCallsigns: vi.fn(),
    openReport: vi.fn(),
    repeatReportTaskRun: vi.fn(),
    refreshMapDateRange: vi.fn(),
    reload: vi.fn(),
    renameSummaryUnit: vi.fn(),
    reload: vi.fn(),
    setCenterTab: vi.fn(),
    setNewestFirst: vi.fn(),
    setReportProgressExpanded: vi.fn(),
    setRightSidebarTab: vi.fn(),
    showFreqOnMap: vi.fn(),
    toggleLeftPanel: vi.fn(),
    openLeftPanel: vi.fn(),
    selectGroupScope: vi.fn(),
    acknowledgeGroupAtNewest: vi.fn(),
    toggleReportTaskRunLogs: vi.fn(),
    toggleRightPanel: vi.fn(),
    toggleUnitFromMap: vi.fn(),
    updateQueryState: vi.fn(),
    updateReport: vi.fn(),
    applySavedFilter: vi.fn(),
    deleteLoadedSavedFilter: vi.fn(),
    renameExistingSavedFilter: vi.fn(),
    resetFilters: vi.fn(),
    saveAsNew: vi.fn(),
    setIncludeOnlyNewFreqs: vi.fn(),
    setSavedFilterName: vi.fn(),
    updateExisting: vi.fn(),
  };
}
describe('RerAnalysisNeoPage', () => {
  const rendered: HTMLDivElement[] = [];

  beforeEach(() => {
    useRerAnalysisNeoPageMock.mockReset();
    useMediaQueryMock.mockReset();
    useMediaQueryMock.mockReturnValue(false);
    notifyMock.mockReset();
    useRerAnalysisNeoPageMock.mockReturnValue(buildPage());
    createMessageFabPropsHistory.splice(0);
    manageMessageDrawerPropsHistory.splice(0);
    messagesPanePropsHistory.splice(0);
    editorGuardMocks.dirty = false;
    debugRuntime.reset();
    vi.useFakeTimers();
  });

  it('records the current Analysis page state during a debug session', async () => {
    const page = buildPage();
    page.messages = [
      [771111, { text: 'ECHO_SECRET_SENTINEL' }],
      [772222, { text: 'ECHO_SECRET_SENTINEL' }],
    ] as never;
    page.pageIndex = 2;
    page.queryState = {
      ...emptyQueryState(),
      groupsSelected: ['ECHO_SECRET_SENTINEL'],
      search: 'ECHO_SECRET_SENTINEL',
    };
    useRerAnalysisNeoPageMock.mockReturnValue(page);
    debugRuntime.start();
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<RerAnalysisNeoPage />);
    });

    expect(debugRuntime.record).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'analysis.page.snapshot',
        source: 'analysis',
        details: expect.objectContaining({
          messageCount: 2,
          pageIndex: 2,
          activeFilterCount: 2,
          selectedFilterValueCount: 1,
          hasSearch: true,
        }),
      }),
    );
    const output = JSON.stringify(debugRuntime.record.mock.calls);
    expect(output).not.toContain('ECHO_SECRET_SENTINEL');
    expect(output).not.toContain('771111');
    expect(output).not.toContain('772222');
  });

  afterEach(async () => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    for (const container of rendered.splice(0)) {
      document.body.removeChild(container);
    }
    vi.restoreAllMocks();
  });

  it('shows only skeletons while initial messages load', async () => {
    const page = buildPage();
    page.hasLoadedInitialMessages = false;
    page.messagesLoading = true;
    useRerAnalysisNeoPageMock.mockReturnValue(page);
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<RerAnalysisNeoPage />);
    });

    expect(container.textContent).toContain('skeleton');
    expect(container.querySelector('[data-testid="circular-progress"]')).toBeNull();
    expect(container.querySelector('[data-testid="messages-pane"]')).toBeNull();
  });

  it('replaces stale group messages with skeletons while the selected group loads', async () => {
    const page = buildPage();
    page.messages = [[42, { text: 'Message from the previous group' }]] as never;
    page.groupScopeTransitionPending = true;
    useRerAnalysisNeoPageMock.mockReturnValue(page);
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<RerAnalysisNeoPage />);
    });

    expect(container.querySelector('[data-testid="messages-pane"]')).not.toBeNull();
    expect(messagesPanePropsHistory.at(-1)?.isLoading).toBe(true);
  });

  it('shows message skeletons during a refresh without replacing the mounted feed', async () => {
    const page = buildPage();
    page.messages = [[42, { text: 'Existing message' }]] as never;
    page.messagesLoading = true;
    useRerAnalysisNeoPageMock.mockReturnValue(page);
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<RerAnalysisNeoPage />);
    });

    const mountedPane = container.querySelector('[data-testid="messages-pane"]');
    expect(messagesPanePropsHistory.at(-1)?.isLoading).toBe(true);
    expect(mountedPane).not.toBeNull();

    page.messagesLoading = false;
    await act(async () => {
      root.render(<RerAnalysisNeoPage />);
    });
    expect(messagesPanePropsHistory.at(-1)?.isLoading).toBe(false);
    expect(container.querySelector('[data-testid="messages-pane"]')).toBe(mountedPane);
  });

  it('refreshes analysis after creating a message', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<RerAnalysisNeoPage />);
    });

    const page = useRerAnalysisNeoPageMock.mock.results[0]?.value;
    const createFab = container.querySelector<HTMLButtonElement>(
      'button[aria-label="create-message-fab"]',
    );
    expect(createFab).not.toBeNull();

    await act(async () => {
      createFab?.click();
    });

    expect(manageMessageDrawerPropsHistory.at(-1)?.open).toBe(true);
    expect(page.reload).not.toHaveBeenCalled();

    await act(async () => {
      manageMessageDrawerPropsHistory.at(-1)?.onClose();
    });

    expect(container.querySelector('[data-testid="manage-message-drawer"]')).toBeNull();
    expect(page.reload).not.toHaveBeenCalled();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="create-message-fab"]')?.click();
    });
    const createdDrawer = manageMessageDrawerPropsHistory.at(-1);
    expect(createdDrawer?.open).toBe(true);

    await act(async () => {
      createdDrawer?.onClose();
      await createdDrawer?.onCreated?.({ signal_message_id: 17 });
    });

    expect(container.querySelector('[data-testid="manage-message-drawer"]')).toBeNull();
    expect(page.reload).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
  });

  it('keeps the embedded create editor open while refreshing analysis after success', async () => {
    useMediaQueryMock.mockImplementation((query) => query === '(min-width:1024px)');
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);

    await act(async () => root.render(<RerAnalysisNeoPage />));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="create-message-fab"]')?.click();
    });

    const createdDrawer = manageMessageDrawerPropsHistory.at(-1);
    expect(createdDrawer?.presentation).toBe('embedded');

    await act(async () => {
      await createdDrawer?.onCreated?.({ signal_message_id: 17 });
    });

    expect(container.querySelector('[data-testid="manage-message-drawer"]')).not.toBeNull();
    expect(useRerAnalysisNeoPageMock.mock.results[0]?.value.reload).toHaveBeenCalledWith({
      preserveMessagePage: true,
    });
    expect(notifyMock).toHaveBeenCalledWith({
      message: 'Повідомлення успішно створено.',
      severity: 'success',
    });

    await act(async () => root.unmount());
  });

  it('animates the embedded editor track while preserving the analysis workspace', async () => {
    useMediaQueryMock.mockImplementation((query) => query === '(min-width:1024px)');
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);

    await act(async () => root.render(<RerAnalysisNeoPage />));
    const workspace = container.querySelector<HTMLElement>('[data-analysis-workspace]');
    expect(workspace?.style.gridTemplateColumns).toBe('0px minmax(0, 1fr) minmax(0, 0fr)');
    expect(workspace?.style.transition).toContain('grid-template-columns');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="create-message-fab"]')?.click();
    });

    expect(workspace?.style.gridTemplateColumns).toBe(
      '0px minmax(0, 1fr) clamp(640px, 48%, 800px)',
    );
    await act(async () => root.unmount());
  });

  it('removes spatial editor layout motion when the user prefers reduced motion', async () => {
    useMediaQueryMock.mockImplementation(
      (query) => query === '(min-width:1024px)' || query === '(prefers-reduced-motion: reduce)',
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);

    await act(async () => root.render(<RerAnalysisNeoPage />));

    expect(
      container.querySelector<HTMLElement>('[data-analysis-workspace]')?.style.transition,
    ).toBe('none');
    await act(async () => root.unmount());
  });

  it('saves the selected edit and refreshes the analysis result', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);
    const editorMessage = { id: 42, message: { messageUid: 'm-42' } as never };
    const page = buildPage();
    page.editorMessage = editorMessage;
    useRerAnalysisNeoPageMock.mockReturnValue(page);
    await act(async () => {
      root.render(<RerAnalysisNeoPage />);
    });

    const drawer = manageMessageDrawerPropsHistory.at(-1);
    expect(drawer?.open).toBe(true);
    expect(drawer?.editTarget).toBe(editorMessage);
    expect(messagesPanePropsHistory.at(-1)?.editorHighlightedMessageId).toBe(42);

    await act(async () => {
      await drawer?.onSubmitEdit?.(42, { messageUid: 'm-updated' });
    });

    expect(page.saveEditor).toHaveBeenCalledTimes(1);
    expect(page.saveEditor).toHaveBeenCalledWith({ messageUid: 'm-updated' });
    expect(page.reload).not.toHaveBeenCalled();
    await act(async () => {
      await drawer?.onEditSuccess?.({ signal_message_id: 42 });
    });
    expect(page.reload).toHaveBeenCalledTimes(1);
    await act(async () => {
      root.unmount();
    });
  });

  it('refreshes analysis after creating a report', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);
    const reportSource = { id: 42, message: { messageUid: 'm-42' } as never };
    const page = buildPage();
    page.reportSource = reportSource;
    useRerAnalysisNeoPageMock.mockReturnValue(page);

    await act(async () => {
      root.render(<RerAnalysisNeoPage />);
    });

    const drawer = manageMessageDrawerPropsHistory.at(-1);
    expect(drawer?.open).toBe(true);
    expect(drawer?.reportSource).toBe(reportSource);
    expect(messagesPanePropsHistory.at(-1)?.editorHighlightedMessageId).toBe(42);

    await act(async () => {
      await drawer?.onCreated?.({ signal_message_id: 91 });
    });

    expect(page.reload).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
  });

  it('routes standalone report edits through server refresh instead of local message save', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);
    const page = buildPage();
    page.editorMessage = {
      id: 91,
      message: {
        messageUid: 'report-91',
        parentMessages: [{ id: 42, isAccessible: true, isDeleted: false }],
      } as never,
    };
    page.editorEditAsReport = true;
    useRerAnalysisNeoPageMock.mockReturnValue(page);

    await act(async () => {
      root.render(<RerAnalysisNeoPage />);
    });

    const drawer = manageMessageDrawerPropsHistory.at(-1);
    expect(drawer?.editAsReport).toBe(true);
    expect(drawer?.onSubmitEdit).toBeUndefined();
    await act(async () => {
      await drawer?.onEditSuccess?.({ signal_message_id: 91 });
    });

    expect(page.saveEditor).not.toHaveBeenCalled();
    expect(page.reload).toHaveBeenCalledTimes(1);

    await act(async () => {
      await drawer?.onDeleteSuccess?.(91);
    });
    expect(page.reload).toHaveBeenCalledTimes(2);

    await act(async () => root.unmount());
  });

  it('routes a linked message with an accessible parent through regular message editing by default', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);
    const page = buildPage();
    page.editorMessage = {
      id: 91,
      message: {
        messageUid: 'linked-message-91',
        parentMessages: [{ id: 42, isAccessible: true, isDeleted: false }],
      } as never,
    };
    useRerAnalysisNeoPageMock.mockReturnValue(page);

    await act(async () => {
      root.render(<RerAnalysisNeoPage />);
    });

    const drawer = manageMessageDrawerPropsHistory.at(-1);
    expect(drawer?.editAsReport).toBe(false);
    expect(drawer?.onSubmitEdit).toBeTypeOf('function');
    await act(async () => {
      await drawer?.onSubmitEdit?.(91, { messageUid: 'linked-message-91-updated' });
    });

    expect(page.saveEditor).toHaveBeenCalledWith({
      messageUid: 'linked-message-91-updated',
    });
    expect(page.reload).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it('routes a forwarded report with an inaccessible parent through regular message editing', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);
    const page = buildPage();
    page.editorMessage = {
      id: 91,
      message: {
        messageUid: 'forwarded-report-91',
        parentMessages: [{ id: 42, isAccessible: false, isDeleted: false }],
      } as never,
    };
    useRerAnalysisNeoPageMock.mockReturnValue(page);

    await act(async () => {
      root.render(<RerAnalysisNeoPage />);
    });

    const drawer = manageMessageDrawerPropsHistory.at(-1);
    expect(drawer?.onSubmitEdit).toBeTypeOf('function');
    await act(async () => {
      await drawer?.onSubmitEdit?.(91, { messageUid: 'forwarded-report-91-updated' });
    });

    expect(page.saveEditor).toHaveBeenCalledWith({
      messageUid: 'forwarded-report-91-updated',
    });

    await act(async () => root.unmount());
  });

  it('reloads after an edit without an inline message without saving a stale local message', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);
    const editorMessage = { id: 43, message: { messageUid: 'm-43' } as never };
    const page = buildPage();
    page.editorMessage = editorMessage;
    useRerAnalysisNeoPageMock.mockReturnValue(page);

    await act(async () => {
      root.render(<RerAnalysisNeoPage />);
    });
    const drawer = manageMessageDrawerPropsHistory.at(-1);
    await act(async () => {
      await drawer?.onEditSuccess?.({ signal_message_id: 43 });
    });

    expect(page.saveEditor).not.toHaveBeenCalled();
    expect(page.reload).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it('preserves the current message page when the header refresh button is clicked', async () => {
    const page = buildPage();
    page.countsLoading = false;
    page.messagesTotalLoading = false;
    useRerAnalysisNeoPageMock.mockReturnValue(page);
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<RerAnalysisNeoPage />);
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Оновити"]')?.click();
    });

    expect(page.reload).toHaveBeenCalledWith({ preserveMessagePage: true });

    await act(async () => {
      root.unmount();
    });
  });

  it('opens generic create from Summary without changing the active center tab', async () => {
    const page = buildPage();
    page.centerTab = 'summary';
    useRerAnalysisNeoPageMock.mockReturnValue(page);
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);

    await act(async () => root.render(<RerAnalysisNeoPage />));
    const createButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="create-message-fab"]',
    );

    expect(createButton).not.toBeNull();
    await act(async () => createButton?.click());

    expect(page.setCenterTab).not.toHaveBeenCalled();
    expect(manageMessageDrawerPropsHistory.at(-1)).toMatchObject({
      open: true,
      intentKey: 'create-message:all',
    });
    root.unmount();
  });

  it('prefills create with the dedicated Analysis group', async () => {
    const page = buildPage();
    const group = {
      kind: 'group' as const,
      masterKey: 'group-b',
      name: 'Bravo',
      ignoreOperativny: false,
      unreadCount: 2,
      oldestUnreadMessageRef: 'message-b',
      lastActivityAt: 1,
      latestCursor: { createdAt: 1, messageId: 2 },
    };
    page.groupNavigation = {
      ...page.groupNavigation,
      groups: [page.groupNavigation.groups[0], group],
      scope: { kind: 'group', masterKey: 'group-b' },
      selectedGroup: group,
      selectedCursor: group.latestCursor,
    };
    useRerAnalysisNeoPageMock.mockReturnValue(page);
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);

    await act(async () => root.render(<RerAnalysisNeoPage />));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="create-message-fab"]')?.click();
    });

    expect(manageMessageDrawerPropsHistory.at(-1)).toMatchObject({
      intentKey: 'create-message:group-b',
      initialGroupMasterKey: 'group-b',
    });
    root.unmount();
  });

  it('does not load the hidden group facet for a dedicated group', async () => {
    const page = buildPage();
    const group = {
      kind: 'group' as const,
      masterKey: 'group-b',
      name: 'Bravo',
      ignoreOperativny: false,
      unreadCount: 2,
      oldestUnreadMessageRef: 'message-b',
      lastActivityAt: 1,
      latestCursor: { createdAt: 1, messageId: 2 },
    };
    page.groupNavigation = {
      ...page.groupNavigation,
      groups: [page.groupNavigation.groups[0], group],
      scope: { kind: 'group', masterKey: 'group-b' },
      selectedGroup: group,
      selectedCursor: group.latestCursor,
    };
    useRerAnalysisNeoPageMock.mockReturnValue(page);
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);

    await act(async () => root.render(<RerAnalysisNeoPage />));
    const filterButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Фільтри',
    );
    await act(async () => filterButton?.click());

    expect(page.loadFilterSection).toHaveBeenCalledWith('tags');
    expect(page.loadFilterSection).toHaveBeenCalledWith('senders');
    expect(page.loadFilterSection).not.toHaveBeenCalledWith('groups');
    root.unmount();
  });

  it('hides generic create while the map is visible', async () => {
    const page = buildPage();
    page.centerTab = 'map';
    useRerAnalysisNeoPageMock.mockReturnValue(page);
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);

    await act(async () => root.render(<RerAnalysisNeoPage />));

    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="create-message-fab"]'),
    ).toBeNull();
    root.unmount();
  });

  it('closes Analytics before opening the message editor', async () => {
    const page = buildPage();
    page.rightPanelOpen = true;
    page.toggleRightPanel.mockImplementation(() => {
      page.rightPanelOpen = !page.rightPanelOpen;
    });
    useRerAnalysisNeoPageMock.mockReturnValue(page);
    useMediaQueryMock.mockImplementation((query) => query === '(min-width:1024px)');
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);

    await act(async () => root.render(<RerAnalysisNeoPage />));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="create-message-fab"]')?.click();
    });

    expect(page.toggleRightPanel).toHaveBeenCalledOnce();
    expect(
      container.querySelector('[data-testid="analysis-right-dock"] [role="tablist"]'),
    ).toBeNull();
    expect(manageMessageDrawerPropsHistory.at(-1)?.open).toBe(true);
    root.unmount();
  });

  it('guards a dirty editor before replacing it with Analytics', async () => {
    const page = buildPage();
    page.editorMessage = { id: 42, message: { messageUid: 'm-42' } as never };
    page.closeEditor.mockImplementation(() => {
      page.editorMessage = null;
    });
    page.toggleRightPanel.mockImplementation(() => {
      page.rightPanelOpen = !page.rightPanelOpen;
    });
    useRerAnalysisNeoPageMock.mockReturnValue(page);
    useMediaQueryMock.mockImplementation((query) => query === '(min-width:1024px)');
    editorGuardMocks.dirty = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);

    await act(async () => root.render(<RerAnalysisNeoPage />));
    const openAnalytics = () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Розгорнути праву панель"]')?.click();
    await act(async () => openAnalytics());

    expect(page.toggleRightPanel).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();

    const continueEditing = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Продовжити редагування',
    );
    await act(async () => continueEditing?.click());
    expect(page.closeEditor).not.toHaveBeenCalled();

    await act(async () => openAnalytics());
    const discard = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Відхилити зміни',
    );
    await act(async () => discard?.click());

    expect(page.closeEditor).toHaveBeenCalledOnce();
    expect(page.toggleRightPanel).toHaveBeenCalledOnce();
    root.unmount();
  });

  it('selects Messages when opening message editing', async () => {
    const page = buildPage();
    page.centerTab = 'summary';
    page.openEditor.mockImplementation((messageId: number) => {
      page.editorMessage = { id: messageId, message: { messageUid: 'm-42' } as never };
    });
    useRerAnalysisNeoPageMock.mockReturnValue(page);
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);

    await act(async () => root.render(<RerAnalysisNeoPage />));
    const editButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="analysis-edit-message"]',
    );
    await act(async () => editButton?.click());
    await act(async () => root.render(<RerAnalysisNeoPage />));

    expect(page.setCenterTab).toHaveBeenCalledWith('messages');
    expect(page.openEditor).toHaveBeenCalledWith(42);
    expect(manageMessageDrawerPropsHistory.at(-1)?.initialFocusTarget).toBe(editButton);
    root.unmount();
  });

  it('highlights the source card while editing its related report', async () => {
    const page = buildPage();
    page.openReportEditor.mockImplementation((reportId: number) => {
      page.editTargetLoadState = { status: 'loading', reportId };
    });
    useRerAnalysisNeoPageMock.mockReturnValue(page);
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);

    await act(async () => root.render(<RerAnalysisNeoPage />));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="analysis-edit-report"]')?.click();
    });
    await act(async () => root.render(<RerAnalysisNeoPage />));

    expect(page.openReportEditor).toHaveBeenCalledWith(91);
    expect(messagesPanePropsHistory.at(-1)?.editorHighlightedMessageId).toBe(42);
    root.unmount();
  });

  it('returns the shared dock to Analytics after the editor closes', async () => {
    const page = buildPage();
    page.editorMessage = { id: 42, message: { messageUid: 'm-42' } as never };
    page.rightPanelOpen = true;
    useRerAnalysisNeoPageMock.mockReturnValue(page);
    useMediaQueryMock.mockImplementation((query) => query === '(min-width:1024px)');
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);

    await act(async () => root.render(<RerAnalysisNeoPage />));
    const drawer = manageMessageDrawerPropsHistory.at(-1);
    await act(async () => drawer?.onClose());
    page.editorMessage = null;
    await act(async () => root.render(<RerAnalysisNeoPage />));

    expect(page.closeEditor).toHaveBeenCalledOnce();
    expect(
      container.querySelector('[data-analysis-dock-panel="analytics"]')?.hasAttribute('hidden'),
    ).toBe(false);
    root.unmount();
  });

  it('keeps narrow filter and analytics drawers behind the modal editor', async () => {
    const page = buildPage();
    page.editorMessage = { id: 42, message: { messageUid: 'm-42' } as never };
    page.leftPanelOpen = true;
    page.rightPanelOpen = true;
    useRerAnalysisNeoPageMock.mockReturnValue(page);
    useMediaQueryMock.mockImplementation((query) => query === 'md' || query === 'lg');
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);

    await act(async () => root.render(<RerAnalysisNeoPage />));
    expect(manageMessageDrawerPropsHistory.at(-1)).toMatchObject({
      open: true,
      presentation: 'modal',
    });
    expect(container.querySelector('[data-testid="analysis-drawer-left"]')).toBeNull();
    expect(container.querySelector('[data-testid="analysis-drawer-right"]')).toBeNull();

    page.editorMessage = null;
    await act(async () => root.render(<RerAnalysisNeoPage />));
    expect(container.querySelector('[data-testid="analysis-drawer-left"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="analysis-drawer-right"]')).not.toBeNull();
    root.unmount();
  });

  it('defers a second editor intent until dirty discard is confirmed', async () => {
    const page = buildPage();
    useRerAnalysisNeoPageMock.mockReturnValue(page);
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);

    await act(async () => root.render(<RerAnalysisNeoPage />));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="create-message-fab"]')?.click();
    });
    editorGuardMocks.dirty = true;
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="analysis-edit-message"]')?.click();
    });
    expect(page.openEditor).not.toHaveBeenCalled();

    const discard = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Відхилити зміни',
    );
    await act(async () => discard?.click());
    expect(page.openEditor).toHaveBeenCalledWith(42);
    expect(page.setCenterTab).toHaveBeenCalledWith('messages');
    root.unmount();
  });

  it('replaces the create-message intent with create-report', async () => {
    const page = buildPage();
    page.openReportCreator.mockImplementation((messageId: number) => {
      page.reportSource = { id: messageId, message: {} } as never;
    });
    useRerAnalysisNeoPageMock.mockReturnValue(page);
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);

    await act(async () => root.render(<RerAnalysisNeoPage />));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="create-message-fab"]')?.click();
    });
    expect(manageMessageDrawerPropsHistory.at(-1)?.intentKey).toBe('create-message:all');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="analysis-create-report"]')?.click();
    });
    await act(async () => root.render(<RerAnalysisNeoPage />));

    expect(manageMessageDrawerPropsHistory.at(-1)?.intentKey).toBe('create-report:42');
    root.unmount();
  });

  it('closes and notifies when write permission is revoked', async () => {
    const page = buildPage();
    useRerAnalysisNeoPageMock.mockReturnValue(page);
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);

    await act(async () => root.render(<RerAnalysisNeoPage />));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="create-message-fab"]')?.click();
    });
    page.currentUser = { roles: [] };
    await act(async () => root.render(<RerAnalysisNeoPage />));

    expect(container.querySelector('[data-testid="manage-message-drawer"]')).toBeNull();
    expect(notifyMock).toHaveBeenCalledWith({
      severity: 'error',
      message: 'Доступ до створення та редагування повідомлень втрачено.',
    });
    root.unmount();
  });

  it('hides overlay filters while editing until the 1600px fit threshold', async () => {
    const page = buildPage();
    page.editorMessage = { id: 42, message: { messageUid: 'm-42' } as never };
    useRerAnalysisNeoPageMock.mockReturnValue(page);
    useMediaQueryMock.mockImplementation((query) => query === '(min-width:1024px)');
    let width = 1360;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          width,
          height: 800,
          x: 0,
          y: 0,
          top: 0,
          right: width,
          bottom: 800,
          left: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 });
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);

    await act(async () => root.render(<RerAnalysisNeoPage />));
    expect(container.querySelector('[data-testid="analysis-drawer-left"]')).toBeNull();

    root.unmount();
    width = 1600;
    const wideContainer = document.createElement('div');
    document.body.appendChild(wideContainer);
    rendered.push(wideContainer);
    const wideRoot = createRoot(wideContainer);
    await act(async () => wideRoot.render(<RerAnalysisNeoPage />));
    expect(wideContainer.querySelector('[data-testid="analysis-drawer-left"]')).toBeNull();
    wideRoot.unmount();
  });

  it('temporarily hides overlay filters without closing them', async () => {
    const page = buildPage();
    useRerAnalysisNeoPageMock.mockReturnValue(page);
    useMediaQueryMock.mockImplementation((query) => query === '(min-width:1024px)');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          width: 1280,
          height: 800,
          x: 0,
          y: 0,
          top: 0,
          right: 1280,
          bottom: 800,
          left: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);

    await act(async () => root.render(<RerAnalysisNeoPage />));
    expect(container.querySelector('[data-testid="analysis-drawer-left"]')).toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="create-message-fab"]')?.click();
    });

    expect(container.querySelector('[data-testid="analysis-drawer-left"]')).toBeNull();
    expect(page.toggleLeftPanel).not.toHaveBeenCalled();
    root.unmount();
  });
});
