/**
 * @vitest-environment happy-dom
 */
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emptyQueryState } from './helpers';

const useRerAnalysisNeoPageMock = vi.hoisted(() => vi.fn());

vi.mock('@mui/material', () => ({
  Badge: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Box: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Chip: ({ label }: { label?: ReactNode }) => <div>{label}</div>,
  CircularProgress: () => <div data-testid="circular-progress" />,
  FormControlLabel: ({ control, label }: { control: ReactNode; label: ReactNode }) => (
    <div>
      {control}
      {label}
    </div>
  ),
  IconButton: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Paper: ({ children }: { children: ReactNode }) => <section>{children}</section>,
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
  PowerAlert: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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

vi.mock('./use-min-duration-busy', () => ({
  useMinDurationBusy: (value: boolean) => value,
}));

vi.mock('@mui/icons-material/BarChartOutlined', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/ChevronLeftOutlined', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/ChevronRightOutlined', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/DescriptionOutlined', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/FilterAltOutlined', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/PeopleOutlineOutlined', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/MapOutlined', () => ({ default: () => <span /> }));
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
    messagesPaging: false,
    networkDisplayMap: {},
    networks: [],
    newCallsigns: { notSeen24h: [], notSeen7days: [], notSeen30days: [] },
    newCallsignsLoading: false,
    noMoreToLoad: false,
    newestFirst: true,
    nolimitShown: false,
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
    users: {},
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
    loadMoreMessages: vi.fn(),
    loadNewCallsigns: vi.fn(),
    openReport: vi.fn(),
    repeatReportTaskRun: vi.fn(),
    refreshMapDateRange: vi.fn(),
    renameSummaryUnit: vi.fn(),
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
    useRerAnalysisNeoPageMock.mockReturnValue(buildPage());
  });

  afterEach(async () => {
    for (const container of rendered.splice(0)) {
      document.body.removeChild(container);
    }
  });

  it('shows placeholder chips for totals while counts are loading', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    rendered.push(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<RerAnalysisNeoPage />);
    });

    expect(container.textContent).toContain('— з —');

    await act(async () => {
      root.unmount();
    });
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
});
