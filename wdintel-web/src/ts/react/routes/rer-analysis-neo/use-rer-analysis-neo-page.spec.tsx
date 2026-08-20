/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SavedFilter, User } from '../../../../Bindings';
import type { AnalysisPageViewModel } from './types';
import { useRerAnalysisNeoPage } from './use-rer-analysis-neo-page';

const userSettingsMock = vi.hoisted(() => ({
  fetchUserSettings: vi.fn(),
}));
const systemSettingsMock = vi.hoisted(() => ({
  currentSystemSettings: vi.fn(),
}));

const useAnalysisDataMock = vi.hoisted(() => vi.fn());
const useAnalysisSavedFiltersMock = vi.hoisted(() => vi.fn());
const useAnalysisReportMock = vi.hoisted(() => vi.fn());
const useAnalysisMessageEditorMock = vi.hoisted(() => vi.fn());
const mediaQueryMock = vi.hoisted(() => ({
  useMediaQuery: vi.fn(),
}));

let analysisFreqValues = ['111.1'];
let currentAnalysisData: ReturnType<typeof buildAnalysisData> | null = null;

vi.mock('@mui/material', () => ({
  useMediaQuery: mediaQueryMock.useMediaQuery,
}));

vi.mock('@mui/material/styles', () => ({
  useTheme: () => ({ breakpoints: { down: (key: string) => `(down:${key})` } }),
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

vi.mock('../../services/api/system-settings', () => ({
  currentSystemSettings: systemSettingsMock.currentSystemSettings,
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
  callsignGraphLoadError: null,
  correlatedFreqs: [],
  correlatedFreqsLoaded: false,
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
  botTagAction: null,
  loadCallsignGraph: vi.fn(),
  loadAllMessages: vi.fn(),
  loadFilterSection: vi.fn(),
  invalidateFilterSectionLoads: vi.fn(),
  invalidateFilterSectionLoadsForPatch: vi.fn(),
  loadCorrelatedFreqs: vi.fn(),
  loadGroupsActivity: vi.fn(),
  loadNewCallsigns: vi.fn(),
  loadNextPage: vi.fn(),
  loadMoreMessages: vi.fn(),
  loadPrevPage: vi.fn(),
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
  messagesOverallCount: 0,
  messagesPaging: false,
  messagesTotalCount: 0,
  messagesTotalLoading: false,
  messageComments: {},
  messages: [],
  networkDisplayMap: {},
  networks: [],
  newCallsigns: { notSeen24h: [], notSeen7days: [], notSeen30days: [] },
  newCallsignsLoading: false,
  noMoreToLoad: false,
  nolimitShown: false,
  pageIndex: 0,
  onUpdateLocalMessage: vi.fn(),
  onDeleteMessage: vi.fn(),
  onCancelBotTagAction: vi.fn(),
  onMarkBotTagWrong: vi.fn(),
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
  tagsOrder: [],
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
    invalidateFilterSectionLoadsForPatch: vi.fn(),
    loadCorrelatedFreqs: vi.fn(),
    loadGroupsActivity: vi.fn(),
    loadNewCallsigns: vi.fn(),
    loadNextPage: vi.fn(),
    loadMoreMessages: vi.fn(),
    loadPrevPage: vi.fn(),
    loadMessagesForMap: vi.fn(),
    downloadGeojson: vi.fn(),
    downloadKmz: vi.fn(),
    downloadSummaryXlsx: vi.fn(),
    refreshMapDateRange: vi.fn(),
    reload: vi.fn(),
    onUpdateLocalMessage: vi.fn(),
    onDeleteMessage: vi.fn(),
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
    window.history.replaceState({}, '', window.location.pathname);
    container = document.createElement('div');
    document.body.appendChild(container);
    latest = null;

    mediaQueryMock.useMediaQuery.mockReset();
    mediaQueryMock.useMediaQuery.mockReturnValue(false);

    userSettingsMock.fetchUserSettings.mockReset();
    userSettingsMock.fetchUserSettings.mockResolvedValue({
      tagsLayout: 'compact',
      disableAutoScroll: false,
      analysisMapInSidebar: false,
    });
    systemSettingsMock.currentSystemSettings.mockReset();
    systemSettingsMock.currentSystemSettings.mockResolvedValue({
      id: 7,
      rerAnalysisUnitsExactMatchOnlyDefault: false,
      rerDutyTestEnabled: false,
      rerDutyInsertHistoricalInterceptions: false,
      rerDutyTestSinceMs: 0,
      rerDutyTestLimit: 1,
      rerDutyPollIntervalSec: 1,
      rerShortUrlEnabled: false,
      enableAudioTranscription: true,
    });

    useAnalysisDataMock.mockReset();
    analysisFreqValues = ['111.1'];
    currentAnalysisData = buildAnalysisData();
    useAnalysisDataMock.mockImplementation(() => {
      if (currentAnalysisData == null) throw new Error('analysis data not initialized');
      currentAnalysisData.options.freqs = analysisFreqValues.map((value) => ({
        value,
        label: value,
        count: 1,
      }));
      currentAnalysisData.options.newFreqs = analysisFreqValues.map((value) => ({
        value,
        label: value,
        count: 1,
      }));
      return currentAnalysisData;
    });
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
    currentAnalysisData = null;
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

  it('closes and reopens the narrow right panel without losing its selected tab', async () => {
    mediaQueryMock.useMediaQuery.mockReturnValue(true);
    renderHook();
    await flushEffects();

    expect(latest?.rightPanelOpen).toBe(false);
    expect(latest?.rightSidebarTab).toBeNull();

    await act(async () => latest?.toggleRightPanel());
    await flushEffects();
    expect(latest?.rightPanelOpen).toBe(true);
    expect(latest?.rightSidebarTab).toBe('stats');
    expect(currentAnalysisData?.loadFilterSection).toHaveBeenCalledWith('groups');

    await act(async () => latest?.setRightSidebarTab('callsigns'));
    await flushEffects();
    expect(currentAnalysisData?.loadFilterSection).toHaveBeenCalledWith('callsigns');
    await act(async () => latest?.toggleRightPanel());
    await flushEffects();

    expect(latest?.rightPanelOpen).toBe(false);
    expect(latest?.rightSidebarTab).toBe('callsigns');

    await act(async () => latest?.toggleRightPanel());
    await flushEffects();
    expect(latest?.rightPanelOpen).toBe(true);
    expect(latest?.rightSidebarTab).toBe('callsigns');
  });

  it('keeps the sidebar map selected while closing and reopening map-in-sidebar mode', async () => {
    mediaQueryMock.useMediaQuery.mockReturnValue(true);
    userSettingsMock.fetchUserSettings.mockResolvedValueOnce({
      tagsLayout: 'compact',
      disableAutoScroll: false,
      analysisMapInSidebar: true,
    });
    renderHook();
    await flushEffects();

    await act(async () => latest?.toggleRightPanel());
    await flushEffects();
    await act(async () => latest?.setRightSidebarTab('map'));
    await flushEffects();
    await act(async () => latest?.toggleRightPanel());
    await flushEffects();

    expect(latest?.rightPanelOpen).toBe(false);
    expect(latest?.rightSidebarTab).toBe('map');

    await act(async () => latest?.toggleRightPanel());
    await flushEffects();
    expect(latest?.rightPanelOpen).toBe(true);
    expect(latest?.rightSidebarTab).toBe('map');
  });

  it('folds the filters by default when they would stack above content', async () => {
    mediaQueryMock.useMediaQuery.mockImplementation((query: string) => query === '(down:lg)');

    renderHook();
    await flushEffects();

    expect(latest?.leftPanelOpen).toBe(false);

    await act(async () => {
      latest?.toggleLeftPanel();
    });
    await flushEffects();

    expect(latest?.leftPanelOpen).toBe(true);
  });

  it('restores panel visibility from query parameters', async () => {
    const originalUrl = window.location.href;
    window.history.replaceState(
      {},
      '',
      `${window.location.pathname}?leftPanelOpen=false&rightPanelOpen=true`,
    );

    renderHook();
    await flushEffects();

    expect(latest?.leftPanelOpen).toBe(false);
    expect(latest?.rightPanelOpen).toBe(true);
    expect(latest?.rightSidebarTab).toBe('stats');
    window.history.replaceState({}, '', originalUrl);
  });

  it('writes panel visibility to query parameters', async () => {
    const originalUrl = window.location.href;
    window.history.replaceState({}, '', window.location.pathname);

    renderHook();
    await flushEffects();

    expect(new URL(window.location.href).searchParams.get('leftPanelOpen')).toBe('true');
    expect(new URL(window.location.href).searchParams.get('rightPanelOpen')).toBe('false');

    await act(async () => {
      latest?.toggleLeftPanel();
      latest?.toggleRightPanel();
    });
    await flushEffects();

    expect(new URL(window.location.href).searchParams.get('leftPanelOpen')).toBe('false');
    expect(new URL(window.location.href).searchParams.get('rightPanelOpen')).toBe('true');
    window.history.replaceState({}, '', originalUrl);
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

  it('syncs include-only-new frequencies through targeted invalidation when the option list changes', async () => {
    renderHook();
    await flushEffects();

    await act(async () => {
      latest?.setIncludeOnlyNewFreqs(true);
    });
    await flushEffects();

    expect(currentAnalysisData?.invalidateFilterSectionLoadsForPatch).toHaveBeenCalledWith({
      includeOnlyNewFreqs: true,
      freqsSelected: ['111.1'],
    });

    currentAnalysisData?.invalidateFilterSectionLoadsForPatch.mockClear();
    analysisFreqValues = ['222.2'];

    await act(async () => {
      latest?.toggleLeftPanel();
    });
    await flushEffects();

    expect(currentAnalysisData?.invalidateFilterSectionLoadsForPatch).toHaveBeenCalledWith({
      freqsSelected: ['222.2'],
    });
    expect(latest?.queryState.freqsSelected).toEqual(['222.2']);
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

  it('marks the page resettable when only the media checkbox changes', async () => {
    renderHook();
    await flushEffects();

    expect(latest?.canResetFilters).toBe(false);

    await act(async () => {
      latest?.updateQueryState({ onlyWithMedia: true });
    });
    await flushEffects();

    expect(latest?.canResetFilters).toBe(true);
  });

  it('fully invalidates filter sections before applying a saved filter', async () => {
    const savedFilters = buildSavedFilters();
    useAnalysisSavedFiltersMock.mockImplementation(() => savedFilters);

    renderHook();
    await flushEffects();

    const analysisData = useAnalysisDataMock.mock.results[
      useAnalysisDataMock.mock.results.length - 1
    ]?.value as ReturnType<typeof buildAnalysisData>;
    const savedFilter = {
      id: 9,
      name: 'Saved filter',
      req: {
        sinceDateInclusiveMs: 1,
        tillDateNoninclusiveMs: 2,
      },
    } as SavedFilter;

    await act(async () => {
      latest?.applySavedFilter(savedFilter);
    });
    await flushEffects();

    expect(analysisData.invalidateFilterSectionLoads).toHaveBeenCalledTimes(1);
    expect(savedFilters.applySavedFilter).toHaveBeenCalledWith(savedFilter);
  });

  it('keeps the exact-match query value unset after reset', async () => {
    systemSettingsMock.currentSystemSettings.mockResolvedValueOnce({
      id: 7,
      rerAnalysisUnitsExactMatchOnlyDefault: true,
      rerDutyTestEnabled: false,
      rerDutyInsertHistoricalInterceptions: false,
      rerDutyTestSinceMs: 0,
      rerDutyTestLimit: 1,
      rerDutyPollIntervalSec: 1,
      rerShortUrlEnabled: false,
      enableAudioTranscription: true,
    });

    renderHook();
    await flushEffects();

    await act(async () => {
      latest?.resetFilters();
    });
    await flushEffects();

    expect(latest?.queryState.unitsExactMatchOnly).toBeNull();
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

  it('includes the message-header unit when adding it from the map', async () => {
    renderHook();
    await flushEffects();

    await act(async () => {
      latest?.updateQueryState({ unitsExactMatchOnly: true });
    });
    await flushEffects();

    currentAnalysisData?.invalidateFilterSectionLoadsForPatch.mockClear();
    await act(async () => {
      latest?.toggleUnitFromMap('Header Unit');
    });
    await flushEffects();

    expect(currentAnalysisData?.invalidateFilterSectionLoadsForPatch).toHaveBeenCalledWith({
      unitsExactMatchOnly: false,
      unitsSelected: [],
    });
    expect(latest?.queryState.unitsExactMatchOnly).toBe(false);
    expect(latest?.queryState.unitsSelected).toEqual(['Header Unit']);
  });

  it('resets the exact-match override after removing the last map unit', async () => {
    renderHook();
    await flushEffects();

    await act(async () => {
      latest?.updateQueryState({
        unitsExactMatchOnly: false,
        unitsSelected: ['Header Unit'],
      });
    });
    await flushEffects();

    await act(async () => {
      latest?.toggleUnitFromMap('Header Unit');
    });
    await flushEffects();

    expect(latest?.queryState.unitsExactMatchOnly).toBeNull();
    expect(latest?.queryState.unitsSelected).toEqual([]);
  });

  it('resets the exact-match override when clearing the regular unit filter', async () => {
    renderHook();
    await flushEffects();

    await act(async () => {
      latest?.updateQueryState({
        unitsExactMatchOnly: false,
        unitsSelected: ['Header Unit'],
      });
    });
    await flushEffects();

    currentAnalysisData?.invalidateFilterSectionLoadsForPatch.mockClear();
    await act(async () => {
      latest?.updateQueryState({ unitsSelected: [] });
    });
    await flushEffects();

    expect(currentAnalysisData?.invalidateFilterSectionLoadsForPatch).toHaveBeenCalledWith({
      unitsExactMatchOnly: null,
      unitsSelected: [],
    });
    expect(latest?.queryState.unitsExactMatchOnly).toBeNull();
    expect(latest?.queryState.unitsSelected).toEqual([]);
  });

  it('keeps the exact-match query value unset after the system default loads', async () => {
    const originalUrl = window.location.href;
    window.history.replaceState({}, '', window.location.pathname);
    renderHook();
    await flushEffects();

    expect(latest?.queryState.unitsExactMatchOnly).toBeNull();
    expect(window.location.search).not.toContain('unitsExactMatchOnly');
    window.history.replaceState({}, '', originalUrl);
  });

  it('preserves an explicit exact-match setting from the parsed query state', async () => {
    const originalUrl = window.location.href;
    window.history.replaceState({}, '', `${window.location.pathname}?unitsExactMatchOnly=true`);
    renderHook();
    await flushEffects();

    expect(latest?.queryState.unitsExactMatchOnly).toBe(true);
    window.history.replaceState({}, '', originalUrl);
  });

  it('shows an error when system settings fail to load', async () => {
    systemSettingsMock.currentSystemSettings.mockRejectedValueOnce(new Error('boom'));

    renderHook();
    await flushEffects();

    expect(latest?.error).toBe('Не вдалося завантажити системні налаштування.');
  });

  it('exposes the callsign graph load error in the page view model', async () => {
    currentAnalysisData = {
      ...buildAnalysisData(),
      callsignGraphLoadError: 'boom',
    };

    renderHook();
    await flushEffects();

    expect(latest?.callsignGraphLoadError).toBe('boom');
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
