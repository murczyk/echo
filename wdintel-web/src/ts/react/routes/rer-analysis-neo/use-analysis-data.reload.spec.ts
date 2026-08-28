import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Network, Unit } from '../../../../Bindings';
import type { AnalysisFilterSectionId } from './types';
import { buildAnalysisReq, emptyQueryState } from './helpers';
import {
  buildAnalysisReqForFilterSection,
  buildHydratedNetworkFilterOptions,
  buildNetworkStatsFilterOptions,
  filterSectionsForInitialLoad,
  loadFilterSectionData,
  mergeSignalProfiles,
  mergeHydratedNetworkFilterOptions,
  replaceNetworkFilterOptionsPreservingSelectedLabels,
  reloadAnalysisData,
  transformMessagePageResponse,
} from './use-analysis-data.reload';
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
  fetchInboxCount: vi.fn(),
  fetchInboxMessages: vi.fn(),
  fetchNetworksByIds: vi.fn(),
  getLatestSenders: vi.fn(),
  getTagsForDisplay: vi.fn(),
  getTagsMapForDisplay: vi.fn(),
  getUnitsList: vi.fn(),
  getUnitsByIds: vi.fn(),
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
  fetchInboxCount: mocks.fetchInboxCount,
  fetchInboxMessages: mocks.fetchInboxMessages,
  fetchNetworksByIds: mocks.fetchNetworksByIds,
  getLatestSenders: mocks.getLatestSenders,
  getTagsForDisplay: mocks.getTagsForDisplay,
  getTagsMapForDisplay: mocks.getTagsMapForDisplay,
}));

vi.mock('../../services/api/units', () => ({
  getUnitsList: mocks.getUnitsList,
  getUnitsByIds: mocks.getUnitsByIds,
  mergeUnitsById: (...unitLists: Unit[][]) => {
    const unitsById = new Map<number, Unit>();
    unitLists.flat().forEach((unit) => unitsById.set(unit.id, unit));
    return Array.from(unitsById.values());
  },
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

type ReloadInboxRsp = {
  inboxItems: Array<[number, unknown]>;
  callsigns: Array<{ callsign: string; res: [] }>;
  pageLimit: number | null;
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
  mocks.fetchInboxCount.mockResolvedValue({ quantity: 42 });
  mocks.fetchAnalysisNetworks.mockResolvedValue({ networks: [], networkNames: [] });
  mocks.fetchAnalysisCallsigns.mockResolvedValue({ callsigns: [] });
  mocks.fetchAnalysisCallsignInfos.mockResolvedValue([]);
  mocks.fetchAnalysisUnits.mockResolvedValue({ units: [] });
  mocks.fetchAnalysisLocations.mockResolvedValue({ locations: [] });
  mocks.getUnitsByIds.mockResolvedValue([]);
  mocks.getTagsForDisplay.mockResolvedValue({ tagsMap: {}, tagsOrder: [] });
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
        expect(req.withoutMetadata).toBe(false);
        continue;
      }

      expect(req[key as keyof typeof req]).toBeNull();
    }
  });

  it('strips every self-referential tag condition from the tags facet request', () => {
    const req = buildAnalysisReqForFilterSection('tags', {
      ...buildBaseReq(),
      selectedTags: null,
      deniedTags: [11],
      tagPresence: 'WithoutTags',
    });

    expect(req.selectedTags).toBeNull();
    expect(req.deniedTags).toBeNull();
    expect(req.tagPresence).toBeNull();
  });

  it('clears withoutMetadata for metadata filter section requests', () => {
    const req = buildAnalysisReqForFilterSection('metadata', {
      ...buildBaseReq(),
      withoutMetadata: true,
    });

    expect(req.metadataCc).toBeNull();
    expect(req.metadataSender).toBeNull();
    expect(req.metadataReceiver).toBeNull();
    expect(req.metadataHash).toBeNull();
    expect(req.withoutMetadata).toBe(false);
  });
});

describe('mergeSignalProfiles', () => {
  it('keeps existing profiles and fills only missing entries', () => {
    expect(
      mergeSignalProfiles(
        {
          existing: { givenName: 'BBC', familyName: 'SPORT' },
          keepNull: null,
        },
        {
          existing: null,
          keepNull: { givenName: 'Should', familyName: 'NotReplace' },
          nextOnly: { givenName: 'NEW', familyName: 'ENTRY' },
        },
      ),
    ).toEqual({
      existing: { givenName: 'BBC', familyName: 'SPORT' },
      keepNull: { givenName: 'Should', familyName: 'NotReplace' },
      nextOnly: { givenName: 'NEW', familyName: 'ENTRY' },
    });
  });
});

describe('filterSectionsForInitialLoad', () => {
  it('always preloads the decoration metadata sections', () => {
    const sections = filterSectionsForInitialLoad(buildQueryState());
    expect(sections).toEqual(expect.arrayContaining(['tags', 'groups', 'senders']));
  });

  it('keeps user-selected sections from the query state', () => {
    const sections = filterSectionsForInitialLoad({
      ...buildQueryState(),
      tags: [11],
      unitsSelected: ['u1'],
      networksSelected: ['n1'],
    });

    expect(sections).toEqual(expect.arrayContaining(['tags', 'units', 'networks']));
    expect(sections).toEqual(expect.arrayContaining(['groups', 'senders']));
  });

  it('loads only selected sections while the filter panel is closed', () => {
    const sections = filterSectionsForInitialLoad(
      {
        ...buildQueryState(),
        unitsSelected: ['u1'],
        networksSelected: ['n1'],
      },
      false,
    );

    expect(sections).toEqual(['units', 'networks']);
  });
});

