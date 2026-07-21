/**
 * @vitest-environment happy-dom
 */
import { createRoot } from 'react-dom/client';
import { act, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emptyQueryState } from './helpers';

const useRerAnalysisNeoPageMock = vi.hoisted(() => vi.fn());
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
      editTarget?: unknown;
    }>,
);

vi.mock('@mui/material', () => ({
  Badge: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Box: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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
  MenuItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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
  useMediaQuery: () => false,
}));

vi.mock('@mui/material/styles', () => ({
  useTheme: () => ({ breakpoints: { down: () => '(max-width: 600px)' } }),
}));

vi.mock('./use-rer-analysis-neo-page', () => ({
  useRerAnalysisNeoPage: useRerAnalysisNeoPageMock,
}));

vi.mock('../../components/PageHeader', () => ({
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

vi.mock('../../components/PowerAlert', () => ({
  PowerAlert: ({
    children,
    autoHideDuration,
    ...props
  }: { children: ReactNode; autoHideDuration?: number } & Record<string, unknown>) => {
    const [visible, setVisible] = useState(true);

    useEffect(() => {
      if (autoHideDuration == null) return;
      const timeoutId = window.setTimeout(() => setVisible(false), autoHideDuration);
      return () => window.clearTimeout(timeoutId);
    }, [autoHideDuration]);

    return visible ? <div {...props}>{children}</div> : null;
  },
}));

vi.mock('../../components/PowerChip', () => ({
  PowerChip: ({ label }: { label: ReactNode }) => <div>{label}</div>,
}));

vi.mock('../../components/SidePanelToggleButton', () => ({
  SidePanelToggleButton: ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button type="button" aria-label={label} onClick={onClick}>
      {label}
    </button>
  ),
}));

vi.mock('./components/AnalysisFiltersPanel', () => ({
  AnalysisFiltersPanel: () => <div data-testid="filters-panel" />,
}));

vi.mock('./components/AnalysisHeaderControls', () => ({
  AnalysisHeaderControls: () => <div data-testid="header-controls" />,
}));

vi.mock('./components/AnalysisMapPane', () => ({
  AnalysisMapPane: () => <div data-testid="map-pane" />,
}));

vi.mock('./components/AnalysisMessagesPane', () => ({
  AnalysisMessagesPane: () => <div data-testid="messages-pane" />,
}));

vi.mock('./components/AnalysisReportDialog', () => ({
  AnalysisReportDialog: () => <div data-testid="report-dialog" />,
}));

vi.mock('./components/AnalysisSidebar', () => ({
  AnalysisSidebar: () => <div data-testid="sidebar" />,
}));

vi.mock('./components/AnalysisSummaryTableCard', () => ({
  AnalysisSummaryTableCard: () => <div data-testid="summary-card" />,
}));

vi.mock('../shared/manage-message/CreateMessageFab', () => ({
  CreateMessageFab: ({ onClick }: { onClick?: () => void }) => {
    createMessageFabPropsHistory.push({ onClick });
    return (
      <button type="button" aria-label="create-message-fab" onClick={onClick}>
        create message
      </button>
    );
  },
}));
vi.mock('../../components/PowerSnackbar', () => ({
  usePowerSnackbar: () => ({ notify: notifyMock }),
}));

vi.mock('../shared/manage-message/ManageMessageDrawer', () => ({
  ManageMessageDrawer: (props: {
    open: boolean;
    onClose: () => void;
    onCreated?: (result: unknown) => Promise<void> | void;
    onSubmitEdit?: (id: number, message: unknown) => Promise<void> | void;
    editTarget?: unknown;
  }) => {
    manageMessageDrawerPropsHistory.push(props);
    return props.open ? <div data-testid="manage-message-drawer" /> : null;
  },
}));

vi.mock('./use-min-duration-busy', () => ({
  useMinDurationBusy: (value: boolean) => value,
}));

vi.mock('@mui/icons-material/BarChartOutlined', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/ChevronLeftOutlined', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/ChevronRightOutlined', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/DescriptionOutlined', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/FirstPageOutlined', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/FilterAltOutlined', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/PeopleOutlineOutlined', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/MapOutlined', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/LastPageOutlined', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/MessageOutlined', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/PersonAddOutlined', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/TableRowsOutlined', () => ({ default: () => <span /> }));

import { RerAnalysisNeoPage } from './index';

function buildPage() {
  return {
    authUserName: null,
    aorEntries: [],
    canResetFilters: false,
    analysisMapInSidebar: false,
    centerTab: 'messages',
    centerTabPending: false,
    copiedFeedbackId: null,
    currentUser: null,
    counts: null,
    countsLoading: true,
    error: null,
    editorMessage: null,
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
    callsignGraphNolimit: false,
    correlatedFreqs: [],
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
    tagsMap: {},
    tagsOrder: [],
    topCallsigns: [],
    topFreqs: [],
    topLocations: [],
    topUnits: [],
    unitsMap: {},
    validationError: null,
    openEditor: vi.fn(),
    closeEditor: vi.fn(),
    saveEditor: vi.fn(),
    saveMessageUpdate: vi.fn(),
    onDeleteMessage: vi.fn(),
    onSaveMessageComment: vi.fn(),
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
    toggleCallsignGraphNolimit: vi.fn(),
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

  it('wires the header toggle buttons to the existing panel handlers', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<RerAnalysisNeoPage />);
    });

    const leftToggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Згорнути ліву панель"]',
    );
    const rightToggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Розгорнути праву панель"]',
    );

    expect(leftToggle).not.toBeNull();
    expect(rightToggle).not.toBeNull();

    await act(async () => {
      leftToggle?.click();
      rightToggle?.click();
    });

    const page = useRerAnalysisNeoPageMock.mock.results[0]?.value;
    expect(page.toggleLeftPanel).toHaveBeenCalledTimes(1);
    expect(page.toggleRightPanel).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
  });

  it('enqueues success Snackbar and reloads after creation', async () => {
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
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith({
      message: 'Повідомлення успішно створено.',
      severity: 'success',
    });

    await act(async () => {
      root.unmount();
    });
  });

  it('hides the create-message FAB on the map tab and restores it on other center tabs', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);
    const page = buildPage();
    page.analysisMapInSidebar = false;
    page.centerTab = 'map';
    useRerAnalysisNeoPageMock.mockReturnValue(page);

    await act(async () => {
      root.render(<RerAnalysisNeoPage />);
    });

    expect(container.querySelectorAll('button[aria-label="create-message-fab"]')).toHaveLength(0);

    page.analysisMapInSidebar = true;
    await act(async () => {
      root.render(<RerAnalysisNeoPage />);
    });

    expect(container.querySelectorAll('button[aria-label="create-message-fab"]')).toHaveLength(1);

    page.analysisMapInSidebar = false;
    page.centerTab = 'messages';
    await act(async () => {
      root.render(<RerAnalysisNeoPage />);
    });

    expect(container.querySelectorAll('button[aria-label="create-message-fab"]')).toHaveLength(1);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="create-message-fab"]')
        ?.click();
    });

    expect(manageMessageDrawerPropsHistory.at(-1)?.open).toBe(true);

    page.centerTab = 'map';
    await act(async () => {
      root.render(<RerAnalysisNeoPage />);
    });

    expect(container.querySelectorAll('button[aria-label="create-message-fab"]')).toHaveLength(0);
    expect(manageMessageDrawerPropsHistory.at(-1)?.open).toBe(true);

    page.centerTab = 'summary';
    await act(async () => {
      root.render(<RerAnalysisNeoPage />);
    });

    expect(container.querySelectorAll('button[aria-label="create-message-fab"]')).toHaveLength(1);

    await act(async () => {
      root.unmount();
    });
  });

  it('hides the create-message FAB when the visible sidebar tab is the map', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);
    const page = buildPage();
    page.analysisMapInSidebar = true;
    page.rightPanelOpen = true;
    page.rightSidebarTab = 'map';
    useRerAnalysisNeoPageMock.mockReturnValue(page);

    await act(async () => {
      root.render(<RerAnalysisNeoPage />);
    });

    expect(container.querySelectorAll('button[aria-label="create-message-fab"]')).toHaveLength(0);

    await act(async () => {
      root.unmount();
    });
  });

  it('shows the create-message FAB when the sidebar map switches to Stats', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);
    const page = buildPage();
    page.analysisMapInSidebar = true;
    page.rightPanelOpen = true;
    page.rightSidebarTab = 'map';
    useRerAnalysisNeoPageMock.mockReturnValue(page);

    await act(async () => {
      root.render(<RerAnalysisNeoPage />);
    });
    expect(container.querySelectorAll('button[aria-label="create-message-fab"]')).toHaveLength(0);

    page.rightSidebarTab = 'stats';
    await act(async () => {
      root.render(<RerAnalysisNeoPage />);
    });

    expect(container.querySelectorAll('button[aria-label="create-message-fab"]')).toHaveLength(1);

    await act(async () => {
      root.unmount();
    });
  });

  it('shows the create-message FAB when the desktop right panel closes on the sidebar map', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);
    const page = buildPage();
    page.analysisMapInSidebar = true;
    page.rightPanelOpen = true;
    page.rightSidebarTab = 'map';
    useRerAnalysisNeoPageMock.mockReturnValue(page);

    await act(async () => {
      root.render(<RerAnalysisNeoPage />);
    });
    expect(container.querySelectorAll('button[aria-label="create-message-fab"]')).toHaveLength(0);

    page.rightPanelOpen = false;
    await act(async () => {
      root.render(<RerAnalysisNeoPage />);
    });

    expect(container.querySelectorAll('button[aria-label="create-message-fab"]')).toHaveLength(1);

    await act(async () => {
      root.unmount();
    });
  });

  it('enqueues separate Snackbar notifications for repeated creations', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<RerAnalysisNeoPage />);
    });

    const create = async () => {
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('button[aria-label="create-message-fab"]')
          ?.click();
      });
      const drawer = manageMessageDrawerPropsHistory.at(-1);
      await act(async () => {
        await drawer?.onCreated?.({ signal_message_id: 17 });
      });
    };

    await create();
    await create();
    expect(notifyMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      root.unmount();
    });
  });

  it('does not enqueue a success Snackbar when creation is cancelled', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<RerAnalysisNeoPage />);
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="create-message-fab"]')
        ?.click();
    });
    await act(async () => {
      manageMessageDrawerPropsHistory.at(-1)?.onClose();
    });

    const page = useRerAnalysisNeoPageMock.mock.results[0]?.value;
    expect(notifyMock).not.toHaveBeenCalled();
    expect(page.reload).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it('opens edit mode from the current editor message and wires save and close callbacks', async () => {
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
    expect(container.querySelector('[role="status"]')).toBeNull();

    await act(async () => {
      drawer?.onClose();
    });

    expect(page.closeEditor).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
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
    expect(container.textContent).not.toContain('Повідомлення успішно створено.');

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
