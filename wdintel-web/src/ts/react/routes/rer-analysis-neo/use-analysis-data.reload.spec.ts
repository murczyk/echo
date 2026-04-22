import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AnalysisFilterSectionId } from './types';
import { emptyQueryState } from './helpers';
import { buildAnalysisReqForFilterSection, filterSectionsForInitialLoad, reloadAnalysisData } from './use-analysis-data.reload';
import { buildSummaryCallsignsInfo } from './use-analysis-data.callsigns';
import { emptyNewCallsigns, emptyOptions } from './use-analysis-data.shared';

const mocks = vi.hoisted(() => ({
  fetchAnalysisAors: vi.fn(),
  fetchAnalysisCallsigns: vi.fn(),
  fetchAnalysisCallsignInfos: vi.fn(),
  fetchAnalysisCount: vi.fn(),
  fetchAnalysisFreqs: vi.fn(),
  fetchAnalysisGroups: vi.fn(),
  fetchAnalysisLocations: vi.fn(),
  fetchAnalysisMapPoints: vi.fn(),
  fetchAnalysisMetadata: vi.fn(),
  fetchAnalysisNetworks: vi.fn(),
  fetchAnalysisNewCallsigns: vi.fn(),
  fetchAnalysisPosts: vi.fn(),
  fetchAnalysisSenders: vi.fn(),
  fetchAnalysisSummaryTable: vi.fn(),
  fetchAnalysisTags: vi.fn(),
  fetchAnalysisUnits: vi.fn(),
  fetchInboxMessages: vi.fn(),
  fetchNetworksByIds: vi.fn(),
  getLatestSenders: vi.fn(),
  getTagsMapForDisplay: vi.fn(),
  getUnitsList: vi.fn(),
}));

vi.mock('../../services/api/analysis', () => ({
  fetchAnalysisAors: mocks.fetchAnalysisAors,
  fetchAnalysisCallsigns: mocks.fetchAnalysisCallsigns,
  fetchAnalysisCallsignInfos: mocks.fetchAnalysisCallsignInfos,
  fetchAnalysisCount: mocks.fetchAnalysisCount,
  fetchAnalysisFreqs: mocks.fetchAnalysisFreqs,
  fetchAnalysisGroups: mocks.fetchAnalysisGroups,
  fetchAnalysisLocations: mocks.fetchAnalysisLocations,
  fetchAnalysisMapPoints: mocks.fetchAnalysisMapPoints,
  fetchAnalysisMetadata: mocks.fetchAnalysisMetadata,
  fetchAnalysisNetworks: mocks.fetchAnalysisNetworks,
  fetchAnalysisNewCallsigns: mocks.fetchAnalysisNewCallsigns,
  fetchAnalysisPosts: mocks.fetchAnalysisPosts,
  fetchAnalysisSenders: mocks.fetchAnalysisSenders,
  fetchAnalysisSummaryTable: mocks.fetchAnalysisSummaryTable,
  fetchAnalysisTags: mocks.fetchAnalysisTags,
  fetchAnalysisUnits: mocks.fetchAnalysisUnits,
  fetchInboxMessages: mocks.fetchInboxMessages,
  fetchNetworksByIds: mocks.fetchNetworksByIds,
  getLatestSenders: mocks.getLatestSenders,
  getTagsMapForDisplay: mocks.getTagsMapForDisplay,
}));