describe('loadFilterSectionData', () => {
  it('builds uppercase callsign labels with lowercase filter values', async () => {
    mocks.fetchAnalysisCallsigns.mockResolvedValue({
      callsigns: [
        { callsign: 'НУГУШ', count: 2 },
        { callsign: 'нугуш', count: 3 },
      ],
    });
    let currentOptions = structuredClone(emptyOptions);

    await loadFilterSectionData('callsigns', {
      analysisReq: buildAnalysisReq(buildQueryState())!,
      loadVersion: 0,
      loadVersionRef: { current: 0 },
      queryState: buildQueryState(),
      setAorEntries: vi.fn(),
      setGroupInfos: vi.fn(),
      setNetworks: vi.fn(),
      setOptions: (update) => {
        currentOptions = typeof update === 'function' ? update(currentOptions) : update;
      },
      setProfiles: vi.fn(),
      setTagsMap: vi.fn(),
      setTagsOrder: vi.fn(),
      unitsMap: {},
    });

    expect(currentOptions.callsigns).toEqual([
      { value: 'нугуш', label: 'НУГУШ', count: 5, values: ['нугуш'] },
    ]);
  });

  // @test-scope parser: analysis sender statistics response fixture
  it('uses sender names returned with the analysis sender statistics', async () => {
    mocks.fetchAnalysisSenders.mockResolvedValue({
      senders: [{ uuid: 'messenger-sender', count: 2, freqBreakdown: [], perDay: {} }],
      senderNames: {
        'messenger-sender': { givenName: 'Alpha', familyName: 'Team' },
      },
    });
    let currentOptions = structuredClone(emptyOptions);

    await loadFilterSectionData('senders', {
      analysisReq: buildAnalysisReq(buildQueryState())!,
      loadVersion: 0,
      loadVersionRef: { current: 0 },
      queryState: buildQueryState(),
      setAorEntries: vi.fn(),
      setGroupInfos: vi.fn(),
      setNetworks: vi.fn(),
      setOptions: (update) => {
        currentOptions = typeof update === 'function' ? update(currentOptions) : update;
      },
      setProfiles: vi.fn(),
      setTagsMap: vi.fn(),
      setTagsOrder: vi.fn(),
      unitsMap: {},
    });

    expect(currentOptions.senders).toEqual([
      { value: 'messenger-sender', label: 'Alpha Team', count: 2 },
    ]);
  });

  // @test-scope parser: analysis network statistics and unit-label response fixture
  it('loads missing units before building network filter labels', async () => {
    mocks.fetchAnalysisNetworks.mockResolvedValue({
      networks: [{ networkId: 12, count: 6 }],
      networkNames: [{ id: 12, name: 'управління 23 сб' }],
    });
    mocks.fetchNetworksByIds.mockResolvedValue([
      { id: 12, name: 'управління', location: 'Харків', unitIds: [23] },
    ] as unknown as Network[]);
    mocks.getUnitsByIds.mockResolvedValue([{ id: 23, name: '23 сб' }] as unknown as Unit[]);
    let currentOptions = structuredClone(emptyOptions);

    await loadFilterSectionData('networks', {
      analysisReq: buildAnalysisReq(buildQueryState())!,
      loadVersion: 0,
      loadVersionRef: { current: 0 },
      queryState: buildQueryState(),
      setAorEntries: vi.fn(),
      setGroupInfos: vi.fn(),
      setNetworks: vi.fn(),
      setOptions: (update) => {
        currentOptions = typeof update === 'function' ? update(currentOptions) : update;
      },
      setProfiles: vi.fn(),
      setTagsMap: vi.fn(),
      setTagsOrder: vi.fn(),
      unitsMap: {},
    });

    expect(mocks.getUnitsByIds).toHaveBeenCalledWith([23], undefined);
    expect(currentOptions.networks).toEqual([
      { value: '12', label: 'управління 23 сб (ХАРКІВ)', count: 6 },
    ]);
  });
});

