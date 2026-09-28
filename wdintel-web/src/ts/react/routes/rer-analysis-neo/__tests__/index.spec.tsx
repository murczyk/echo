/**
 * @vitest-environment happy-dom
 */
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emptyQueryState } from '.././helpers';

const useRerAnalysisNeoPageMock = vi.hoisted(() => vi.fn());
const useMediaQueryMock = vi.hoisted(() => vi.fn(() => false));
const notifyMock = vi.hoisted(() => vi.fn());
const createMessageFabPropsHistory = vi.hoisted(() => [] as Array<{ onClick?: () => void }>);
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
      reportSource?: unknown;
    }>,
);

vi.mock('@mui/material', () => ({
  Badge: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Box: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <div {...props}>{children}</div>
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
  Tab: ({ label }: { label?: ReactNode }) => <div>{label}</div>,
  Tabs: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  Typography: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  useMediaQuery: useMediaQueryMock,
}));

vi.mock('@mui/material/styles', () => ({
  useTheme: () => ({ breakpoints: { down: (key: string) => key } }),
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
  AnalysisMessagesPane: () => <div data-testid="messages-pane" />,
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
  ManageMessageDrawer: (props: {
    open: boolean;
    onClose: () => void;
    onCreated?: (result: unknown) => Promise<void> | void;
    onSubmitEdit?: (id: number, message: unknown) => Promise<void> | void;
    onEditSuccess?: (result: unknown) => Promise<void> | void;
    onDeleteSuccess?: (messageId: number) => Promise<void> | void;
    editTarget?: unknown;
    editAsReport?: boolean;
    reportSource?: unknown;
  }) => {
    manageMessageDrawerPropsHistory.push(props);
    return props.open ? <div data-testid="manage-message-drawer" /> : null;
  },
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
    currentUser: null,
    counts: null,
    countsLoading: true,
    directMessageError: null,
    error: null,
    editorMessage: null,
    editorEditAsReport: false,
    reportSource: null,
    editorSaveInFlight: false,
    filtersLoading: false,
    groupInfos: {},
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
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    for (const container of rendered.splice(0)) {
      document.body.removeChild(container);
    }
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

    expect(manageMessageDrawerPropsHistory.at(-1)?.open).toBe(false);
    expect(page.reload).not.toHaveBeenCalled();

    await act(async () => {
      createFab?.click();
    });
    const createdDrawer = manageMessageDrawerPropsHistory.at(-1);
    expect(createdDrawer?.open).toBe(true);

    await act(async () => {
      await createdDrawer?.onCreated?.({ signal_message_id: 17 });
    });

    expect(manageMessageDrawerPropsHistory.at(-1)?.open).toBe(false);
    expect(page.reload).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
  });

  it('saves the selected edit and refreshes the analysis result', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);
    const editorMessage = { id: 42, message: { messageUid: 'm-42' } as never };
    const page = buildPage();
    page.editorMessage = editorMessage;
    useRerAnalysisNeoPageMock.mockReturnValueOnce(page);
    await act(async () => {
      root.render(<RerAnalysisNeoPage />);
    });

    const drawer = manageMessageDrawerPropsHistory.at(-1);
    expect(drawer?.open).toBe(true);
    expect(drawer?.editTarget).toBe(editorMessage);

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
    useRerAnalysisNeoPageMock.mockReturnValueOnce(page);

    await act(async () => {
      root.render(<RerAnalysisNeoPage />);
    });

    const drawer = manageMessageDrawerPropsHistory.at(-1);
    expect(drawer?.open).toBe(true);
    expect(drawer?.reportSource).toBe(reportSource);

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
    useRerAnalysisNeoPageMock.mockReturnValueOnce(page);

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
    useRerAnalysisNeoPageMock.mockReturnValueOnce(page);

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
    useRerAnalysisNeoPageMock.mockReturnValueOnce(page);

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
    useRerAnalysisNeoPageMock.mockReturnValueOnce(page);

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
});
