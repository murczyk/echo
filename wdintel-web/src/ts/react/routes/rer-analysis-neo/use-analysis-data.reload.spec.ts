import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AnalysisFilterSectionId } from './types';
import { emptyQueryState } from './helpers';
import { buildAnalysisReqForFilterSection, filterSectionsForInitialLoad, reloadAnalysisData } from './use-analysis-data.reload';

const mocks = vi.hoisted(() => ({
  fetchAnalysisAors: vi.fn(),
  fetchAnalysisCallsigns: vi.fn(),
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
  it('always includes tags so message cards can render tag chips', () => {
    expect(filterSectionsForInitialLoad(buildQueryState())).toEqual(['tags', 'groups']);
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
    const inboxDeferred = deferred<{ inboxItems: Array<[number, unknown]> }>();
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

    await flushPromises();
    expect(messagesLoadingTransitions).toContain(true);

    inboxDeferred.resolve({ inboxItems: [[1, { networkIds: [] }]] });
    await flushPromises();

    expect(setHasLoadedInitialMessages).toHaveBeenCalledWith(true);
    expect(messagesLoadingTransitions).toContain(false);
    expect(mocks.fetchAnalysisCount).not.toHaveBeenCalled();

    freqsDeferred.resolve({ freqs: [] });
    await reloadPromise;
    await flushPromises();

    expect(mocks.fetchAnalysisCount).toHaveBeenCalledTimes(1);
  });
});
