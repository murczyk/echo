/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { User } from '../../../../Bindings';
import type { AnalysisPageViewModel } from './types';
import { useRerAnalysisNeoPage } from './use-rer-analysis-neo-page';

const userSettingsMock = vi.hoisted(() => ({
  fetchUserSettings: vi.fn(),
}));

const useAnalysisDataMock = vi.hoisted(() => vi.fn());
const useAnalysisSavedFiltersMock = vi.hoisted(() => vi.fn());
const useAnalysisReportMock = vi.hoisted(() => vi.fn());
const useAnalysisMessageEditorMock = vi.hoisted(() => vi.fn());

vi.mock('@mui/material', () => ({
  useMediaQuery: () => false,
}));

vi.mock('@mui/material/styles', () => ({
  useTheme: () => ({ breakpoints: { down: () => '(max-width: 600px)' } }),
}));

vi.mock('../../services/api/client', () => ({
  isUnauthorizedError: () => false,
}));

vi.mock('../../services/api/user', () => ({
  fetchCurrentUser: vi.fn().mockResolvedValue({ name: 'tester' } as User),
}));

vi.mock('../../services/api/user-settings', () => ({
  USER_SETTINGS_UPDATED_EVENT: 'user-settings-updated',
  fetchUserSettings: userSettingsMock.fetchUserSettings,
  saveUserSettings: vi.fn(),
}));

vi.mock('./use-analysis-data', () => ({
  useAnalysisData: useAnalysisDataMock,
}));

vi.mock('./use-analysis-saved-filters', () => ({
  useAnalysisSavedFilters: useAnalysisSavedFiltersMock,
}));

vi.mock('./use-analysis-report', () => ({
  useAnalysisReport: useAnalysisReportMock,
}));

vi.mock('./use-analysis-message-editor', () => ({
  useAnalysisMessageEditor: useAnalysisMessageEditorMock,
}));

const baseAnalysisData = {
  aorEntries: [],
  callsignGraph: null,
  callsignGraphLoading: false,
  callsignGraphLoadVersion: 0,
  callsignGraphNolimit: false,
  correlatedFreqs: [],
  correlatedFreqsLoading: false,
  counts: null,
  countsLoading: false,
  filtersLoading: false,
  groupsActivityPeriod: 'selected',
  downloadGeojson: vi.fn(),
  downloadKmz: vi.fn(),
  downloadSummaryXlsx: vi.fn(),
  groupsActivity: null,
  groupsActivityLoadedFreq: null,
  groupsActivityLoadedPeriod: null,
  groupsActivityLoading: false,
  hasLoadedInitialMessages: true,
  inboxReq: null,
  loadCallsignGraph: vi.fn(),
  loadAllMessages: vi.fn(),
  loadFilterSection: vi.fn(),
  invalidateFilterSectionLoads: vi.fn(),
  toggleCallsignGraphNolimit: vi.fn(),
  loadCorrelatedFreqs: vi.fn(),
  loadGroupsActivity: vi.fn(),
  loadNewCallsigns: vi.fn(),
  loadMoreMessages: vi.fn(),
  loadMessagesForMap: vi.fn(),
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
  messagesLoading: false,
  messagesPaging: false,
  messageComments: {},
  messages: [],
  networkDisplayMap: {},
  networks: [],
  newCallsigns: { notSeen24h: [], notSeen7days: [], notSeen30days: [] },
  newCallsignsLoading: false,
  noMoreToLoad: false,
  nolimitShown: false,
  onUpdateLocalMessage: vi.fn(),
  onDeleteMessage: vi.fn(),
  onSaveMessageComment: vi.fn(),
  onToggleMessageBookmark: vi.fn(),
  onToggleMessageImportant: vi.fn(),
  onToggleMessageTag: vi.fn(),
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
  users: {},
  refreshMapDateRange: vi.fn(),
  reload: vi.fn(),
  summaryLoading: false,
  summaryLoaded: false,
  summaryHasLoadedOnce: false,
  rightSidebarLoading: false,
  summaryRows: [],
  summaryCallsignsInfo: {},
  unitsMap: {},
  tagsMap: {},
  topCallsigns: [],
  topFreqs: [],
  groupInfos: {},
  topLocations: [],
  topUnits: [],
  renameSummaryUnit: vi.fn(),
};