describe('reloadAnalysisData', () => {
  it('clears messages loading immediately after inbox resolves, without waiting for freqs', async () => {
    const inboxDeferred = deferred<ReloadInboxRsp>();
    const freqsDeferred = deferred<{
      freqs: Array<{ freq: string; count: number; isNew: boolean }>;
    }>();

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

    const invalidateCorrelatedFreqsCache = vi.fn();
    const setHasLoadedInitialMessages = vi.fn();
    const setMessages = vi.fn();
    const setNoMoreToLoad = vi.fn();
    const setSummaryCallsignsInfo = vi.fn();

    const queryState = {
      ...emptyQueryState(),
      fromDateTimeStr: '2026-04-01T00:00',
      toDateTimeStr: '2026-04-02T00:00',
    };

    const reloadPromise = reloadAnalysisData({
      clearAnalysisResults: vi.fn(),
      invalidateCorrelatedFreqsCache,
      invalidateCallsignGraph: vi.fn(),
      invalidateMessagePaging: vi.fn(),
      messagePageCursor: {
        beforeIdNoninclusive: null,
        sinceIdNoninclusive: null,
        requestNewestFirst: false,
        reverseResults: true,
        resultLimit: 2,
      },
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
      setMessages,
      setMessagesLoading,
      setNetworks: vi.fn(),
      setUnitsMap: vi.fn(),
      setNewCallsigns: vi.fn(),
      setHasLoadedInitialMessages,
      setNewCallsignsLoading: vi.fn(),
      setNewCallsignsLoadedKey: vi.fn(),
      shouldLoadNewCallsigns: false,
      setNoMoreToLoad,
      setNolimitShown: vi.fn(),
      setOptions: vi.fn(),
      setProfiles: vi.fn(),
      setSummaryCallsignsInfo,
      setSummaryLoading: vi.fn(),
      setSummaryRows: vi.fn(),
      setTagsMap: vi.fn(),
      setTagsOrder: vi.fn(),
      setTopCallsigns: vi.fn(),
      setTopFreqs: vi.fn(),
      setTopLocations: vi.fn(),
      setTopUnits: vi.fn(),
      loadInitialFilterSections: vi.fn().mockResolvedValue(undefined),
      invalidateFilterSectionLoads: vi.fn(),
    });

    await flushPromises();
    expect(messagesLoadingTransitions).toContain(true);
    expect(mocks.fetchInboxMessages.mock.calls[0]?.[0]).toMatchObject({
      beforeIdNoninclusive: null,
      sinceIdNoninclusive: null,
      newestFirst: false,
    });

    inboxDeferred.resolve({
      inboxItems: [
        [1, { networkIds: [] }],
        [2, { networkIds: [] }],
        [3, { networkIds: [] }],
      ],
      callsigns: [{ callsign: 'alpha', res: [] }],
      pageLimit: 20,
    });
    await flushPromises();

    expect(setHasLoadedInitialMessages).toHaveBeenCalledWith(true);
    expect(setMessages).toHaveBeenCalledWith([
      [2, { networkIds: [] }],
      [1, { networkIds: [] }],
    ]);
    expect(messagesLoadingTransitions).toContain(false);
    expect(mocks.fetchAnalysisCount).toHaveBeenCalledTimes(1);
    expect(setSummaryCallsignsInfo).toHaveBeenCalledWith(
      buildSummaryCallsignsInfo([{ callsign: 'alpha', res: [] }], null),
    );
    expect(setNoMoreToLoad).toHaveBeenCalledWith(true);

    freqsDeferred.resolve({ freqs: [] });
    await reloadPromise;
    await flushPromises();

    expect(mocks.fetchAnalysisCount).toHaveBeenCalledTimes(1);
    expect(invalidateCorrelatedFreqsCache).toHaveBeenCalledTimes(1);
  });

  it('refreshes summary callsign info after rebuilt inbox data arrives', async () => {
    const inboxDeferred = deferred<ReloadInboxRsp>();
    const rebuiltInboxDeferred = deferred<ReloadInboxRsp>();
    const freqsDeferred = deferred<{
      freqs: Array<{ freq: string; count: number; isNew: boolean }>;
    }>();
    const rebuiltFreqsDeferred = deferred<{
      freqs: Array<{ freq: string; count: number; isNew: boolean }>;
    }>();

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
    mocks.fetchAnalysisCallsigns.mockResolvedValue({
      callsigns: [{ callsign: 'ALPHA', count: 11 }],
    });
    mocks.fetchAnalysisUnits.mockResolvedValue({ units: [{ unit: 'UNIT-1', count: 12 }] });
    mocks.fetchAnalysisLocations.mockResolvedValue({
      locations: [{ location: 'LOC-1', count: 13 }],
    });

    const setSummaryCallsignsInfo = vi.fn();
    const setMessages = vi.fn();

    const reloadPromise = reloadAnalysisData({
      clearAnalysisResults: vi.fn(),
      invalidateCorrelatedFreqsCache: vi.fn(),
      invalidateCallsignGraph: vi.fn(),
      invalidateMessagePaging: vi.fn(),
      messagePageCursor: {
        beforeIdNoninclusive: null,
        sinceIdNoninclusive: null,
        requestNewestFirst: false,
        reverseResults: true,
        resultLimit: 3,
      },
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
      setTagsOrder: vi.fn(),
      setTopCallsigns: vi.fn(),
      setTopFreqs: vi.fn(),
      setTopLocations: vi.fn(),
      setTopUnits: vi.fn(),
      loadInitialFilterSections: vi.fn().mockResolvedValue(undefined),
      invalidateFilterSectionLoads: vi.fn(),
    });

    await flushPromises();
    expect(mocks.fetchInboxMessages.mock.calls[0]?.[0]).toMatchObject({
      beforeIdNoninclusive: null,
      sinceIdNoninclusive: null,
      newestFirst: false,
    });
    inboxDeferred.resolve({
      inboxItems: Array.from({ length: 20 }, (_, index) => [index, { networkIds: [] }]),
      callsigns: [{ callsign: 'alpha', res: [] }],
      pageLimit: 20,
    });
    await flushPromises();
    freqsDeferred.resolve({
      freqs: [
        { freq: '150.099', count: 1, isNew: false },
        { freq: '150.100', count: 1, isNew: false },
        { freq: '150.101', count: 1, isNew: false },
      ],
    });
    await flushPromises();
    expect(mocks.fetchInboxMessages.mock.calls[1]?.[0]).toMatchObject({
      beforeIdNoninclusive: null,
      sinceIdNoninclusive: null,
      newestFirst: false,
    });
    rebuiltInboxDeferred.resolve({
      inboxItems: Array.from({ length: 20 }, (_, index) => [index + 20, { networkIds: [] }]),
      callsigns: [{ callsign: 'bravo', res: [] }],
      pageLimit: 20,
    });
    await flushPromises();
    rebuiltFreqsDeferred.resolve({
      freqs: [
        { freq: '150.199', count: 9, isNew: true },
        { freq: '150.200', count: 8, isNew: false },
      ],
    });
    await reloadPromise;
    await flushPromises();

    expect(setSummaryCallsignsInfo).toHaveBeenCalledWith(
      buildSummaryCallsignsInfo([{ callsign: 'alpha', res: [] }], null),
    );
    expect(setSummaryCallsignsInfo).toHaveBeenLastCalledWith(
      buildSummaryCallsignsInfo([{ callsign: 'bravo', res: [] }], null),
    );
    expect(mocks.fetchAnalysisCallsigns).not.toHaveBeenCalled();
    expect(mocks.fetchAnalysisCallsignInfos).not.toHaveBeenCalled();
    expect(mocks.fetchAnalysisFreqs).toHaveBeenCalledTimes(2);
    expect(setMessages).toHaveBeenLastCalledWith([
      [22, { networkIds: [] }],
      [21, { networkIds: [] }],
      [20, { networkIds: [] }],
    ]);
    expect(setMessages.mock.lastCall?.[0]).toHaveLength(3);
  });

  it('keeps the original inbox state when rebuilt inbox fetch fails', async () => {
    const inboxDeferred = deferred<ReloadInboxRsp>();
    const rebuiltInboxDeferred = deferred<ReloadInboxRsp>();
    const freqsDeferred = deferred<{
      freqs: Array<{ freq: string; count: number; isNew: boolean }>;
    }>();

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
      invalidateCorrelatedFreqsCache: vi.fn(),
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
      setTagsOrder: vi.fn(),
      setTopCallsigns: vi.fn(),
      setTopFreqs: vi.fn(),
      setTopLocations: vi.fn(),
      setTopUnits: vi.fn(),
      loadInitialFilterSections: vi.fn().mockResolvedValue(undefined),
      invalidateFilterSectionLoads: vi.fn(),
    });

    await flushPromises();
    inboxDeferred.resolve({
      inboxItems: [[1, { networkIds: [] }]],
      callsigns: [{ callsign: 'alpha', res: [] }],
      pageLimit: 20,
    });
    await flushPromises();
    freqsDeferred.resolve({
      freqs: [
        { freq: '150.099', count: 1, isNew: false },
        { freq: '150.100', count: 1, isNew: false },
        { freq: '150.101', count: 1, isNew: false },
      ],
    });
    await flushPromises();
    await vi.waitFor(() => expect(mocks.fetchInboxMessages).toHaveBeenCalledTimes(2));
    rebuiltInboxDeferred.reject(new Error('rebuilt inbox failed'));
    await reloadPromise;
    await flushPromises();

    expect(setMessages).toHaveBeenCalledTimes(1);
    expect(setMessages).toHaveBeenCalledWith([[1, { networkIds: [] }]]);
    expect(setSummaryCallsignsInfo).toHaveBeenCalled();
    expect(setSummaryCallsignsInfo).toHaveBeenCalledWith(
      buildSummaryCallsignsInfo([{ callsign: 'alpha', res: [] }], null),
    );
  });

  it('hydrates selected network labels into filter options', () => {
    expect(
      buildHydratedNetworkFilterOptions(
        [
          { id: 2852, name: 'управління', unitIds: [23] },
          { id: 11, name: 'Network 11' },
        ] as unknown as Network[],
        [2852],
        { 23: { id: 23, name: '23 сб' } } as unknown as Record<number, Unit>,
      ),
    ).toEqual([{ value: '2852', label: 'управління 23 сб', count: 0 }]);
  });

  it('builds counted network options with hydrated unit labels', () => {
    expect(
      buildNetworkStatsFilterOptions(
        {
          networks: [
            { networkId: 5, count: 11 },
            { networkId: 7, count: 3 },
          ],
          networkNames: [
            { id: 5, name: '💻' },
            { id: 7, name: 'Network 7' },
          ],
        },
        [{ id: 5, name: '💻', unitIds: [23] }] as unknown as Network[],
        { 23: { id: 23, name: '4 зБпС 50 обрБпС' } } as unknown as Record<number, Unit>,
      ),
    ).toEqual([
      { value: '5', label: '💻 4 зБпС 50 обрБпС', count: 11 },
      { value: '7', label: 'Network 7', count: 3 },
    ]);
  });

  it('keeps stats labels when hydration provides a shorter real label', () => {
    expect(
      mergeHydratedNetworkFilterOptions(
        [{ value: '2852', label: 'управління 23 с6 35 омсбр 41 А', count: 293 }],
        [{ value: '2852', label: 'управління', count: 0 }],
      ),
    ).toEqual([
      { value: '2852', label: 'управління 23 с6 35 омсбр 41 А', count: 293, values: ['2852'] },
    ]);
  });

  it('repairs a stats fallback with a hydrated real label', () => {
    expect(
      mergeHydratedNetworkFilterOptions(
        [{ value: '2852', label: 'Network 2852', count: 293 }],
        [{ value: '2852', label: 'управління', count: 0 }],
      ),
    ).toEqual([{ value: '2852', label: 'управління', count: 293, values: ['2852'] }]);
  });

  it('prefers a hydrated label that adds network units', () => {
    expect(
      mergeHydratedNetworkFilterOptions(
        [{ value: '5', label: '💻', count: 293 }],
        [{ value: '5', label: '💻 4 зБпС 50 обрБпС', count: 0 }],
      ),
    ).toEqual([
      {
        value: '5',
        label: '💻 4 зБпС 50 обрБпС',
        count: 293,
        values: ['5'],
      },
    ]);
  });

  it('adds an absent hydrated network option', () => {
    expect(
      mergeHydratedNetworkFilterOptions([], [{ value: '2852', label: 'управління', count: 0 }]),
    ).toEqual([{ value: '2852', label: 'управління', count: 0 }]);
  });

  it('merges option values when both inputs provide them', () => {
    expect(
      mergeHydratedNetworkFilterOptions(
        [{ value: '2852', label: 'управління', count: 0, values: ['2852'] }],
        [{ value: '2852', label: 'управління', count: 3, values: ['2852', '2852-alt'] }],
      ),
    ).toEqual([{ value: '2852', label: 'управління', count: 3, values: ['2852', '2852-alt'] }]);
  });

  it('keeps selected-only appended options labeled but resets their count', () => {
    expect(
      replaceNetworkFilterOptionsPreservingSelectedLabels(
        [
          { value: '7', label: 'old selected', count: 9 },
          { value: '8', label: 'old unselected', count: 5 },
        ],
        [{ value: '11', label: 'new network', count: 3 }],
        ['7'],
      ),
    ).toEqual([
      { value: '11', label: 'new network', count: 3 },
      { value: '7', label: 'old selected', count: 0, values: ['7'] },
    ]);
  });

  it('uses fresh stats counts for selected options that remain in the new result set', () => {
    expect(
      replaceNetworkFilterOptionsPreservingSelectedLabels(
        [{ value: '7', label: 'old selected', count: 9 }],
        [{ value: '7', label: 'new network', count: 3 }],
        ['7'],
      ),
    ).toEqual([{ value: '7', label: 'new network', count: 3, values: ['7'] }]);
  });

  it('keeps the old real label when fresh stats fall back to a placeholder', () => {
    expect(
      replaceNetworkFilterOptionsPreservingSelectedLabels(
        [{ value: '7', label: 'old selected', count: 9 }],
        [{ value: '7', label: 'Network 7', count: 3 }],
        ['7'],
      ),
    ).toEqual([{ value: '7', label: 'old selected', count: 3, values: ['7'] }]);
  });

  it('hydrates selected network labels through reloadAnalysisData', async () => {
    const networksDeferred = deferred<Array<{ id: number; name: string; unitIds: number[] }>>();
    let currentOptions = {
      ...structuredClone(emptyOptions),
      networks: [{ value: '2852', label: 'управління 23 с6 35 омсбр 41 А', count: 293 }],
    };

    mocks.fetchAnalysisNetworks.mockResolvedValue({
      networks: [{ networkId: 2852, count: 293 }],
      networkNames: [{ id: 2852, name: 'управління 23 с6 35 омсбр 41 А' }],
    });
    mocks.fetchNetworksByIds.mockImplementationOnce(() => networksDeferred.promise);
    mocks.fetchInboxMessages.mockResolvedValue({
      inboxItems: [],
      callsigns: [{ callsign: 'alpha', res: [{ unitId: 8 }] }],
      pageLimit: 20,
    });
    mocks.fetchAnalysisFreqs.mockResolvedValue({
      freqs: [{ freq: '150.100', count: 1, isNew: false }],
    });
    mocks.fetchAnalysisCount.mockResolvedValue({});
    mocks.fetchAnalysisSummaryTable.mockResolvedValue({ rows: [] });
    mocks.fetchAnalysisMapPoints.mockResolvedValue({ points: [], networkUnits: [] });
    mocks.getUnitsList.mockResolvedValue([]);

    const setOptions = vi.fn((update) => {
      currentOptions = typeof update === 'function' ? update(currentOptions) : update;
    });

    const reloadPromise = reloadAnalysisData({
      clearAnalysisResults: vi.fn(),
      invalidateCorrelatedFreqsCache: vi.fn(),
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
        networksSelected: ['2852'],
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
      setNetworks: vi.fn(),
      setUnitsMap: vi.fn(),
      setNewCallsigns: vi.fn(),
      setHasLoadedInitialMessages: vi.fn(),
      setNewCallsignsLoading: vi.fn(),
      setNewCallsignsLoadedKey: vi.fn(),
      shouldLoadNewCallsigns: false,
      setNoMoreToLoad: vi.fn(),
      setNolimitShown: vi.fn(),
      setOptions,
      setProfiles: vi.fn(),
      setSummaryCallsignsInfo: vi.fn(),
      setSummaryLoading: vi.fn(),
      setSummaryRows: vi.fn(),
      setTagsMap: vi.fn(),
      setTagsOrder: vi.fn(),
      setTopCallsigns: vi.fn(),
      setTopFreqs: vi.fn(),
      setTopLocations: vi.fn(),
      setTopUnits: vi.fn(),
      loadInitialFilterSections: vi.fn().mockResolvedValue(undefined),
      invalidateFilterSectionLoads: vi.fn(),
    });

    await reloadPromise;
    await flushPromises();
    expect(mocks.fetchNetworksByIds).toHaveBeenCalledWith([2852], undefined);

    networksDeferred.resolve([{ id: 2852, name: 'управління', unitIds: [7] }]);
    await flushPromises();

    expect(mocks.getUnitsByIds).toHaveBeenCalledWith([7, 8], undefined);
    expect(currentOptions.networks).toEqual([
      { value: '2852', label: 'управління 23 с6 35 омсбр 41 А', count: 293, values: ['2852'] },
    ]);
  });

  it('does not load secondary data owned by visibility effects', async () => {
    mocks.fetchInboxMessages.mockResolvedValue({
      inboxItems: [[1, { networkIds: [] }]],
      callsigns: [{ callsign: 'alpha', res: [] }],
      pageLimit: 20,
    });
    mocks.fetchAnalysisFreqs.mockResolvedValue({
      freqs: [{ freq: '150.100', count: 1, isNew: false }],
    });
    mocks.fetchAnalysisCount.mockResolvedValue({});
    mocks.fetchAnalysisSummaryTable.mockResolvedValue({ rows: [] });

    await reloadAnalysisData({
      clearAnalysisResults: vi.fn(),
      invalidateCorrelatedFreqsCache: vi.fn(),
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
      setNetworks: vi.fn(),
      setUnitsMap: vi.fn(),
      setNewCallsigns: vi.fn(),
      setHasLoadedInitialMessages: vi.fn(),
      setNewCallsignsLoading: vi.fn(),
      setNewCallsignsLoadedKey: vi.fn(),
      shouldLoadNewCallsigns: true,
      setNoMoreToLoad: vi.fn(),
      setNolimitShown: vi.fn(),
      setOptions: vi.fn(),
      setProfiles: vi.fn(),
      setSummaryCallsignsInfo: vi.fn(),
      setSummaryLoading: vi.fn(),
      setSummaryRows: vi.fn(),
      setTagsMap: vi.fn(),
      setTagsOrder: vi.fn(),
      setTopCallsigns: vi.fn(),
      setTopFreqs: vi.fn(),
      setTopLocations: vi.fn(),
      setTopUnits: vi.fn(),
      loadInitialFilterSections: vi.fn().mockResolvedValue(undefined),
      invalidateFilterSectionLoads: vi.fn(),
    });

    expect(mocks.fetchAnalysisMapPoints).not.toHaveBeenCalled();
    expect(mocks.fetchAnalysisNewCallsigns).not.toHaveBeenCalled();
  });

  it('loads map points when the map center tab is visible', async () => {
    mocks.fetchInboxMessages.mockResolvedValue({
      inboxItems: [[1, { networkIds: [] }]],
      callsigns: [{ callsign: 'alpha', res: [] }],
      pageLimit: 20,
    });
    mocks.fetchAnalysisFreqs.mockResolvedValue({
      freqs: [{ freq: '150.100', count: 1, isNew: false }],
    });
    mocks.fetchAnalysisCount.mockResolvedValue({});
    mocks.fetchAnalysisSummaryTable.mockResolvedValue({ rows: [] });
    const settlements = [
      {
        settlementId: 7,
        name: 'Харків',
        region: 'Харківська',
        lat: 49.99,
        lon: 36.23,
        inboxItemCount: 3,
      },
    ];
    mocks.fetchAnalysisMapPoints.mockResolvedValue({
      points: [],
      networkUnits: [],
      settlements,
    });
    const applyMapSettlements = vi.fn();

    await reloadAnalysisData({
      clearAnalysisResults: vi.fn(),
      invalidateCorrelatedFreqsCache: vi.fn(),
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
      centerTab: 'map',
      setAorEntries: vi.fn(),
      setCounts: vi.fn(),
      setCountsLoading: vi.fn(),
      setFiltersLoading: vi.fn(),
      setGroupInfos: vi.fn(),
      setMapLoading: vi.fn(),
      setMapDateRange: vi.fn(),
      setMapNetworkUnits: vi.fn(),
      applyMapSettlements,
      setMapOpenMessages: vi.fn(),
      setMapPoints: vi.fn(),
      showSettlements: true,
      setMessages: vi.fn(),
      setMessagesLoading: vi.fn(),
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
      setTagsOrder: vi.fn(),
      setTopCallsigns: vi.fn(),
      setTopFreqs: vi.fn(),
      setTopLocations: vi.fn(),
      setTopUnits: vi.fn(),
      loadInitialFilterSections: vi.fn().mockResolvedValue(undefined),
      invalidateFilterSectionLoads: vi.fn(),
    });

    expect(mocks.fetchAnalysisMapPoints).toHaveBeenCalledTimes(1);
    expect(mocks.fetchAnalysisMapPoints.mock.calls[0][0].showSettlements).toBe(true);
    await vi.waitFor(() => expect(applyMapSettlements).toHaveBeenCalledWith(settlements, true));
  });

  it('reuses networks stats between the networks section and reference data loading in one reload', async () => {
    const queryState = buildQueryState();
    let currentOptions = structuredClone(emptyOptions);
    mocks.fetchInboxMessages.mockResolvedValue({
      inboxItems: [[1, { networkIds: [] }]],
      callsigns: [{ callsign: 'alpha', res: [] }],
      pageLimit: 20,
    });
    mocks.fetchAnalysisFreqs.mockResolvedValue({
      freqs: [{ freq: '150.100', count: 1, isNew: false }],
    });
    mocks.fetchAnalysisCount.mockResolvedValue({});
    mocks.fetchAnalysisSummaryTable.mockResolvedValue({ rows: [] });
    mocks.fetchAnalysisMapPoints.mockResolvedValue({ points: [], networkUnits: [] });
    mocks.fetchAnalysisNetworks.mockResolvedValue({
      networks: [{ networkId: 11, count: 2 }],
      networkNames: [{ id: 11, name: 'Network 11' }],
    });
    mocks.fetchNetworksByIds.mockResolvedValue([{ id: 11, name: 'Network 11' }]);
    mocks.getUnitsList.mockResolvedValue([]);

    const networksAnalysisReq = buildAnalysisReqForFilterSection(
      'networks',
      buildAnalysisReq(queryState, [])!,
    );
    const loadInitialFilterSections = vi.fn(async (_analysisReq, _plan, networkStatsCache) => {
      await loadFilterSectionData('networks', {
        analysisReq: networksAnalysisReq,
        loadVersion: 0,
        loadVersionRef: { current: 0 },
        networkStatsCache,
        queryState,
        setAorEntries: vi.fn(),
        setGroupInfos: vi.fn(),
        setNetworks: vi.fn(),
        setOptions: vi.fn(),
        setProfiles: vi.fn(),
        setTagsMap: vi.fn(),
        setTagsOrder: vi.fn(),
        unitsMap: {},
      });
    });
    const setOptions = vi.fn((update) => {
      currentOptions = typeof update === 'function' ? update(currentOptions) : update;
    });

    await reloadAnalysisData({
      clearAnalysisResults: vi.fn(),
      invalidateCorrelatedFreqsCache: vi.fn(),
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
      setMessagesLoading: vi.fn(),
      setNetworks: vi.fn(),
      setUnitsMap: vi.fn(),
      setNewCallsigns: vi.fn(),
      setHasLoadedInitialMessages: vi.fn(),
      setNewCallsignsLoading: vi.fn(),
      setNewCallsignsLoadedKey: vi.fn(),
      shouldLoadNewCallsigns: false,
      setNoMoreToLoad: vi.fn(),
      setNolimitShown: vi.fn(),
      setOptions,
      setProfiles: vi.fn(),
      setSummaryCallsignsInfo: vi.fn(),
      setSummaryLoading: vi.fn(),
      setSummaryRows: vi.fn(),
      setTagsMap: vi.fn(),
      setTagsOrder: vi.fn(),
      setTopCallsigns: vi.fn(),
      setTopFreqs: vi.fn(),
      setTopLocations: vi.fn(),
      setTopUnits: vi.fn(),
      loadInitialFilterSections,
      invalidateFilterSectionLoads: vi.fn(),
    });

    expect(mocks.fetchAnalysisNetworks).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(currentOptions.networks).toEqual([{ value: '11', label: 'Network 11', count: 2 }]);
    });
  });

  it('seeds sender profiles from inbox results before the sender filter section loads', async () => {
    mocks.fetchAnalysisCallsigns.mockResolvedValue({ callsigns: [] });
    mocks.fetchAnalysisUnits.mockResolvedValue({ units: [] });
    mocks.fetchAnalysisLocations.mockResolvedValue({ locations: [] });
    mocks.fetchInboxMessages.mockResolvedValue({
      inboxItems: [[1, { networkIds: [] }]],
      callsigns: [{ callsign: 'alpha', res: [] }],
      signalProfiles: {
        '195473172345082@lid': { givenName: 'BBC', familyName: 'SPORT' },
      },
      signalGroups: [
        {
          masterKey: '120363419907122319@g.us',
          name: 'BBC NEWS',
          ignoreOperativny: false,
          interseptionKind: 'rer',
          disableNetworkAssignment: false,
          groupStats: { activityLastDay: 0, activityLastWeek: 0 },
          adminData: null,
          areasOfResponsibility: null,
        },
      ],
      pageLimit: 20,
    });
    mocks.fetchAnalysisFreqs.mockResolvedValue({
      freqs: [{ freq: '150.100', count: 1, isNew: false }],
    });
    mocks.fetchAnalysisCount.mockResolvedValue({});
    mocks.fetchAnalysisSummaryTable.mockResolvedValue({ rows: [] });
    mocks.fetchAnalysisMapPoints.mockResolvedValue({ points: [], networkUnits: [] });

    const setProfiles = vi.fn();
    const setGroupInfos = vi.fn();

    const reloadPromise = reloadAnalysisData({
      clearAnalysisResults: vi.fn(),
      invalidateCorrelatedFreqsCache: vi.fn(),
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
      setGroupInfos,
      setMapLoading: vi.fn(),
      setMapDateRange: vi.fn(),
      setMapNetworkUnits: vi.fn(),
      setMapOpenMessages: vi.fn(),
      setMapPoints: vi.fn(),
      setMessages: vi.fn(),
      setMessagesLoading: vi.fn(),
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
      setProfiles,
      setSummaryCallsignsInfo: vi.fn(),
      setSummaryLoading: vi.fn(),
      setSummaryRows: vi.fn(),
      setTagsMap: vi.fn(),
      setTagsOrder: vi.fn(),
      setTopCallsigns: vi.fn(),
      setTopFreqs: vi.fn(),
      setTopLocations: vi.fn(),
      setTopUnits: vi.fn(),
      loadInitialFilterSections: vi.fn().mockResolvedValue(undefined),
      invalidateFilterSectionLoads: vi.fn(),
    });

    await reloadPromise;
    await flushPromises();

    expect(setProfiles).toHaveBeenCalled();
    const updater = setProfiles.mock.calls[0][0];
    expect(typeof updater).toBe('function');
    expect(updater({})).toEqual({
      '195473172345082@lid': { givenName: 'BBC', familyName: 'SPORT' },
    });
    expect(setGroupInfos).toHaveBeenCalled();
    const groupUpdater = setGroupInfos.mock.calls[0][0];
    expect(typeof groupUpdater).toBe('function');
    expect(groupUpdater({})).toEqual({
      '120363419907122319@g.us': {
        masterKey: '120363419907122319@g.us',
        name: 'BBC NEWS',
        ignoreOperativny: false,
        interseptionKind: 'rer',
        disableNetworkAssignment: false,
        groupStats: { activityLastDay: 0, activityLastWeek: 0 },
        adminData: null,
        areasOfResponsibility: null,
      },
    });
  });

  it('skips callsign-info batching when the top callsign list is empty', async () => {
    mocks.fetchAnalysisCallsigns.mockResolvedValue({ callsigns: [] });
    mocks.fetchAnalysisUnits.mockResolvedValue({ units: [] });
    mocks.fetchAnalysisLocations.mockResolvedValue({ locations: [] });
    mocks.fetchInboxMessages.mockResolvedValue({
      inboxItems: [[1, { networkIds: [] }]],
      callsigns: [{ callsign: 'alpha', res: [] }],
      pageLimit: 20,
    });
    mocks.fetchAnalysisFreqs.mockResolvedValue({
      freqs: [{ freq: '150.100', count: 1, isNew: false }],
    });
    mocks.fetchAnalysisCount.mockResolvedValue({});
    mocks.fetchAnalysisSummaryTable.mockResolvedValue({ rows: [] });
    mocks.fetchAnalysisMapPoints.mockResolvedValue({ points: [], networkUnits: [] });

    const reloadPromise = reloadAnalysisData({
      clearAnalysisResults: vi.fn(),
      invalidateCorrelatedFreqsCache: vi.fn(),
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
      setTagsOrder: vi.fn(),
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
    mocks.fetchInboxMessages.mockResolvedValue({
      inboxItems: [[1, { networkIds: [] }]],
      callsigns: [{ callsign: 'alpha', res: [] }],
      pageLimit: 20,
    });
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
      invalidateCorrelatedFreqsCache: vi.fn(),
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
      setTagsOrder: vi.fn(),
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

  it('keeps a late freqs rejection handled after an inbox abort returns first', async () => {
    const inboxDeferred = deferred<ReloadInboxRsp>();
    const freqsDeferred = deferred<{
      freqs: Array<{ freq: string; count: number; isNew: boolean }>;
    }>();

    mocks.fetchInboxMessages.mockImplementationOnce(() => inboxDeferred.promise);
    mocks.fetchAnalysisFreqs.mockImplementationOnce(() => freqsDeferred.promise);
    mocks.fetchAnalysisCount.mockResolvedValue({});
    mocks.fetchAnalysisSummaryTable.mockResolvedValue({ rows: [] });
    mocks.fetchAnalysisMapPoints.mockResolvedValue({ points: [], networkUnits: [] });

    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const reloadPromise = reloadAnalysisData({
        clearAnalysisResults: vi.fn(),
        invalidateCorrelatedFreqsCache: vi.fn(),
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
        setTagsOrder: vi.fn(),
        setTopCallsigns: vi.fn(),
        setTopFreqs: vi.fn(),
        setTopLocations: vi.fn(),
        setTopUnits: vi.fn(),
        loadInitialFilterSections: vi.fn().mockResolvedValue(undefined),
        invalidateFilterSectionLoads: vi.fn(),
      });

      await flushPromises();

      inboxDeferred.reject(new DOMException('Aborted', 'AbortError'));
      freqsDeferred.reject(new Error('freqs aborted later'));

      await reloadPromise;
      await flushPromises();

      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('falls back to previously loaded lazy sections when no targeted invalidation is pending', async () => {
    mocks.fetchInboxMessages.mockResolvedValue({
      inboxItems: [[1, { networkIds: [] }]],
      callsigns: [{ callsign: 'alpha', res: [] }],
      pageLimit: 20,
    });
    mocks.fetchAnalysisFreqs.mockResolvedValue({
      freqs: [{ freq: '150.100', count: 1, isNew: false }],
    });
    mocks.fetchAnalysisCount.mockResolvedValue({});
    mocks.fetchAnalysisSummaryTable.mockResolvedValue({ rows: [] });
    mocks.fetchAnalysisMapPoints.mockResolvedValue({ points: [], networkUnits: [] });
    mocks.fetchAnalysisNetworks.mockResolvedValue({ networks: [], networkNames: [] });
    mocks.getUnitsList.mockResolvedValue([]);
    mocks.fetchNetworksByIds.mockResolvedValue([]);

    const getLoadedFilterSections = vi.fn(
      () => ['units', 'locations', 'posts'] as AnalysisFilterSectionId[],
    );
    const getReloadFilterSections = vi.fn(() => null);
    const loadInitialFilterSections = vi.fn().mockResolvedValue(undefined);

    await reloadAnalysisData({
      clearAnalysisResults: vi.fn(),
      invalidateCorrelatedFreqsCache: vi.fn(),
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
      setTagsOrder: vi.fn(),
      setTopCallsigns: vi.fn(),
      setTopFreqs: vi.fn(),
      setTopLocations: vi.fn(),
      setTopUnits: vi.fn(),
      getLoadedFilterSections,
      getReloadFilterSections,
      loadInitialFilterSections,
      invalidateFilterSectionLoads: vi.fn(),
    });

    expect(getReloadFilterSections).toHaveBeenCalledTimes(1);
    expect(getLoadedFilterSections).toHaveBeenCalledTimes(1);
    expect(loadInitialFilterSections).toHaveBeenCalledWith(
      expect.any(Object),
      {
        mode: 'full',
        sectionsToReload: ['tags', 'groups', 'senders'],
        loadedSections: ['units', 'locations', 'posts'],
        selectedSections: [],
      },
      expect.any(Map),
      undefined,
    );
  });

  it('does not fall back when targeted invalidation resolved to an empty reload set', async () => {
    mocks.fetchInboxMessages.mockResolvedValue({
      inboxItems: [[1, { networkIds: [] }]],
      callsigns: [{ callsign: 'alpha', res: [] }],
      pageLimit: 20,
    });
    mocks.fetchAnalysisFreqs.mockResolvedValue({
      freqs: [{ freq: '150.100', count: 1, isNew: false }],
    });
    mocks.fetchAnalysisCount.mockResolvedValue({});
    mocks.fetchAnalysisSummaryTable.mockResolvedValue({ rows: [] });
    mocks.fetchAnalysisMapPoints.mockResolvedValue({ points: [], networkUnits: [] });
    mocks.fetchAnalysisNetworks.mockResolvedValue({ networks: [], networkNames: [] });
    mocks.getUnitsList.mockResolvedValue([]);
    mocks.fetchNetworksByIds.mockResolvedValue([]);

    const getLoadedFilterSections = vi.fn(
      () => ['units', 'locations', 'posts'] as AnalysisFilterSectionId[],
    );
    const getReloadFilterSections = vi.fn(() => []);
    const loadInitialFilterSections = vi.fn().mockResolvedValue(undefined);

    await reloadAnalysisData({
      clearAnalysisResults: vi.fn(),
      invalidateCorrelatedFreqsCache: vi.fn(),
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
      setTagsOrder: vi.fn(),
      setTopCallsigns: vi.fn(),
      setTopFreqs: vi.fn(),
      setTopLocations: vi.fn(),
      setTopUnits: vi.fn(),
      getLoadedFilterSections,
      getReloadFilterSections,
      loadInitialFilterSections,
      invalidateFilterSectionLoads: vi.fn(),
    });

    expect(getReloadFilterSections).toHaveBeenCalledTimes(1);
    expect(getLoadedFilterSections).not.toHaveBeenCalled();
    expect(loadInitialFilterSections).toHaveBeenCalledWith(
      expect.any(Object),
      {
        mode: 'targeted',
        sectionsToReload: [],
      },
      expect.any(Map),
      undefined,
    );
  });

  it('uses the full initial filter plan when no loaded sections were targeted by a patch', async () => {
    mocks.fetchInboxMessages.mockResolvedValue({
      inboxItems: [[1, { networkIds: [] }]],
      callsigns: [{ callsign: 'alpha', res: [] }],
      pageLimit: 20,
    });
    mocks.fetchAnalysisFreqs.mockResolvedValue({
      freqs: [{ freq: '150.100', count: 1, isNew: false }],
    });
    mocks.fetchAnalysisCount.mockResolvedValue({});
    mocks.fetchAnalysisSummaryTable.mockResolvedValue({ rows: [] });
    mocks.fetchAnalysisMapPoints.mockResolvedValue({ points: [], networkUnits: [] });
    mocks.fetchAnalysisNetworks.mockResolvedValue({ networks: [], networkNames: [] });
    mocks.getUnitsList.mockResolvedValue([]);
    mocks.fetchNetworksByIds.mockResolvedValue([]);

    const getLoadedFilterSections = vi.fn(() => [] as AnalysisFilterSectionId[]);
    const getReloadFilterSections = vi.fn(() => null);
    const loadInitialFilterSections = vi.fn().mockResolvedValue(undefined);

    await reloadAnalysisData({
      clearAnalysisResults: vi.fn(),
      invalidateCorrelatedFreqsCache: vi.fn(),
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
        unitsSelected: ['u1'],
        callsignsSelected: ['c1'],
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
      setTagsOrder: vi.fn(),
      setTopCallsigns: vi.fn(),
      setTopFreqs: vi.fn(),
      setTopLocations: vi.fn(),
      setTopUnits: vi.fn(),
      getLoadedFilterSections,
      getReloadFilterSections,
      loadInitialFilterSections,
      invalidateFilterSectionLoads: vi.fn(),
    });

    expect(getReloadFilterSections).toHaveBeenCalledTimes(1);
    expect(getLoadedFilterSections).toHaveBeenCalledTimes(1);
    expect(loadInitialFilterSections).toHaveBeenCalledWith(
      expect.any(Object),
      {
        mode: 'full',
        sectionsToReload: ['tags', 'groups', 'senders', 'callsigns', 'units'],
        loadedSections: [],
        selectedSections: ['callsigns', 'units'],
      },
      expect.any(Map),
      undefined,
    );
  });

  it('uses targeted reload sections when they are present', async () => {
    mocks.fetchInboxMessages.mockResolvedValue({
      inboxItems: [[1, { networkIds: [] }]],
      callsigns: [{ callsign: 'alpha', res: [] }],
      pageLimit: 20,
    });
    mocks.fetchAnalysisFreqs.mockResolvedValue({
      freqs: [{ freq: '150.100', count: 1, isNew: false }],
    });
    mocks.fetchAnalysisCount.mockResolvedValue({});
    mocks.fetchAnalysisSummaryTable.mockResolvedValue({ rows: [] });
    mocks.fetchAnalysisMapPoints.mockResolvedValue({ points: [], networkUnits: [] });
    mocks.fetchAnalysisNetworks.mockResolvedValue({ networks: [], networkNames: [] });
    mocks.getUnitsList.mockResolvedValue([]);
    mocks.fetchNetworksByIds.mockResolvedValue([]);

    const getLoadedFilterSections = vi.fn(
      () => ['units', 'locations', 'posts'] as AnalysisFilterSectionId[],
    );
    const getReloadFilterSections = vi.fn(() => ['units'] as AnalysisFilterSectionId[]);
    const loadInitialFilterSections = vi.fn().mockResolvedValue(undefined);

    await reloadAnalysisData({
      clearAnalysisResults: vi.fn(),
      invalidateCorrelatedFreqsCache: vi.fn(),
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
      setTagsOrder: vi.fn(),
      setTopCallsigns: vi.fn(),
      setTopFreqs: vi.fn(),
      setTopLocations: vi.fn(),
      setTopUnits: vi.fn(),
      getLoadedFilterSections,
      getReloadFilterSections,
      loadInitialFilterSections,
      invalidateFilterSectionLoads: vi.fn(),
    });

    expect(getReloadFilterSections).toHaveBeenCalledTimes(1);
    expect(getLoadedFilterSections).not.toHaveBeenCalled();
    expect(loadInitialFilterSections).toHaveBeenCalledWith(
      expect.any(Object),
      {
        mode: 'targeted',
        sectionsToReload: ['units'],
      },
      expect.any(Map),
      undefined,
    );
  });

  it('keeps deferred panel data intact when the critical inbox request fails early', async () => {
    mocks.fetchInboxMessages.mockRejectedValue(new Error('inbox failed'));
    mocks.fetchAnalysisFreqs.mockResolvedValue({ freqs: [] });
    mocks.fetchAnalysisCount.mockResolvedValue({});

    const invalidateSummaryLoads = vi.fn();
    const invalidateTopSidebarLoads = vi.fn();
    const setSummaryRows = vi.fn();
    const setTopCallsigns = vi.fn();
    const setTopFreqs = vi.fn();
    const setTopLocations = vi.fn();
    const setTopUnits = vi.fn();

    await reloadAnalysisData({
      clearAnalysisResults: vi.fn(),
      invalidateCorrelatedFreqsCache: vi.fn(),
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
      setSummaryRows,
      setTagsMap: vi.fn(),
      setTagsOrder: vi.fn(),
      setTopCallsigns,
      setTopFreqs,
      setTopLocations,
      setTopUnits,
      loadInitialFilterSections: vi.fn().mockResolvedValue(undefined),
      invalidateFilterSectionLoads: vi.fn(),
      invalidateSummaryLoads,
      invalidateTopSidebarLoads,
    });

    expect(invalidateSummaryLoads).not.toHaveBeenCalled();
    expect(invalidateTopSidebarLoads).not.toHaveBeenCalled();
    expect(setSummaryRows).not.toHaveBeenCalledWith([]);
    expect(setTopCallsigns).not.toHaveBeenCalledWith([]);
    expect(setTopFreqs).not.toHaveBeenCalledWith([]);
    expect(setTopLocations).not.toHaveBeenCalledWith([]);
    expect(setTopUnits).not.toHaveBeenCalledWith([]);
  });

  it('invalidates pending new callsign loads when the query state cannot be built', async () => {
    const clearAnalysisResults = vi.fn();
    const invalidateSummaryLoads = vi.fn();
    const invalidateTopSidebarLoads = vi.fn();
    const setNewCallsignsLoading = vi.fn();
    const newCallsignsRequestRef = { current: 9 };
    const newCallsignsLoadedKeyRef = { current: 'loaded-key' };
    const newCallsignsPendingKeyRef = { current: 'pending-key' };

    await reloadAnalysisData({
      clearAnalysisResults,
      invalidateCorrelatedFreqsCache: vi.fn(),
      invalidateCallsignGraph: vi.fn(),
      invalidateMessagePaging: vi.fn(),
      newestFirst: true,
      onError: vi.fn(),
      onUnauthorized: vi.fn().mockReturnValue(false),
      optionsFreqsRef: { current: [] },
      queryState: {
        ...emptyQueryState(),
        fromDateTimeStr: 'invalid',
        toDateTimeStr: '2026-04-02T00:00',
      },
      reloadRequestRef: { current: 0 },
      newCallsignsRequestRef,
      newCallsignsLoadedKeyRef,
      newCallsignsPendingKeyRef,
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
      setNetworks: vi.fn(),
      setUnitsMap: vi.fn(),
      setNewCallsigns: vi.fn(),
      setHasLoadedInitialMessages: vi.fn(),
      setNewCallsignsLoading,
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
      setTagsOrder: vi.fn(),
      setTopCallsigns: vi.fn(),
      setTopFreqs: vi.fn(),
      setTopLocations: vi.fn(),
      setTopUnits: vi.fn(),
      invalidateSummaryLoads,
      invalidateTopSidebarLoads,
      loadInitialFilterSections: vi.fn().mockResolvedValue(undefined),
      invalidateFilterSectionLoads: vi.fn(),
    });

    expect(invalidateSummaryLoads).toHaveBeenCalledTimes(1);
    expect(invalidateTopSidebarLoads).toHaveBeenCalledTimes(1);
    expect(clearAnalysisResults).toHaveBeenCalledTimes(1);
    expect(setNewCallsignsLoading).toHaveBeenCalledWith(false);
    expect(newCallsignsRequestRef.current).toBe(10);
    expect(newCallsignsLoadedKeyRef.current).toBeNull();
    expect(newCallsignsPendingKeyRef.current).toBeNull();
  });
});