vi.mock('../../services/api/units', () => ({
  getUnitsList: mocks.getUnitsList,
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.clearAllMocks();
});

beforeEach(() => {
  mocks.fetchAnalysisNetworks.mockResolvedValue({ networks: [], networkNames: [] });
  mocks.fetchAnalysisCallsigns.mockResolvedValue({ callsigns: [] });
  mocks.fetchAnalysisCallsignInfos.mockResolvedValue([]);
  mocks.fetchAnalysisUnits.mockResolvedValue({ units: [] });
  mocks.fetchAnalysisLocations.mockResolvedValue({ locations: [] });
});

function buildBaseReq() {
  return {
    ...emptyQueryState(),
    sinceDateInclusiveMs: 1,
    tillDateNoninclusiveMs: 2,
    selectedGroups: ['g1'],
    selectedSenders: ['s1'],
    selectedFreqs: ['f1'],
    selectedPosts: ['p1'],
    selectedCallsigns: ['c1'],
    selectedUnits: ['u1'],
    selectedLocations: ['l1'],
    selectedAors: [7],
    orWithExtendedForm: false,
    orBookmarked: false,
    orImportant: false,
    orWithCoords: false,
    orWithoutCoords: false,
    search: null,
    selectedTags: [11],
    selectedNetworks: [22],
    withoutNetwork: false,
    metadataCc: ['cc'],
    metadataSender: ['sender'],
    metadataReceiver: ['receiver'],
    metadataHash: ['hash'],
    onlyWithMetadata: false,
    withoutMetadata: false,
    includePelengLocations: true,
    unitsExactMatchOnly: null,
    filterTagsOption: 'OneOfTags' as const,
    withoutModelTags: false,
    reportTagsOnlyThisUnit: false,
  };
}

function buildQueryState() {
  return {
    ...emptyQueryState(),
    fromDateTimeStr: '2026-03-30T08:00',
    toDateTimeStr: '2026-03-31T08:00',
    groupsSelected: ['Alpha'],
    search: 'signal',
  };
}

describe('buildAnalysisReqForFilterSection', () => {
  it('removes the section own selection so the option list stays multi-selectable', () => {
    const cases: Array<[AnalysisFilterSectionId, string]> = [
      ['tags', 'selectedTags'],
      ['aors', 'selectedAors'],
      ['groups', 'selectedGroups'],
      ['senders', 'selectedSenders'],
      ['callsigns', 'selectedCallsigns'],
      ['units', 'selectedUnits'],
      ['locations', 'selectedLocations'],
      ['posts', 'selectedPosts'],
      ['networks', 'selectedNetworks'],
      ['metadata', 'metadataCc'],
    ];

    for (const [section, key] of cases) {
      const req = buildAnalysisReqForFilterSection(section, buildBaseReq());
      if (section === 'metadata') {
        expect(req.metadataCc).toBeNull();
        expect(req.metadataSender).toBeNull();
        expect(req.metadataReceiver).toBeNull();
        expect(req.metadataHash).toBeNull();
        continue;
      }

      expect(req[key as keyof typeof req]).toBeNull();
    }
  });
});

describe('filterSectionsForInitialLoad', () => {
  it('always includes tags, groups, and senders so message cards can render labels and sender profiles', () => {
    expect(filterSectionsForInitialLoad(buildQueryState())).toEqual(['tags', 'groups', 'senders']);
  });

  it('keeps user-selected sections from the query state', () => {
    const sections = filterSectionsForInitialLoad({
      ...buildQueryState(),
      tags: [11],
      unitsSelected: ['u1'],
      networksSelected: ['n1'],
    });

    expect(sections).toEqual(expect.arrayContaining(['tags', 'groups', 'units', 'networks']));
  });
});

describe('reloadAnalysisData', () => {
  it('clears messages loading immediately after inbox resolves, without waiting for freqs', async () => {
    const inboxDeferred = deferred<{ inboxItems: Array<[number, unknown]>; callsigns: Array<{ callsign: string; res: [] }> }>();
    const freqsDeferred = deferred<{ freqs: Array<{ freq: string; count: number; isNew: boolean }> }>();

    mocks.fetchInboxMessages.mockImplementationOnce(() => inboxDeferred.promise);
    mocks.fetchAnalysisFreqs.mockImplementationOnce(() => freqsDeferred.promise);
    mocks.fetchAnalysisCount.mockResolvedValue({});
    mocks.fetchAnalysisSummaryTable.mockResolvedValue({ rows: [] });
    mocks.fetchAnalysisMapPoints.mockResolvedValue({ points: [], networkUnits: [] });
    mocks.fetchNetworksByIds.mockResolvedValue([]);
    mocks.getUnitsList.mockResolvedValue([]);

    const messagesLoadingTransitions: boolean[] = [];
    let messagesLoadingState = false;
    const setMessagesLoading = vi.fn((next: boolean | ((current: boolean) => boolean)) => {
      messagesLoadingState = typeof next === 'function' ? next(messagesLoadingState) : next;
      messagesLoadingTransitions.push(messagesLoadingState);
    });

    const setHasLoadedInitialMessages = vi.fn();
    const setSummaryCallsignsInfo = vi.fn();

    const queryState = {
      ...emptyQueryState(),
      fromDateTimeStr: '2026-04-01T00:00',
      toDateTimeStr: '2026-04-02T00:00',
    };

    const reloadPromise = reloadAnalysisData({
      clearAnalysisResults: vi.fn(),
      invalidateCallsignGraph: vi.fn(),
      invalidateMessagePaging: vi.fn(),
      newestFirst: true,
      onError: vi.fn(),
      onUnauthorized: vi.fn().mockReturnValue(false),
      optionsFreqsRef: { current: [] },
      queryState,
      reloadRequestRef: { current: 0 },
      setAorEntries: vi.fn(),
      setCounts: vi.fn(),
      setCountsLoading: vi.fn(),
      setFiltersLoading: vi.fn(),
      setGroupInfos: vi.fn(),
      setMapLoading: vi.fn(),
      setMapDateRange: vi.fn(),
      setMapNetworkUnits: vi.fn(),
      setMapOpenMessages: vi.fn(),
      setMapPoints: vi.fn(),
      setMessages: vi.fn(),
      setMessagesLoading,
      setNetworkDisplayMap: vi.fn(),
      setNetworks: vi.fn(),
      setUnitsMap: vi.fn(),
      setNewCallsigns: vi.fn(),
      setHasLoadedInitialMessages,
      setNewCallsignsLoading: vi.fn(),
      setNewCallsignsLoadedKey: vi.fn(),
      shouldLoadNewCallsigns: false,
      setNoMoreToLoad: vi.fn(),
      setNolimitShown: vi.fn(),
      setOptions: vi.fn(),
      setProfiles: vi.fn(),
      setSummaryCallsignsInfo,
      setSummaryLoading: vi.fn(),
      setSummaryRows: vi.fn(),
      setTagsMap: vi.fn(),
      setTopCallsigns: vi.fn(),
      setTopFreqs: vi.fn(),
      setTopLocations: vi.fn(),
      setTopUnits: vi.fn(),
      loadInitialFilterSections: vi.fn().mockResolvedValue(undefined),
      invalidateFilterSectionLoads: vi.fn(),
    });

    await flushPromises();
    expect(messagesLoadingTransitions).toContain(true);

    inboxDeferred.resolve({ inboxItems: [[1, { networkIds: [] }]], callsigns: [{ callsign: 'alpha', res: [] }] });
    await flushPromises();

    expect(setHasLoadedInitialMessages).toHaveBeenCalledWith(true);
    expect(messagesLoadingTransitions).toContain(false);
    expect(mocks.fetchAnalysisCount).not.toHaveBeenCalled();
    expect(setSummaryCallsignsInfo).toHaveBeenCalledWith(buildSummaryCallsignsInfo([{ callsign: 'alpha', res: [] }], null));

    freqsDeferred.resolve({ freqs: [] });
    await reloadPromise;
    await flushPromises();

    expect(mocks.fetchAnalysisCount).toHaveBeenCalledTimes(1);
  });

  it('refreshes summary callsign info after rebuilt inbox data arrives', async () => {
    const inboxDeferred = deferred<{ inboxItems: Array<[number, unknown]>; callsigns: Array<{ callsign: string; res: [] }> }>();
    const rebuiltInboxDeferred = deferred<{ inboxItems: Array<[number, unknown]>; callsigns: Array<{ callsign: string; res: [] }> }>();
    const freqsDeferred = deferred<{ freqs: Array<{ freq: string; count: number; isNew: boolean }> }>();
    const rebuiltFreqsDeferred = deferred<{ freqs: Array<{ freq: string; count: number; isNew: boolean }> }>();

    mocks.fetchInboxMessages
      .mockImplementationOnce(() => inboxDeferred.promise)
      .mockImplementationOnce(() => rebuiltInboxDeferred.promise);
    mocks.fetchAnalysisFreqs
      .mockImplementationOnce(() => freqsDeferred.promise)
      .mockImplementationOnce(() => rebuiltFreqsDeferred.promise);
    mocks.fetchAnalysisCount.mockResolvedValue({});
    mocks.fetchAnalysisSummaryTable.mockResolvedValue({ rows: [] });
    mocks.fetchAnalysisMapPoints.mockResolvedValue({ points: [], networkUnits: [] });
    mocks.fetchNetworksByIds.mockResolvedValue([]);
    mocks.getUnitsList.mockResolvedValue([]);
    mocks.fetchAnalysisCallsigns.mockResolvedValue({ callsigns: [{ callsign: 'ALPHA', count: 11 }] });
    mocks.fetchAnalysisUnits.mockResolvedValue({ units: [{ unit: 'UNIT-1', count: 12 }] });
    mocks.fetchAnalysisLocations.mockResolvedValue({ locations: [{ location: 'LOC-1', count: 13 }] });

    const setSummaryCallsignsInfo = vi.fn();
    const setTopCallsigns = vi.fn();
    const setTopFreqs = vi.fn();
    const setTopUnits = vi.fn();
    const setTopLocations = vi.fn();

    const reloadPromise = reloadAnalysisData({
      clearAnalysisResults: vi.fn(),
      invalidateCallsignGraph: vi.fn(),
      invalidateMessagePaging: vi.fn(),
      newestFirst: true,
      onError: vi.fn(),
      onUnauthorized: vi.fn().mockReturnValue(false),
      optionsFreqsRef: { current: [] },
      queryState: {
        ...emptyQueryState(),
        fromDateTimeStr: '2026-04-01T00:00',
        toDateTimeStr: '2026-04-02T00:00',
        freqsSelected: ['150.100'],
        adjacentFreqsRange: 0.002,
      },
      reloadRequestRef: { current: 0 },
      setAorEntries: vi.fn(),
      setCounts: vi.fn(),
      setCountsLoading: vi.fn(),
      setFiltersLoading: vi.fn(),
      setGroupInfos: vi.fn(),
      setMapLoading: vi.fn(),
      setMapDateRange: vi.fn(),
      setMapNetworkUnits: vi.fn(),
      setMapOpenMessages: vi.fn(),
      setMapPoints: vi.fn(),
      setMessages: vi.fn(),
      setMessagesLoading: vi.fn(),
      setNetworkDisplayMap: vi.fn(),
      setNetworks: vi.fn(),
      setUnitsMap: vi.fn(),
      setNewCallsigns: vi.fn(),
      setHasLoadedInitialMessages: vi.fn(),
      setNewCallsignsLoading: vi.fn(),
      setNewCallsignsLoadedKey: vi.fn(),
      shouldLoadNewCallsigns: false,
      setNoMoreToLoad: vi.fn(),
      setNolimitShown: vi.fn(),
      setOptions: vi.fn(),
      setProfiles: vi.fn(),
      setSummaryCallsignsInfo,
      setSummaryLoading: vi.fn(),
      setSummaryRows: vi.fn(),
      setTagsMap: vi.fn(),
      setTopCallsigns,
      setTopFreqs,
      setTopLocations,
      setTopUnits,
      loadInitialFilterSections: vi.fn().mockResolvedValue(undefined),
      invalidateFilterSectionLoads: vi.fn(),
    });

    await flushPromises();
    inboxDeferred.resolve({ inboxItems: [[1, { networkIds: [] }]], callsigns: [{ callsign: 'alpha', res: [] }] });
    await flushPromises();
    freqsDeferred.resolve({
      freqs: [
        { freq: '150.099', count: 1, isNew: false },
        { freq: '150.100', count: 1, isNew: false },
        { freq: '150.101', count: 1, isNew: false },
      ],
    });
    await flushPromises();
    rebuiltInboxDeferred.resolve({ inboxItems: [[2, { networkIds: [] }]], callsigns: [{ callsign: 'bravo', res: [] }] });
    await flushPromises();
    rebuiltFreqsDeferred.resolve({
      freqs: [
        { freq: '150.199', count: 9, isNew: true },
        { freq: '150.200', count: 8, isNew: false },
      ],
    });
    await reloadPromise;
    await flushPromises();

    expect(setSummaryCallsignsInfo).toHaveBeenCalledWith(buildSummaryCallsignsInfo([{ callsign: 'alpha', res: [] }], null));
    expect(setSummaryCallsignsInfo).toHaveBeenLastCalledWith(buildSummaryCallsignsInfo([{ callsign: 'bravo', res: [] }], null));
    expect(setTopCallsigns).toHaveBeenCalledWith([{ key: 'ALPHA', count: 11 }]);
    expect(mocks.fetchAnalysisFreqs).toHaveBeenCalledTimes(2);
    expect(setTopFreqs).toHaveBeenLastCalledWith([
      { key: '150.199', count: 9 },
      { key: '150.200', count: 8 },
    ]);
    expect(setTopUnits).toHaveBeenCalledWith([{ key: 'UNIT-1', count: 12 }]);
    expect(setTopLocations).toHaveBeenCalledWith([{ key: 'LOC-1', count: 13 }]);
  });

  it('keeps the original inbox state when rebuilt inbox fetch fails', async () => {
    const inboxDeferred = deferred<{ inboxItems: Array<[number, unknown]>; callsigns: Array<{ callsign: string; res: [] }> }>();
    const rebuiltInboxDeferred = deferred<{ inboxItems: Array<[number, unknown]>; callsigns: Array<{ callsign: string; res: [] }> }>();
    const freqsDeferred = deferred<{ freqs: Array<{ freq: string; count: number; isNew: boolean }> }>();

    mocks.fetchInboxMessages
      .mockImplementationOnce(() => inboxDeferred.promise)
      .mockImplementationOnce(() => rebuiltInboxDeferred.promise);
    mocks.fetchAnalysisFreqs.mockImplementationOnce(() => freqsDeferred.promise);
    mocks.fetchAnalysisCount.mockResolvedValue({});
    mocks.fetchAnalysisSummaryTable.mockResolvedValue({ rows: [] });
    mocks.fetchAnalysisMapPoints.mockResolvedValue({ points: [], networkUnits: [] });
    mocks.fetchAnalysisNetworks.mockResolvedValue({ networks: [], networkNames: [] });
    mocks.fetchNetworksByIds.mockResolvedValue([]);
    mocks.getUnitsList.mockResolvedValue([]);

    const setMessages = vi.fn();
    const setSummaryCallsignsInfo = vi.fn();

    const reloadPromise = reloadAnalysisData({
      clearAnalysisResults: vi.fn(),
      invalidateCallsignGraph: vi.fn(),
      invalidateMessagePaging: vi.fn(),
      newestFirst: true,
      onError: vi.fn(),
      onUnauthorized: vi.fn().mockReturnValue(false),
      optionsFreqsRef: { current: [] },
      queryState: {
        ...emptyQueryState(),
        fromDateTimeStr: '2026-04-01T00:00',
        toDateTimeStr: '2026-04-02T00:00',
        freqsSelected: ['150.100'],
        adjacentFreqsRange: 0.002,
      },
      reloadRequestRef: { current: 0 },
      setAorEntries: vi.fn(),
      setCounts: vi.fn(),
      setCountsLoading: vi.fn(),
      setFiltersLoading: vi.fn(),
      setGroupInfos: vi.fn(),
      setMapLoading: vi.fn(),
      setMapDateRange: vi.fn(),
      setMapNetworkUnits: vi.fn(),
      setMapOpenMessages: vi.fn(),
      setMapPoints: vi.fn(),
      setMessages,
      setMessagesLoading: vi.fn(),
      setNetworkDisplayMap: vi.fn(),
      setNetworks: vi.fn(),
      setUnitsMap: vi.fn(),
      setNewCallsigns: vi.fn(),
      setHasLoadedInitialMessages: vi.fn(),
      setNewCallsignsLoading: vi.fn(),
      setNewCallsignsLoadedKey: vi.fn(),
      shouldLoadNewCallsigns: false,
      setNoMoreToLoad: vi.fn(),
      setNolimitShown: vi.fn(),
      setOptions: vi.fn(),
      setProfiles: vi.fn(),
      setSummaryCallsignsInfo,
      setSummaryLoading: vi.fn(),
      setSummaryRows: vi.fn(),
      setTagsMap: vi.fn(),
      setTopCallsigns: vi.fn(),
      setTopFreqs: vi.fn(),
      setTopLocations: vi.fn(),
      setTopUnits: vi.fn(),
      loadInitialFilterSections: vi.fn().mockResolvedValue(undefined),
      invalidateFilterSectionLoads: vi.fn(),
    });

    await flushPromises();
    inboxDeferred.resolve({ inboxItems: [[1, { networkIds: [] }]], callsigns: [{ callsign: 'alpha', res: [] }] });
    await flushPromises();
    freqsDeferred.resolve({
      freqs: [
        { freq: '150.099', count: 1, isNew: false },
        { freq: '150.100', count: 1, isNew: false },
        { freq: '150.101', count: 1, isNew: false },
      ],
    });
    await flushPromises();
    rebuiltInboxDeferred.reject(new Error('rebuilt inbox failed'));
    await reloadPromise;
    await flushPromises();

    expect(setMessages).toHaveBeenCalledTimes(1);
    expect(setMessages).toHaveBeenCalledWith([[1, { networkIds: [] }]]);
    expect(setSummaryCallsignsInfo).toHaveBeenCalled();
    expect(setSummaryCallsignsInfo).toHaveBeenCalledWith(buildSummaryCallsignsInfo([{ callsign: 'alpha', res: [] }], null));
  });

  it('hydrates summary hints and network metadata from the full analysis scope', async () => {
    mocks.fetchAnalysisCallsigns.mockResolvedValue({ callsigns: [{ callsign: 'alpha', count: 11 }, { callsign: 'beta', count: 7 }] });
    mocks.fetchAnalysisCallsignInfos.mockResolvedValue([{ callsign: 'beta', res: [{ id: 1, comment: '', position: '', unit1: '', unit2: '', networkIdsReportedIn: [] }] }]);
    mocks.fetchAnalysisUnits.mockResolvedValue({ units: [{ unit: 'UNIT-1', count: 12 }] });
    mocks.fetchAnalysisLocations.mockResolvedValue({ locations: [{ location: 'LOC-1', count: 13 }] });
    mocks.fetchAnalysisNetworks.mockResolvedValue({ networks: [{ networkId: 11, count: 2 }], networkNames: [{ id: 11, name: 'Network 11' }] });
    mocks.fetchNetworksByIds.mockResolvedValue([{ id: 11, name: 'Network 11' }]);
    mocks.getUnitsList.mockResolvedValue([{ id: 1, name: 'Unit One' }]);
    mocks.fetchInboxMessages.mockResolvedValue({ inboxItems: [[1, { networkIds: [11] }]], callsigns: [{ callsign: 'alpha', res: [] }] });
    mocks.fetchAnalysisFreqs.mockResolvedValue({
      freqs: [{ freq: '150.100', count: 1, isNew: false }],
    });
    mocks.fetchAnalysisCount.mockResolvedValue({});
    mocks.fetchAnalysisSummaryTable.mockResolvedValue({ rows: [] });
    mocks.fetchAnalysisMapPoints.mockResolvedValue({ points: [], networkUnits: [] });

    const setSummaryCallsignsInfo = vi.fn();
    const setTopCallsigns = vi.fn();
    const setTopUnits = vi.fn();
    const setTopLocations = vi.fn();
    const setNetworks = vi.fn();
    const setUnitsMap = vi.fn();

    const reloadPromise = reloadAnalysisData({
      clearAnalysisResults: vi.fn(),
      invalidateCallsignGraph: vi.fn(),
      invalidateMessagePaging: vi.fn(),
      newestFirst: true,
      onError: vi.fn(),
      onUnauthorized: vi.fn().mockReturnValue(false),
      optionsFreqsRef: { current: [] },
      queryState: {
        ...emptyQueryState(),
        fromDateTimeStr: '2026-04-01T00:00',
        toDateTimeStr: '2026-04-02T00:00',
        freqsSelected: ['150.100'],
        adjacentFreqsRange: 0.002,
      },
      reloadRequestRef: { current: 0 },
      setAorEntries: vi.fn(),
      setCounts: vi.fn(),
      setCountsLoading: vi.fn(),
      setFiltersLoading: vi.fn(),
      setGroupInfos: vi.fn(),
      setMapLoading: vi.fn(),
      setMapDateRange: vi.fn(),
      setMapNetworkUnits: vi.fn(),
      setMapOpenMessages: vi.fn(),
      setMapPoints: vi.fn(),
      setMessages: vi.fn(),
      setMessagesLoading: vi.fn(),
      setNetworkDisplayMap: vi.fn(),
      setNetworks,
      setUnitsMap,
      setNewCallsigns: vi.fn(),
      setHasLoadedInitialMessages: vi.fn(),
      setNewCallsignsLoading: vi.fn(),
      setNewCallsignsLoadedKey: vi.fn(),
      shouldLoadNewCallsigns: false,
      setNoMoreToLoad: vi.fn(),
      setNolimitShown: vi.fn(),
      setOptions: vi.fn(),
      setProfiles: vi.fn(),
      setSummaryCallsignsInfo,
      setSummaryLoading: vi.fn(),
      setSummaryRows: vi.fn(),
      setTagsMap: vi.fn(),
      setTopCallsigns,
      setTopFreqs: vi.fn(),
      setTopLocations,
      setTopUnits,
      loadInitialFilterSections: vi.fn().mockResolvedValue(undefined),
      invalidateFilterSectionLoads: vi.fn(),
    });

    await reloadPromise;
    await flushPromises();

    expect(mocks.fetchAnalysisCallsignInfos).toHaveBeenCalledWith(['alpha', 'beta']);
    expect(setTopCallsigns).toHaveBeenCalledWith([
      { key: 'alpha', count: 11 },
      { key: 'beta', count: 7 },
    ]);
    expect(setTopUnits).toHaveBeenCalledWith([{ key: 'UNIT-1', count: 12 }]);
    expect(setTopLocations).toHaveBeenCalledWith([{ key: 'LOC-1', count: 13 }]);
    expect(mocks.fetchAnalysisNetworks).toHaveBeenCalled();
    expect(mocks.fetchNetworksByIds).toHaveBeenCalledWith([11]);
    expect(setUnitsMap).toHaveBeenCalledWith({ 1: { id: 1, name: 'Unit One' } });
    expect(setNetworks).toHaveBeenCalled();
    expect(setSummaryCallsignsInfo).toHaveBeenCalledWith(buildSummaryCallsignsInfo([{ callsign: 'alpha', res: [] }], null));
    expect(setSummaryCallsignsInfo).toHaveBeenCalledWith(
      buildSummaryCallsignsInfo(
        [{ callsign: 'alpha', res: [] }],
        [{ callsign: 'beta', res: [{ id: 1, comment: '', position: '', unit1: '', unit2: '', networkIdsReportedIn: [] }] }],
      ),
    );
  });

  it('skips callsign-info batching when the top callsign list is empty', async () => {
    mocks.fetchAnalysisCallsigns.mockResolvedValue({ callsigns: [] });
    mocks.fetchAnalysisUnits.mockResolvedValue({ units: [] });
    mocks.fetchAnalysisLocations.mockResolvedValue({ locations: [] });
    mocks.fetchInboxMessages.mockResolvedValue({ inboxItems: [[1, { networkIds: [] }]], callsigns: [{ callsign: 'alpha', res: [] }] });
    mocks.fetchAnalysisFreqs.mockResolvedValue({
      freqs: [{ freq: '150.100', count: 1, isNew: false }],
    });
    mocks.fetchAnalysisCount.mockResolvedValue({});
    mocks.fetchAnalysisSummaryTable.mockResolvedValue({ rows: [] });
    mocks.fetchAnalysisMapPoints.mockResolvedValue({ points: [], networkUnits: [] });

    const reloadPromise = reloadAnalysisData({
      clearAnalysisResults: vi.fn(),
      invalidateCallsignGraph: vi.fn(),
      invalidateMessagePaging: vi.fn(),
      newestFirst: true,
      onError: vi.fn(),
      onUnauthorized: vi.fn().mockReturnValue(false),
      optionsFreqsRef: { current: [] },
      queryState: {
        ...emptyQueryState(),
        fromDateTimeStr: '2026-04-01T00:00',
        toDateTimeStr: '2026-04-02T00:00',
      },
      reloadRequestRef: { current: 0 },
      setAorEntries: vi.fn(),
      setCounts: vi.fn(),
      setCountsLoading: vi.fn(),
      setFiltersLoading: vi.fn(),
      setGroupInfos: vi.fn(),
      setMapLoading: vi.fn(),
      setMapDateRange: vi.fn(),
      setMapNetworkUnits: vi.fn(),
      setMapOpenMessages: vi.fn(),
      setMapPoints: vi.fn(),
      setMessages: vi.fn(),
      setMessagesLoading: vi.fn(),
      setNetworkDisplayMap: vi.fn(),
      setNetworks: vi.fn(),
      setUnitsMap: vi.fn(),
      setNewCallsigns: vi.fn(),
      setHasLoadedInitialMessages: vi.fn(),
      setNewCallsignsLoading: vi.fn(),
      setNewCallsignsLoadedKey: vi.fn(),
      shouldLoadNewCallsigns: false,
      setNoMoreToLoad: vi.fn(),
      setNolimitShown: vi.fn(),
      setOptions: vi.fn(),
      setProfiles: vi.fn(),
      setSummaryCallsignsInfo: vi.fn(),
      setSummaryLoading: vi.fn(),
      setSummaryRows: vi.fn(),
      setTagsMap: vi.fn(),
      setTopCallsigns: vi.fn(),
      setTopFreqs: vi.fn(),
      setTopLocations: vi.fn(),
      setTopUnits: vi.fn(),
      loadInitialFilterSections: vi.fn().mockResolvedValue(undefined),
      invalidateFilterSectionLoads: vi.fn(),
    });

    await reloadPromise;
    await flushPromises();

    expect(mocks.fetchAnalysisCallsignInfos).not.toHaveBeenCalled();
  });

  it('clears frequency-derived state when the frequency request fails after inbox loads', async () => {
    mocks.fetchAnalysisFreqs.mockRejectedValue(new Error('freqs failed'));
    mocks.fetchInboxMessages.mockResolvedValue({ inboxItems: [[1, { networkIds: [] }]], callsigns: [{ callsign: 'alpha', res: [] }] });
    mocks.fetchAnalysisCount.mockResolvedValue({});
    mocks.fetchAnalysisSummaryTable.mockResolvedValue({ rows: [] });
    mocks.fetchAnalysisMapPoints.mockResolvedValue({ points: [], networkUnits: [] });

    const setCounts = vi.fn();
    const setNewCallsigns = vi.fn();
    const setNewCallsignsLoadedKey = vi.fn();
    const setOptions = vi.fn();
    const setTopFreqs = vi.fn();

    await reloadAnalysisData({
      clearAnalysisResults: vi.fn(),
      invalidateCallsignGraph: vi.fn(),
      invalidateMessagePaging: vi.fn(),
      newestFirst: true,
      onError: vi.fn(),
      onUnauthorized: vi.fn().mockReturnValue(false),
      optionsFreqsRef: { current: [] },
      queryState: {
        ...emptyQueryState(),
        fromDateTimeStr: '2026-04-01T00:00',
        toDateTimeStr: '2026-04-02T00:00',
      },
      reloadRequestRef: { current: 0 },
      setAorEntries: vi.fn(),
      setCounts,
      setCountsLoading: vi.fn(),
      setFiltersLoading: vi.fn(),
      setGroupInfos: vi.fn(),
      setMapLoading: vi.fn(),
      setMapDateRange: vi.fn(),
      setMapNetworkUnits: vi.fn(),
      setMapOpenMessages: vi.fn(),
      setMapPoints: vi.fn(),
      setMessages: vi.fn(),
      setMessagesLoading: vi.fn(),
      setNetworkDisplayMap: vi.fn(),
      setNetworks: vi.fn(),
      setUnitsMap: vi.fn(),
      setNewCallsigns,
      setHasLoadedInitialMessages: vi.fn(),
      setNewCallsignsLoading: vi.fn(),
      setNewCallsignsLoadedKey,
      shouldLoadNewCallsigns: false,
      setNoMoreToLoad: vi.fn(),
      setNolimitShown: vi.fn(),
      setOptions,
      setProfiles: vi.fn(),
      setSummaryCallsignsInfo: vi.fn(),
      setSummaryLoading: vi.fn(),
      setSummaryRows: vi.fn(),
      setTagsMap: vi.fn(),
      setTopCallsigns: vi.fn(),
      setTopFreqs,
      setTopLocations: vi.fn(),
      setTopUnits: vi.fn(),
      loadInitialFilterSections: vi.fn().mockResolvedValue(undefined),
      invalidateFilterSectionLoads: vi.fn(),
    });

    expect(setCounts).toHaveBeenCalledWith(null);
    expect(setNewCallsigns).toHaveBeenCalledWith(emptyNewCallsigns);
    expect(setNewCallsignsLoadedKey).toHaveBeenCalledWith(null);
    expect(setOptions).toHaveBeenCalledWith(emptyOptions);
    expect(setTopFreqs).toHaveBeenCalledWith([]);
  });
});