function buildAnalysisData() {
  return {
    ...baseAnalysisData,
    loadCallsignGraph: vi.fn(),
    loadAllMessages: vi.fn(),
    loadFilterSection: vi.fn(),
    invalidateFilterSectionLoads: vi.fn(),
    toggleCallsignGraphNolimit: vi.fn(),
    loadCorrelatedFreqs: vi.fn(),
    loadGroupsActivity: vi.fn(),
    loadNewCallsigns: vi.fn(),
    loadMoreMessages: vi.fn(),
    loadMessagesForMap: vi.fn(),
    downloadGeojson: vi.fn(),
    downloadKmz: vi.fn(),
    downloadSummaryXlsx: vi.fn(),
    refreshMapDateRange: vi.fn(),
    reload: vi.fn(),
    onUpdateLocalMessage: vi.fn(),
    onDeleteMessage: vi.fn(),
    onSaveMessageComment: vi.fn(),
    onToggleMessageBookmark: vi.fn(),
    onToggleMessageImportant: vi.fn(),
    onToggleMessageTag: vi.fn(),
    renameSummaryUnit: vi.fn(),
  };
}

function buildSavedFilters() {
  return {
    applySavedFilter: vi.fn(),
    deleteLoadedSavedFilter: vi.fn(),
    renameExisting: vi.fn(),
    saveAsNew: vi.fn(),
    isDirty: false,
    loadedSavedFilter: null,
    saveInFlight: false,
    savedFilterName: '',
    savedFilters: [],
    setSavedFilterName: vi.fn(),
    updateExisting: vi.fn(),
  };
}

function buildReport() {
  return {
    report: { open: false },
    reportDownloadInFlight: false,
    closeReport: vi.fn(),
    downloadReport: vi.fn(),
    openReport: vi.fn(),
    updateReport: vi.fn(),
  };
}

function buildEditor() {
  return {
    editorMessage: null,
    editorSaveInFlight: false,
    closeEditor: vi.fn(),
    openEditor: vi.fn(),
    saveEditor: vi.fn(),
    saveMessageUpdate: vi.fn(),
  };
}

