/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage, InboxWindowRsp, SavedFilter, User } from '../../../../../Bindings';
import type { AnalysisPageViewModel } from '../types';
import { useRerAnalysisNeoPage } from '../use-rer-analysis-neo-page';

const userSettingsMock = vi.hoisted(() => ({
  fetchUserSettings: vi.fn(),
}));
const systemSettingsMock = vi.hoisted(() => ({
  currentSystemSettings: vi.fn(),
}));
const currentUserMock = vi.hoisted(() => ({ fetchCurrentUser: vi.fn() }));
const inboxMessagesMock = vi.hoisted(() => ({
  fetchInboxWindow: vi.fn(),
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

vi.mock('@mui/material', () => ({
  useMediaQuery: mediaQueryMock.useMediaQuery,
}));

vi.mock('@mui/material/styles', () => ({
  useTheme: () => ({ breakpoints: { down: (key: string) => `(down:${key})` } }),
}));

vi.mock('../../../services/api/client', () => ({
  isUnauthorizedError: () => false,
}));

vi.mock('../../../services/api/user', () => ({
  fetchCurrentUser: currentUserMock.fetchCurrentUser,
}));

vi.mock('../../../services/api/user-settings', () => ({
  USER_SETTINGS_UPDATED_EVENT: 'user-settings-updated',
  fetchUserSettings: userSettingsMock.fetchUserSettings,
  saveUserSettings: vi.fn(),
}));

vi.mock('../../../services/api/system-settings', () => ({
  currentSystemSettings: systemSettingsMock.currentSystemSettings,
}));

vi.mock('../../../services/api/inbox-messages', () => ({
  fetchInboxWindow: inboxMessagesMock.fetchInboxWindow,
}));

vi.mock('../use-analysis-data', () => ({
  useAnalysisData: useAnalysisDataMock,
}));

vi.mock('../use-analysis-saved-filters', () => ({
  useAnalysisSavedFilters: useAnalysisSavedFiltersMock,
}));

vi.mock('../use-analysis-report', () => ({
  useAnalysisReport: useAnalysisReportMock,
}));

vi.mock('../use-analysis-message-editor', () => ({
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
    editorEditAsReport: false,
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
      disableBotTags: false,
    });
    currentUserMock.fetchCurrentUser.mockReset();
    currentUserMock.fetchCurrentUser.mockResolvedValue({ name: 'tester' } as User);
    inboxMessagesMock.fetchInboxWindow.mockReset();
    inboxMessagesMock.fetchInboxWindow.mockResolvedValue(null);

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

  // @test-scope safeguard: prevents reopening the right panel without a usable tab when the map remains in the center pane.
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

  // @test-scope regression: https://github.com/echoua/echo/issues/3461
  it('ECHO-3461 strips unauthorized device filters before analysis data receives them', async () => {
    renderHook();
    await flushEffects();

    act(() => latest?.updateQueryState({ deviceNamesSelected: ['device-1'] }));
    await flushEffects();

    expect(useAnalysisDataMock.mock.calls.at(-1)?.[0].queryState.deviceNamesSelected).toEqual([]);
    expect(latest?.queryState.deviceNamesSelected).toEqual([]);
  });

  // @test-scope regression: https://github.com/echoua/echo/issues/3461
  it('ECHO-3461 preserves a device-filtered URL and defers loading while access is pending or fails', async () => {
    const settingsRequest =
      deferred<Awaited<ReturnType<typeof systemSettingsMock.currentSystemSettings>>>();
    systemSettingsMock.currentSystemSettings.mockReturnValueOnce(settingsRequest.promise);
    window.history.replaceState({}, '', `${window.location.pathname}?deviceNames=device-1`);
    renderHook();
    await flushEffects();

    expect(latest?.queryState.deviceNamesSelected).toEqual(['device-1']);
    expect(useAnalysisDataMock.mock.calls.at(-1)?.[0]).toMatchObject({
      queryState: { deviceNamesSelected: ['device-1'] },
      deferInitialLoad: true,
    });
    expect(window.location.search).toContain('device-1');

    await act(async () => {
      settingsRequest.reject(new Error('settings failed'));
      await Promise.resolve();
    });
    await flushEffects();
    expect(latest?.queryState.deviceNamesSelected).toEqual(['device-1']);
    expect(useAnalysisDataMock.mock.calls.at(-1)?.[0]).toMatchObject({
      queryState: { deviceNamesSelected: ['device-1'] },
      deferInitialLoad: true,
    });
    expect(latest?.error).not.toBeNull();
    expect(window.location.search).toContain('device-1');
  });

  // @test-scope regression: https://github.com/echoua/echo/issues/3461
  it('ECHO-3461 preserves device filters when the current-user lookup fails', async () => {
    currentUserMock.fetchCurrentUser.mockRejectedValueOnce(new Error('user failed'));
    window.history.replaceState({}, '', `${window.location.pathname}?deviceNames=device-1`);
    renderHook();
    await flushEffects();

    expect(latest?.queryState.deviceNamesSelected).toEqual(['device-1']);
    expect(useAnalysisDataMock.mock.calls.at(-1)?.[0]).toMatchObject({
      queryState: { deviceNamesSelected: ['device-1'] },
      deferInitialLoad: true,
    });
    expect(latest?.error).not.toBeNull();
    expect(window.location.search).toContain('device-1');
  });

  // @test-scope regression: https://github.com/echoua/echo/issues/3461
  it('ECHO-3461 sanitizes direct-link device filters after access denial', async () => {
    const userRequest = deferred<User>();
    currentUserMock.fetchCurrentUser.mockReturnValueOnce(userRequest.promise);
    window.history.replaceState(
      {},
      '',
      `${window.location.pathname}?m=target-uid&deviceNames=device-1`,
    );
    renderHook();
    await flushEffects();

    expect(inboxMessagesMock.fetchInboxWindow).not.toHaveBeenCalled();

    await act(async () => {
      userRequest.resolve({ name: 'tester', roles: [] } as User);
      await Promise.resolve();
    });
    await flushEffects();

    expect(inboxMessagesMock.fetchInboxWindow).toHaveBeenCalledTimes(1);
    expect(inboxMessagesMock.fetchInboxWindow.mock.calls[0]?.[0].inboxReq).toMatchObject({
      selectedDeviceNames: null,
    });
  });

  // @test-scope regression: https://github.com/echoua/echo/issues/3461
  it('ECHO-3461 defers a filtered query while the current-user lookup is pending', async () => {
    let resolveUser: (user: User) => void = () => {};
    currentUserMock.fetchCurrentUser.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveUser = resolve;
        }),
    );
    systemSettingsMock.currentSystemSettings.mockResolvedValueOnce({
      id: 7,
      rerAnalysisUnitsExactMatchOnlyDefault: false,
      rerDutyTestEnabled: false,
      rerDutyInsertHistoricalInterceptions: false,
      rerDutyTestSinceMs: 0,
      rerDutyTestLimit: 1,
      rerDutyPollIntervalSec: 1,
      rerShortUrlEnabled: false,
      enableAudioTranscription: true,
      devicesSectionEnabled: true,
    });
    window.history.replaceState({}, '', `${window.location.pathname}?deviceNames=device-1`);
    renderHook();
    await flushEffects();
    expect(latest?.queryState.deviceNamesSelected).toEqual(['device-1']);
    expect(useAnalysisDataMock.mock.calls.at(-1)?.[0]).toMatchObject({
      queryState: { deviceNamesSelected: ['device-1'] },
      deferInitialLoad: true,
    });
    expect(window.location.search).toContain('device-1');
    await act(async () => {
      resolveUser({ roles: ['Cyber'] } as User);
      await Promise.resolve();
    });
    await flushEffects();
    expect(useAnalysisDataMock.mock.calls.at(-1)?.[0]).toMatchObject({
      deferInitialLoad: false,
      queryState: { deviceNamesSelected: ['device-1'] },
    });
  });

  // @test-scope safeguard: prevents a narrow-layout panel close and reopen from losing the user's selected analysis tab.
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

  // @test-scope safeguard: prevents closing and reopening map-in-sidebar mode from discarding the user's selected map tab.
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

  // @test-scope safeguard: prevents a shared analysis URL from opening with panel visibility different from its encoded state.
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

  // @test-scope safeguard: prevents panel visibility changes from being omitted from the shareable analysis URL.
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

  // @test-scope safeguard: prevents enabling map-in-sidebar mode from leaving two active maps or losing the current map view.
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

  // @test-scope safeguard: prevents a persisted map-in-sidebar setting from opening analysis without an active map pane.
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

  // @test-scope safeguard: prevents refreshed frequency options from leaving an obsolete include-only-new selection in the active query.
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

  // @test-scope safeguard: prevents reset analysis criteria from remaining associated with a saved filter that no longer matches them.
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

  // @test-scope safeguard: prevents stale facet options from surviving when a saved filter replaces the active analysis query.
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

  // @test-scope safeguard: prevents reset from persisting an obsolete exact-match override into subsequent analysis requests.
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

  // @test-scope safeguard: prevents a legacy undefined-unit value from corrupting the unit filter when a map selection is removed.
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

  // @test-scope safeguard: prevents adding a map message's unit from omitting the header unit from the active analysis query.
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

  // @test-scope safeguard: prevents removing the last map-selected unit from leaving an exact-match constraint with no selected units.
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

  // @test-scope safeguard: prevents clearing the unit filter from leaving an exact-match constraint that changes later analysis requests.
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

  // @test-scope safeguard: prevents loading the system default from serializing it as a user override in the analysis query.
  it('keeps the exact-match query value unset after the system default loads', async () => {
    const originalUrl = window.location.href;
    window.history.replaceState({}, '', window.location.pathname);
    renderHook();
    await flushEffects();

    expect(latest?.queryState.unitsExactMatchOnly).toBeNull();
    expect(window.location.search).not.toContain('unitsExactMatchOnly');
    window.history.replaceState({}, '', originalUrl);
  });

  // @test-scope safeguard: prevents initialization from replacing an explicit exact-match value carried by a shared analysis URL.
  it('preserves an explicit exact-match setting from the parsed query state', async () => {
    const originalUrl = window.location.href;
    window.history.replaceState({}, '', `${window.location.pathname}?unitsExactMatchOnly=true`);
    renderHook();
    await flushEffects();

    expect(latest?.queryState.unitsExactMatchOnly).toBe(true);
    window.history.replaceState({}, '', originalUrl);
  });

  // @test-scope regression: https://github.com/echoua/echo/issues/3501
  it('ECHO-3501 exposes disabled bot tags from system settings', async () => {
    systemSettingsMock.currentSystemSettings.mockResolvedValueOnce({
      id: 7,
      rerAnalysisUnitsExactMatchOnlyDefault: false,
      rerDutyTestEnabled: false,
      rerDutyInsertHistoricalInterceptions: false,
      rerDutyTestSinceMs: 0,
      rerDutyTestLimit: 1,
      rerDutyPollIntervalSec: 1,
      rerShortUrlEnabled: false,
      disableBotTags: true,
    });

    renderHook();
    await flushEffects();

    expect(latest?.hideBotTags).toBe(true);
  });

  // @test-scope safeguard: prevents an unrelated list refresh from hiding a direct-link failure before the user can act on it.
  it('keeps the direct-link error when the regular message list clears its error', async () => {
    window.history.replaceState({}, '', `${window.location.pathname}?m=missing-uid`);

    renderHook();
    await flushEffects();

    expect(latest?.directMessageError).toBe(
      'Повідомлення за посиланням не знайдено або воно недоступне.',
    );
    expect(latest?.directMessageLoading).toBe(false);

    const clearRegularListError = useAnalysisDataMock.mock.calls.at(-1)?.[0].onError;
    await act(async () => {
      clearRegularListError('');
    });

    expect(latest?.directMessageError).toBe(
      'Повідомлення за посиланням не знайдено або воно недоступне.',
    );

    await act(async () => latest?.resetFilters());

    expect(latest?.directMessageError).toBe(
      'Повідомлення за посиланням не знайдено або воно недоступне.',
    );
    expect(new URL(window.location.href).searchParams.get('m')).toBe('missing-uid');
  });

  // @test-scope safeguard: prevents direct-link navigation from showing a target without the reference context needed to identify it.
  it('opens the direct-link message window with its references', async () => {
    const targetMessage = {
      text: 'target',
      freq: '123.45',
      sender: 'sender-1',
      bookmarked: false,
      important: false,
      extendedForm: null,
      callsigns: [],
      groupMasterKey: 'group-1',
      networkIds: [17],
      tags: [],
      date: '2026-08-20',
      timestamp: null,
    } as InboxMessage;
    window.history.replaceState(
      {},
      '',
      `${window.location.pathname}?m=target-uid&fromDateTime=2026-08-28T00%3A00&toDateTime=2099-08-29T00%3A00`,
    );
    const focusedWindow = {
      targetMessageId: 50,
      messagesBefore: 19,
      messagesAfter: 20,
      inbox: {
        inboxItems: [[50, targetMessage]],
        pollCursorId: null,
        callsigns: [],
        signalProfiles: { 'sender-1': { givenName: 'Іван', familyName: 'Петренко' } },
        signalGroups: [{ masterKey: 'group-1', name: 'Група Альфа' }],
        freqPelengsSummary: null,
        pageLimit: 20,
      },
      hasMoreBefore: true,
      hasMoreAfter: true,
    };
    inboxMessagesMock.fetchInboxWindow.mockResolvedValueOnce(focusedWindow);

    renderHook();
    await flushEffects();

    expect(useAnalysisDataMock.mock.calls.at(-1)?.[0]).toMatchObject({
      focusedWindow,
      focusedMessageActive: true,
    });
    expect(inboxMessagesMock.fetchInboxWindow).toHaveBeenCalledTimes(1);
    expect(inboxMessagesMock.fetchInboxWindow).toHaveBeenCalledWith(
      expect.objectContaining({ messageRef: 'target-uid' }),
    );
    expect(latest?.queryState).toMatchObject({
      fromDateTimeStr: '2026-08-19T00:00',
      toDateTimeStr: '2099-08-29T00:00',
    });
    expect(latest?.directMessageNavigation).not.toBeNull();
    expect(latest?.directMessageNavigation).toMatchObject({
      targetMessageIndex: 20,
      totalCount: 40,
    });
    expect(latest?.visibleMessagesPageIndex).toBe(1);
    expect(latest?.messagesTotalCount).toBe(40);
    expect(latest?.directMessageLoading).toBe(true);

    currentAnalysisData = {
      ...buildAnalysisData(),
      messages: [[50, targetMessage]],
      messagesLoading: true,
    };
    act(() => latest?.setNewestFirst(false));
    await flushEffects();
    expect(latest?.directMessageLoading).toBe(false);
    expect(latest?.messagesLoading).toBe(true);
    expect(latest?.directMessageNavigation?.contextLoading).toBe(true);

    act(() => latest?.directMessageNavigation?.onClearFocus());
    expect(new URL(window.location.href).searchParams.has('m')).toBe(false);
    expect(latest?.directMessageNavigation?.focusActive).toBe(false);
  });

  // https://github.com/echoua/echo/issues/3455
  // @test-scope safeguard: prevents direct-link context from using a different time basis than the saved analysis query and selecting the wrong message window.
  it('uses saved creation-time sorting for direct-link context', async () => {
    const targetMessage = { text: 'target', date: null, timestamp: null } as InboxMessage;
    const buildWindow = (neighborId: number): InboxWindowRsp => ({
      targetMessageId: 50,
      inbox: {
        inboxItems: [
          [neighborId, { text: `neighbor-${neighborId}` } as InboxMessage],
          [50, targetMessage],
        ],
        pollCursorId: null,
        callsigns: [],
        signalProfiles: {},
        signalGroups: [],
        freqPelengsSummary: null,
        pageLimit: 20,
      },
      hasMoreBefore: true,
      hasMoreAfter: true,
    });
    userSettingsMock.fetchUserSettings.mockResolvedValueOnce({ messageSortBy: 'creation' });
    inboxMessagesMock.fetchInboxWindow.mockResolvedValueOnce(buildWindow(49));
    window.history.replaceState({}, '', `${window.location.pathname}?m=target-uid`);

    renderHook();
    await flushEffects();

    expect(inboxMessagesMock.fetchInboxWindow.mock.calls[0]?.[0].inboxReq).toMatchObject({
      sortBy: 'IMSCreatedAt',
    });

    expect(useAnalysisDataMock.mock.calls.at(-1)?.[0]).toMatchObject({
      focusedWindow: buildWindow(49),
      focusedMessageActive: true,
    });
  });

  // https://github.com/echoua/echo/issues/3455
  // @test-scope safeguard: prevents context loaded for an obsolete time basis from replacing the current direct-link message window.
  it('rejects stale direct-link context after the time basis changes', async () => {
    const targetMessage = { text: 'target', date: null, timestamp: null } as InboxMessage;
    const buildWindow = (neighborId: number): InboxWindowRsp => ({
      targetMessageId: 50,
      inbox: {
        inboxItems: [
          [neighborId, { text: `neighbor-${neighborId}` } as InboxMessage],
          [50, targetMessage],
        ],
        pollCursorId: null,
        callsigns: [],
        signalProfiles: {},
        signalGroups: [],
        freqPelengsSummary: null,
        pageLimit: 20,
      },
      hasMoreBefore: true,
      hasMoreAfter: true,
    });
    let resolveInterception: ((value: InboxWindowRsp) => void) | undefined;
    inboxMessagesMock.fetchInboxWindow
      .mockImplementationOnce(
        () =>
          new Promise<InboxWindowRsp>((resolve) => {
            resolveInterception = resolve;
          }),
      )
      .mockResolvedValueOnce(buildWindow(49));
    window.history.replaceState({}, '', `${window.location.pathname}?m=target-uid`);

    renderHook();
    await flushEffects();
    expect(inboxMessagesMock.fetchInboxWindow.mock.calls[0]?.[0].inboxReq).toMatchObject({
      sortBy: null,
    });

    act(() => {
      window.dispatchEvent(
        new CustomEvent('user-settings-updated', { detail: { messageSortBy: 'creation' } }),
      );
    });
    await flushEffects();
    expect(inboxMessagesMock.fetchInboxWindow.mock.calls[1]?.[0].inboxReq).toMatchObject({
      sortBy: 'IMSCreatedAt',
    });

    resolveInterception?.(buildWindow(48));
    await flushEffects();

    expect(useAnalysisDataMock.mock.calls.at(-1)?.[0]).toMatchObject({
      focusedWindow: buildWindow(49),
      focusedMessageActive: true,
    });
  });

  // @test-scope safeguard: prevents previous/next direct-link navigation from displaying a chunk that does not contain the selected target.
  it('updates the visible chunk across previous and next direct-link navigation', async () => {
    const targetMessage = {
      text: 'target',
      date: null,
      timestamp: null,
    } as InboxMessage;
    const messages = Array.from(
      { length: 41 },
      (_, index) =>
        [
          index + 1,
          index === 20 ? targetMessage : ({ text: `message-${index + 1}` } as InboxMessage),
        ] as [number, InboxMessage],
    );
    window.history.replaceState({}, '', `${window.location.pathname}?m=target-uid`);
    inboxMessagesMock.fetchInboxWindow.mockResolvedValueOnce({
      targetMessageId: 21,
      messagesBefore: 39,
      messagesAfter: 20,
      inbox: {
        inboxItems: messages,
        pollCursorId: null,
        callsigns: [],
        signalProfiles: {},
        signalGroups: [],
        freqPelengsSummary: null,
        pageLimit: 20,
      },
      hasMoreBefore: true,
      hasMoreAfter: false,
    });
    currentAnalysisData = {
      ...buildAnalysisData(),
      messages,
    };

    renderHook();
    await flushEffects();

    expect(latest?.visibleMessagesPageIndex).toBe(1);
    await act(async () => latest?.loadPrevPage());

    expect(latest?.messagePageNavigationTarget).toBe(0);
    expect(latest?.visibleMessagesPageIndex).toBe(0);
    expect(latest?.directMessageNavigation?.focusActive).toBe(false);
    expect(new URL(window.location.href).searchParams.has('messagesPage')).toBe(false);

    act(() => latest?.clearMessagePageNavigationTarget());
    await act(async () => latest?.loadNextPage());

    expect(latest?.messagePageNavigationTarget).toBe(1);
    expect(latest?.visibleMessagesPageIndex).toBe(1);
    expect(new URL(window.location.href).searchParams.get('messagesPage')).toBe('2');
  });

  // @test-scope safeguard: prevents leaving a direct-link target focused after navigation advances to a different message chunk.
  it('navigates to the next direct-link chunk and clears target focus', async () => {
    const targetMessage = {
      text: 'target',
      date: null,
      timestamp: null,
    } as InboxMessage;
    const messages = Array.from(
      { length: 41 },
      (_, index) =>
        [
          index + 1,
          index === 20 ? targetMessage : ({ text: `message-${index + 1}` } as InboxMessage),
        ] as [number, InboxMessage],
    );
    window.history.replaceState({}, '', `${window.location.pathname}?m=target-uid`);
    inboxMessagesMock.fetchInboxWindow.mockResolvedValueOnce({
      targetMessageId: 21,
      messagesBefore: 39,
      messagesAfter: 20,
      inbox: {
        inboxItems: messages,
        pollCursorId: null,
        callsigns: [],
        signalProfiles: {},
        signalGroups: [],
        freqPelengsSummary: null,
        pageLimit: 20,
      },
      hasMoreBefore: true,
      hasMoreAfter: false,
    });
    currentAnalysisData = {
      ...buildAnalysisData(),
      messages,
    };

    renderHook();
    await flushEffects();

    expect(latest?.visibleMessagesPageIndex).toBe(1);
    await act(async () => latest?.loadNextPage());

    expect(latest?.messagePageNavigationTarget).toBe(2);
    expect(latest?.directMessageNavigation?.focusActive).toBe(false);
  });

  // @test-scope safeguard: prevents a filter change from silently moving focus away from a direct-link target that remains in the visible window.
  it('refilters the direct-link window while keeping the target focused', async () => {
    const targetMessage = { text: 'target', date: null, timestamp: null } as InboxMessage;
    const buildWindow = (neighborId: number, neighborText: string): InboxWindowRsp => ({
      targetMessageId: 50,
      inbox: {
        inboxItems: [
          [neighborId, { text: neighborText } as InboxMessage],
          [50, targetMessage],
        ],
        pollCursorId: null,
        callsigns: [],
        signalProfiles: {},
        signalGroups: [],
        freqPelengsSummary: null,
        pageLimit: 20,
      },
      hasMoreBefore: true,
      hasMoreAfter: true,
    });
    window.history.replaceState({}, '', `${window.location.pathname}?m=target-uid`);
    const initialWindow = buildWindow(49, 'initial');
    inboxMessagesMock.fetchInboxWindow.mockResolvedValueOnce(initialWindow);

    renderHook();
    await flushEffects();

    currentAnalysisData = {
      ...buildAnalysisData(),
      messages: initialWindow.inbox.inboxItems,
    };
    const groupWindow = buildWindow(48, 'same group');
    let resolveGroupWindow: ((value: InboxWindowRsp) => void) | undefined;
    inboxMessagesMock.fetchInboxWindow.mockImplementationOnce(
      () =>
        new Promise<InboxWindowRsp>((resolve) => {
          resolveGroupWindow = resolve;
        }),
    );
    act(() => latest?.updateQueryState({ groupsSelected: ['group-1'] }));
    await flushEffects();

    expect(useAnalysisDataMock.mock.calls.at(-1)?.[0]).toMatchObject({
      deferInitialLoad: true,
      focusedWindow: initialWindow,
      focusedMessageActive: true,
    });
    expect(latest?.directMessageLoading).toBe(true);
    expect(latest?.directMessageNavigation).toMatchObject({
      targetMessageId: 50,
      focusActive: true,
      contextLoading: true,
      loadingEarlier: true,
      loadingLater: true,
    });
    resolveGroupWindow?.(groupWindow);
    await flushEffects();

    expect(inboxMessagesMock.fetchInboxWindow.mock.calls.at(-1)?.[0].inboxReq).toMatchObject({
      selectedGroups: ['group-1'],
    });
    expect(useAnalysisDataMock.mock.calls.at(-1)?.[0]).toMatchObject({
      deferInitialLoad: false,
      focusedWindow: groupWindow,
      focusedMessageActive: true,
    });
    expect(latest?.directMessageLoading).toBe(true);

    currentAnalysisData = {
      ...buildAnalysisData(),
      messages: groupWindow.inbox.inboxItems,
    };
    act(() => latest?.setNewestFirst(false));
    await flushEffects();
    expect(latest?.directMessageNavigation?.contextLoading).toBe(false);
    expect(latest?.directMessageLoading).toBe(false);

    const frequencyWindow = buildWindow(47, 'same frequency');
    inboxMessagesMock.fetchInboxWindow.mockResolvedValueOnce(frequencyWindow);
    act(() => latest?.updateQueryState({ freqsSelected: ['123.45'] }));
    await flushEffects();

    expect(inboxMessagesMock.fetchInboxWindow.mock.calls.at(-1)?.[0].inboxReq).toMatchObject({
      selectedGroups: ['group-1'],
      selectedFreqs: ['123.45'],
    });

    const networkWindow = buildWindow(46, 'same network');
    inboxMessagesMock.fetchInboxWindow.mockResolvedValueOnce(networkWindow);
    act(() => latest?.updateQueryState({ networksSelected: ['7'] }));
    await flushEffects();

    expect(inboxMessagesMock.fetchInboxWindow.mock.calls.at(-1)?.[0].inboxReq).toMatchObject({
      selectedGroups: ['group-1'],
      selectedFreqs: ['123.45'],
      selectedNetworks: [7],
    });
    expect(useAnalysisDataMock.mock.calls.at(-1)?.[0]).toMatchObject({
      focusedWindow: networkWindow,
      focusedMessageActive: true,
    });
    expect(latest?.directMessageNavigation).toMatchObject({
      targetMessageId: 50,
      focusActive: true,
    });
  });

  // @test-scope safeguard: prevents a direct-link target excluded by the selected group from remaining visible as if it matched the active query.
  it('clears the direct-link message when it does not match a selected group', async () => {
    const targetMessage = { text: 'target', date: null, timestamp: null } as InboxMessage;
    const focusedWindow: InboxWindowRsp = {
      targetMessageId: 50,
      inbox: {
        inboxItems: [[50, targetMessage]],
        pollCursorId: null,
        callsigns: [],
        signalProfiles: {},
        signalGroups: [],
        freqPelengsSummary: null,
        pageLimit: 20,
      },
      hasMoreBefore: true,
      hasMoreAfter: true,
    };
    const focusedData = {
      ...buildAnalysisData(),
      messages: focusedWindow.inbox.inboxItems,
    };
    const filteredData = buildAnalysisData();
    let ordinaryData = {
      ...focusedData,
      messagesLoading: true,
    };
    useAnalysisDataMock.mockImplementation((options) =>
      options.focusedMessageActive ? focusedData : ordinaryData,
    );
    window.history.replaceState({}, '', `${window.location.pathname}?m=target-uid`);
    inboxMessagesMock.fetchInboxWindow.mockResolvedValueOnce(focusedWindow);

    renderHook();
    await flushEffects();

    let resolveMissingWindow: ((value: InboxWindowRsp | null) => void) | undefined;
    inboxMessagesMock.fetchInboxWindow.mockImplementationOnce(
      () =>
        new Promise<InboxWindowRsp | null>((resolve) => {
          resolveMissingWindow = resolve;
        }),
    );
    act(() => latest?.updateQueryState({ groupsSelected: ['other-group'] }));
    await flushEffects();

    expect(inboxMessagesMock.fetchInboxWindow.mock.calls.at(-1)?.[0].inboxReq).toMatchObject({
      selectedGroups: ['other-group'],
    });
    expect(latest?.directMessageLoading).toBe(true);

    resolveMissingWindow?.(null);
    await flushEffects();

    expect(new URL(window.location.href).searchParams.has('m')).toBe(false);
    expect(useAnalysisDataMock.mock.calls.at(-1)?.[0]).toMatchObject({
      focusedWindow: null,
      focusedMessageActive: false,
    });
    expect(latest?.directMessageNavigation).toBeNull();
    expect(latest?.messages).toEqual(focusedWindow.inbox.inboxItems);
    expect(latest?.directMessageLoading).toBe(true);

    ordinaryData = filteredData;
    act(() => latest?.setNewestFirst(false));
    await flushEffects();

    expect(latest?.messages).toEqual([]);
    expect(latest?.directMessageLoading).toBe(false);
    expect(latest?.error).toBeNull();
  });

  // @test-scope safeguard: prevents a direct-link context from surviving a date-range change that makes its message window stale.
  it('leaves direct-link context when the date range changes', async () => {
    const targetMessage = {
      text: 'target',
      freq: '',
      bookmarked: false,
      important: false,
      callsigns: [],
      networkIds: [],
      tags: [],
    } as InboxMessage;
    window.history.replaceState({}, '', `${window.location.pathname}?m=target-uid`);
    inboxMessagesMock.fetchInboxWindow.mockResolvedValueOnce({
      targetMessageId: 50,
      inbox: {
        inboxItems: [[50, targetMessage]],
        pollCursorId: null,
        callsigns: [],
        signalProfiles: {},
        signalGroups: [],
        freqPelengsSummary: null,
        pageLimit: 20,
      },
      hasMoreBefore: false,
      hasMoreAfter: false,
    });
    renderHook();
    await flushEffects();
    expect(latest?.directMessageNavigation).not.toBeNull();

    act(() => latest?.updateQueryState({ toDateTimeStr: '2026-05-03T00:00' }));
    await flushEffects();

    expect(latest?.directMessageNavigation).toBeNull();
    expect(useAnalysisDataMock.mock.calls.at(-1)?.[0].focusedMessageActive).toBe(false);
    expect(new URL(window.location.href).searchParams.has('m')).toBe(false);
  });

  // @test-scope safeguard: prevents disabling map-in-sidebar mode from leaving the active map stranded in a hidden sidebar.
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