function renderHook() {
  if (container == null) throw new Error('container not initialized');

  root = createRoot(container);
  const Harness = () => {
    latest = useRerAnalysisNeoPage(null);
    return null;
  };

  act(() => {
    root?.render(createElement(Harness));
  });
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: AnalysisPageViewModel | null = null;

describe('useRerAnalysisNeoPage', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    latest = null;

    userSettingsMock.fetchUserSettings.mockReset();
    userSettingsMock.fetchUserSettings.mockResolvedValue({
      tagsLayout: 'compact',
      disableAutoScroll: false,
      analysisMapInSidebar: false,
    });

    useAnalysisDataMock.mockReset();
    useAnalysisDataMock.mockImplementation(() => buildAnalysisData());
    useAnalysisSavedFiltersMock.mockReset();
    useAnalysisSavedFiltersMock.mockImplementation(() => buildSavedFilters());
    useAnalysisReportMock.mockReset();
    useAnalysisReportMock.mockImplementation(() => buildReport());
    useAnalysisMessageEditorMock.mockReset();
    useAnalysisMessageEditorMock.mockImplementation(() => buildEditor());
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container?.remove();
    container = null;
    latest = null;
  });

  it('opens the first available sidebar tab when the right panel is toggled while map stays in the center', async () => {
    renderHook();
    await flushEffects();

    await act(async () => {
      latest?.showFreqOnMap('123.4');
    });
    await flushEffects();

    expect(latest?.centerTab).toBe('map');
    expect(latest?.rightPanelOpen).toBe(false);

    await act(async () => {
      latest?.toggleRightPanel();
    });
    await flushEffects();

    expect(latest?.rightPanelOpen).toBe(true);
    expect(latest?.rightSidebarTab).toBe('stats');
  });

  it('moves the active map from the center into the sidebar when the setting turns on', async () => {
    renderHook();
    await flushEffects();

    await act(async () => {
      latest?.showFreqOnMap('123.4');
    });
    await flushEffects();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('user-settings-updated', {
        detail: {
          tagsLayout: 'compact',
          disableAutoScroll: false,
          analysisMapInSidebar: true,
        },
      }),
    );
    });
    await flushEffects();

    expect(latest?.rightPanelOpen).toBe(true);
    expect(latest?.rightSidebarTab).toBe('map');
    expect(latest?.centerTab).toBe('messages');
  });

  it('opens the sidebar map directly when the setting already places map in the sidebar', async () => {
    userSettingsMock.fetchUserSettings.mockResolvedValueOnce({
      tagsLayout: 'compact',
      disableAutoScroll: false,
      analysisMapInSidebar: true,
    });

    renderHook();
    await flushEffects();

    await act(async () => {
      latest?.showFreqOnMap('123.4');
    });
    await flushEffects();

    expect(latest?.rightPanelOpen).toBe(true);
    expect(latest?.rightSidebarTab).toBe('map');
    expect(latest?.centerTab).toBe('messages');
  });

  it('adds a frequency filter through the stats sidebar without dropping existing selections', async () => {
    renderHook();
    await flushEffects();

    await act(async () => {
      latest?.updateQueryState({ freqsSelected: ['111.1'] });
    });
    await flushEffects();

    await act(async () => {
      latest?.addFrequencyToFilter('123.4');
    });
    await flushEffects();

    expect(latest?.rightPanelOpen).toBe(true);
    expect(latest?.rightSidebarTab).toBe('stats');
    expect(latest?.queryState.freqsSelected).toEqual(['111.1', '123.4']);
    expect(latest?.queryState.includeOnlyNewFreqs).toBe(false);
  });

  it('clears the loaded saved filter when filters are reset', async () => {
    const savedFilters = buildSavedFilters();
    useAnalysisSavedFiltersMock.mockImplementation(() => savedFilters);

    renderHook();
    await flushEffects();

    await act(async () => {
      latest?.resetFilters();
    });
    await flushEffects();

    expect(savedFilters.applySavedFilter).toHaveBeenCalledWith(null);
  });

  it('does not duplicate a frequency already in the analysis filter', async () => {
    renderHook();
    await flushEffects();

    await act(async () => {
      latest?.updateQueryState({ freqsSelected: ['123.4'] });
    });
    await flushEffects();

    await act(async () => {
      latest?.addFrequencyToFilter('123.4');
    });
    await flushEffects();

    expect(latest?.queryState.freqsSelected).toEqual(['123.4']);
  });

  it('normalizes legacy undefined-unit selections before toggling the map unit filter off', async () => {
    renderHook();
    await flushEffects();

    await act(async () => {
      latest?.updateQueryState({ unitsSelected: ['Не визначено'] });
    });
    await flushEffects();

    await act(async () => {
      latest?.toggleUnitFromMap('');
    });
    await flushEffects();

    expect(latest?.queryState.unitsSelected).toEqual([]);
  });

  it('moves the active map away from the sidebar when the setting turns off', async () => {
    userSettingsMock.fetchUserSettings.mockResolvedValueOnce({
      tagsLayout: 'compact',
      disableAutoScroll: false,
      analysisMapInSidebar: true,
    });

    renderHook();
    await flushEffects();

    await act(async () => {
      latest?.showFreqOnMap('123.4');
    });
    await flushEffects();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('user-settings-updated', {
        detail: {
          tagsLayout: 'compact',
          disableAutoScroll: false,
          analysisMapInSidebar: false,
        },
      }),
    );
    });
    await flushEffects();

    expect(latest?.rightSidebarTab).toBe('stats');
    expect(latest?.rightPanelOpen).toBe(true);
  });
});
