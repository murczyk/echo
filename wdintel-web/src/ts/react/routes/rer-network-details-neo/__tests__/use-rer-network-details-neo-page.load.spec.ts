/**
 * @vitest-environment happy-dom
 */
import { act, createElement, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  KnownCallsignShortRes,
  ListNetworkPointsRsp,
  NetworkCallsign,
  NetworkCallsignRes,
  Source,
} from '../../../../../Bindings';
import { NO_DATA_LABEL } from '../../../utils/misc';
import {
  EMPTY_STATE,
  type NetworkDetailsNeoPageState,
} from '../use-rer-network-details-neo-page.types';
import {
  derivePelengEnabledFreqs,
  deriveRelationsEnabledFreqs,
  useRerNetworkDetailsNeoPageLoad,
  type CallsignsLoadPeriods,
} from '../use-rer-network-details-neo-page.load';
import { excludeNetworkOwnedInterceptedCallsigns } from '../network-callsigns.tab';

const callsignsApiMock = vi.hoisted(() => ({
  listNetworkCallsigns: vi.fn(),
  getNetworkCallsigns: vi.fn(),
  getNetworkCallsignsActivity: vi.fn(),
  listSources: vi.fn(),
}));

const otherApiMocks = vi.hoisted(() => ({
  listAors: vi.fn(),
  getNetworkById: vi.fn(),
  getNetworkCallsignRelations: vi.fn(),
  getNetworkGroupsActivityOne: vi.fn(),
  listNetworkPoints: vi.fn(),
  getEncryptions: vi.fn(),
  getUnitsList: vi.fn(),
  getUnitsByIds: vi.fn(),
  listPosts: vi.fn(),
  fetchCurrentUser: vi.fn(),
}));

vi.mock('../../../services/api/callsigns', () => callsignsApiMock);
vi.mock('../../../services/api/aor', () => ({ listAors: otherApiMocks.listAors }));
vi.mock('../../../services/api/networks', () => ({
  getNetworkById: otherApiMocks.getNetworkById,
  getNetworkCallsignRelations: otherApiMocks.getNetworkCallsignRelations,
  getNetworkGroupsActivityOne: otherApiMocks.getNetworkGroupsActivityOne,
  listNetworkPoints: otherApiMocks.listNetworkPoints,
}));
vi.mock('../../../services/api/encryptions', () => ({
  getEncryptions: otherApiMocks.getEncryptions,
}));
vi.mock('../../../services/api/units', () => ({
  getUnitsList: otherApiMocks.getUnitsList,
  getUnitsByIds: otherApiMocks.getUnitsByIds,
  mergeUnitsById: (...unitLists: Array<Array<{ id: number }>>) => {
    const unitsById = new Map<number, { id: number }>();
    unitLists.flat().forEach((unit) => unitsById.set(unit.id, unit));
    return Array.from(unitsById.values());
  },
}));
vi.mock('../../../services/api/posts', () => ({ listPosts: otherApiMocks.listPosts }));
vi.mock('../../../services/api/user', () => ({ fetchCurrentUser: otherApiMocks.fetchCurrentUser }));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    promise,
    resolve,
    reject,
  };
}

const rendered: Root[] = [];
let latestState: NetworkDetailsNeoPageState | null = null;
let latestLoadNetworkCallsignStats:
  ReturnType<typeof useRerNetworkDetailsNeoPageLoad>['loadNetworkCallsignStats'] | null = null;
let latestLoadCallsigns:
  ((networkId: number, periods?: CallsignsLoadPeriods) => Promise<void>) | null = null;
let latestLoadPelengPoints:
  ReturnType<typeof useRerNetworkDetailsNeoPageLoad>['loadPelengPoints'] | null = null;
let latestSetState: Dispatch<SetStateAction<NetworkDetailsNeoPageState>> | null = null;

function createKnownCallsign(
  overrides: Partial<KnownCallsignShortRes> = {},
): KnownCallsignShortRes {
  return {
    id: 20,
    callsign: 'Барс-4',
    position: 'ЗКМ',
    comment: 'Збiг',
    fullName: '',
    unitId: 201,
    unitName: 'арт. дивізіон',
    sourceName: 'Каталог 2024',
    createdAt: 1710100000000,
    ...overrides,
  };
}

function createCallsignGroup(
  overrides: Partial<NetworkCallsignRes> & { knownCallsigns?: KnownCallsignShortRes[] } = {},
): NetworkCallsignRes {
  return {
    callsign: 'барс-4',
    knownCallsigns: [],
    messageCount: 8,
    lastDatetime: 1710200000000,
    networkNames: null,
    isOld: false,
    isInDictionary: false,
    freqs: ['145.2000'],
    ...overrides,
  };
}

function HookHarness({ stateSeed = EMPTY_STATE }: { stateSeed?: NetworkDetailsNeoPageState }) {
  const reloadGeneration = useRef(1);
  const [state, setState] = useState<NetworkDetailsNeoPageState>(stateSeed);
  const pageLoad = useRerNetworkDetailsNeoPageLoad(42, setState, reloadGeneration);

  latestState = state;
  latestLoadCallsigns = pageLoad.loadCallsigns;
  latestLoadNetworkCallsignStats = pageLoad.loadNetworkCallsignStats;
  latestLoadPelengPoints = pageLoad.loadPelengPoints;
  latestSetState = setState;

  return null;
}

function renderHookHarness(stateSeed: NetworkDetailsNeoPageState = EMPTY_STATE) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  rendered.push(root);

  act(() => {
    root.render(createElement(HookHarness, { stateSeed }));
  });
}

afterEach(() => {
  for (const root of rendered.splice(0)) {
    act(() => {
      root.unmount();
    });
  }
  latestState = null;
  latestLoadCallsigns = null;
  latestLoadNetworkCallsignStats = null;
  latestLoadPelengPoints = null;
  latestSetState = null;
  callsignsApiMock.listNetworkCallsigns.mockReset();
  callsignsApiMock.getNetworkCallsigns.mockReset();
  callsignsApiMock.getNetworkCallsignsActivity.mockReset();
  callsignsApiMock.listSources.mockReset();
  otherApiMocks.listAors.mockReset();
  otherApiMocks.getNetworkById.mockReset();
  otherApiMocks.getNetworkCallsignRelations.mockReset();
  otherApiMocks.getNetworkGroupsActivityOne.mockReset();
  otherApiMocks.listNetworkPoints.mockReset();
  otherApiMocks.getEncryptions.mockReset();
  otherApiMocks.getUnitsList.mockReset();
  otherApiMocks.getUnitsByIds.mockReset();
  otherApiMocks.listPosts.mockReset();
  otherApiMocks.fetchCurrentUser.mockReset();
});

it.each(['success', 'failure'] as const)(
  '#2133 ignores an in-flight map %s after location edits invalidate its cache',
  async (outcome) => {
    installDefaultApiMocks();
    const response = createDeferred<ListNetworkPointsRsp>();
    otherApiMocks.listNetworkPoints.mockReturnValueOnce(response.promise);
    renderHookHarness();
    let pending: Promise<void> | undefined;
    act(() => {
      pending = latestLoadPelengPoints?.(42, 0, null);
    });
    act(() => {
      latestSetState?.((current) => ({
        ...current,
        networkSettlements: [],
        pelengPointsLoaded: false,
        pelengPointsLoading: false,
        pelengPointsRequestedFrom: null,
        pelengPointsRequestedTo: null,
      }));
    });
    await act(async () => {
      if (outcome === 'success') {
        response.resolve({
          points: [],
          settlements: [{ id: 1, name: 'Old location', lat: 49, lng: 35 }],
          settlementsPending: false,
        });
      } else {
        response.reject(new Error('Stale request failed'));
      }
      await pending;
    });
    expect(latestState?.networkSettlements).toEqual([]);
    expect(latestState?.pelengPointsLoaded).toBe(false);
    expect(latestState?.pelengPointsError).toBeNull();
  },
);

function installDefaultApiMocks() {
  otherApiMocks.fetchCurrentUser.mockResolvedValue({ roles: ['Rer'] });
  otherApiMocks.getNetworkById.mockResolvedValue({
    id: 42,
    name: 'Мережа 42',
    descriptions: [],
    aorIds: [],
    unitIds: [],
    postIds: [],
    freqs: [],
  });
  otherApiMocks.listAors.mockResolvedValue([]);
  otherApiMocks.getEncryptions.mockResolvedValue([]);
  otherApiMocks.getUnitsList.mockResolvedValue([]);
  otherApiMocks.getUnitsByIds.mockResolvedValue([]);
  otherApiMocks.listPosts.mockResolvedValue([]);
  otherApiMocks.getNetworkCallsignRelations.mockResolvedValue({ nodes: [], edges: [], freqs: [] });
  otherApiMocks.getNetworkGroupsActivityOne.mockResolvedValue({});
  otherApiMocks.listNetworkPoints.mockResolvedValue({ points: [] });
  callsignsApiMock.listNetworkCallsigns.mockResolvedValue({ networkCallsigns: [] });
  callsignsApiMock.getNetworkCallsigns.mockResolvedValue({ callsigns: [] });
  callsignsApiMock.getNetworkCallsignsActivity.mockResolvedValue({ callsignsActivity: [] });
  callsignsApiMock.listSources.mockResolvedValue([]);
}
describe('use-rer-network-details-neo-page.load', () => {
  it('keeps blank frequencies enabled after load', () => {
    expect(
      derivePelengEnabledFreqs([], [{ freq: '   ' }, { freq: '146.5000' }, { freq: '146.5000' }]),
    ).toEqual(['146.5000', NO_DATA_LABEL]);
  });

  it('falls back to all loaded peleng frequencies when nothing stays enabled', () => {
    expect(derivePelengEnabledFreqs(['149.0000'], [{ freq: '   ' }, { freq: '146.5000' }])).toEqual(
      ['146.5000', NO_DATA_LABEL],
    );
  });

  it('falls back to the loaded relation frequencies when the selection is empty', () => {
    expect(
      deriveRelationsEnabledFreqs([], null, {
        freqs: [
          { freq: '652.111', enabledByDefault: true },
          { freq: '852.111', enabledByDefault: false },
        ],
        nodes: [],
        edges: [],
      }),
    ).toEqual(['652.111']);
  });

  it('resets automatic relation frequency selections for a new date range', () => {
    expect(
      deriveRelationsEnabledFreqs(
        ['652.111'],
        null,
        {
          freqs: [
            { freq: '652.111', enabledByDefault: true },
            { freq: '852.111', enabledByDefault: true },
          ],
          nodes: [],
          edges: [],
        },
        false,
      ),
    ).toEqual(['652.111', '852.111']);
  });

  it('loads Everything once when catalog and intercepted periods match', async () => {
    installDefaultApiMocks();
    renderHookHarness();

    const networkCallsignsDeferred = createDeferred<{ networkCallsigns: NetworkCallsign[] }>();
    const sourcesDeferred = createDeferred<Source[]>();
    const candidatesDeferred = createDeferred<{ callsigns: NetworkCallsignRes[] }>();

    callsignsApiMock.listNetworkCallsigns.mockReturnValue(networkCallsignsDeferred.promise);
    callsignsApiMock.listSources.mockReturnValue(sourcesDeferred.promise);
    callsignsApiMock.getNetworkCallsigns.mockReturnValue(candidatesDeferred.promise);

    await act(async () => {
      void latestLoadCallsigns?.(42);
    });

    expect(callsignsApiMock.getNetworkCallsigns).toHaveBeenCalledTimes(1);
    expect(callsignsApiMock.getNetworkCallsigns).toHaveBeenCalledWith({
      networkId: 42,
      includeActivityInfo: true,
      section: 'Everything',
      period: 'Last21Days',
    });
    expect(latestState?.catalogCallsignsLoading).toBe(true);
    expect(latestState?.interceptedCallsignsLoading).toBe(true);

    await act(async () => {
      candidatesDeferred.resolve({
        callsigns: [
          createCallsignGroup({
            callsign: 'БАРС-4',
            knownCallsigns: [createKnownCallsign()],
          }),
          createCallsignGroup({
            callsign: 'СОКІЛ-1',
            knownCallsigns: [],
          }),
        ],
      });
      await Promise.resolve();
    });

    expect(latestState?.catalogCallsignsLoaded).toBe(true);
    expect(latestState?.interceptedCallsignsLoaded).toBe(true);
    expect(latestState?.catalogCallsignGroups.map((group) => group.callsign)).toEqual(['БАРС-4']);
    expect(latestState?.unknownInterceptedCallsigns.map((group) => group.callsign)).toEqual([
      'СОКІЛ-1',
    ]);

    await act(async () => {
      sourcesDeferred.resolve([]);
      networkCallsignsDeferred.resolve({ networkCallsigns: [] });
      await Promise.resolve();
    });

    expect(latestState?.callsignsLoaded).toBe(true);
    expect(latestState?.callsignsLoading).toBe(false);
  });

  it('loads Catalog and Intercepted separately when periods differ', async () => {
    installDefaultApiMocks();
    renderHookHarness();

    const catalogDeferred = createDeferred<{ callsigns: NetworkCallsignRes[] }>();
    const interceptedDeferred = createDeferred<{ callsigns: NetworkCallsignRes[] }>();

    callsignsApiMock.getNetworkCallsigns.mockImplementation((req: { section: string }) => {
      if (req.section === 'Catalog') return catalogDeferred.promise;
      if (req.section === 'Intercepted') return interceptedDeferred.promise;
      return Promise.resolve({ callsigns: [] });
    });

    await act(async () => {
      void latestLoadCallsigns?.(42, {
        catalog: 'Last7Days',
        intercepted: 'Last21Days',
      });
    });

    expect(callsignsApiMock.getNetworkCallsigns).toHaveBeenCalledWith({
      networkId: 42,
      includeActivityInfo: true,
      section: 'Catalog',
      period: 'Last7Days',
    });
    expect(callsignsApiMock.getNetworkCallsigns).toHaveBeenCalledWith({
      networkId: 42,
      includeActivityInfo: true,
      section: 'Intercepted',
      period: 'Last21Days',
    });
    expect(callsignsApiMock.listNetworkCallsigns).not.toHaveBeenCalled();

    await act(async () => {
      catalogDeferred.resolve({ callsigns: [] });
      interceptedDeferred.resolve({ callsigns: [] });
      await Promise.resolve();
    });
  });

  it('keeps network-owned rows visible when candidate loading fails', async () => {
    installDefaultApiMocks();
    renderHookHarness();

    const networkCallsignsDeferred = createDeferred<{ networkCallsigns: NetworkCallsign[] }>();
    const sourcesDeferred = createDeferred<Source[]>();

    callsignsApiMock.listNetworkCallsigns.mockReturnValue(networkCallsignsDeferred.promise);
    callsignsApiMock.listSources.mockReturnValue(sourcesDeferred.promise);
    callsignsApiMock.getNetworkCallsigns.mockRejectedValue(new Error('candidate failed'));
    callsignsApiMock.getNetworkCallsignsActivity.mockResolvedValue({ callsignsActivity: [] });

    await act(async () => {
      void latestLoadCallsigns?.(42);
      await Promise.resolve();
    });

    expect(latestState?.catalogCallsignsLoaded).toBe(false);
    expect(latestState?.catalogCallsignsLoading).toBe(false);
    expect(latestState?.catalogCallsignsError).toContain('candidate failed');
    expect(latestState?.interceptedCallsignsLoaded).toBe(false);
    expect(latestState?.interceptedCallsignsLoading).toBe(false);
    expect(latestState?.interceptedCallsignsError).toContain('candidate failed');
    expect(latestState?.callsignsError).toContain('candidate failed');
    expect(latestState?.networkCallsignsLoading).toBe(true);
    expect(latestState?.networkCallsignsLoaded).toBe(false);
    expect(callsignsApiMock.getNetworkCallsignsActivity).toHaveBeenCalledTimes(0);

    await act(async () => {
      sourcesDeferred.resolve([]);
      networkCallsignsDeferred.resolve({
        networkCallsigns: [{ id: 1, callsign: 'СОКІЛ-1' } as NetworkCallsign],
      });
      await Promise.resolve();
    });

    expect(latestState?.networkCallsignsLoaded).toBe(true);
    expect(latestState?.networkCallsignsLoading).toBe(false);
    expect(latestState?.networkCallsigns.map((item) => item.callsign)).toEqual(['СОКІЛ-1']);
    expect(latestState?.callsignsLoaded).toBe(false);
  });

  describe('network list and stats stages', () => {
    const ROW = { id: 1, callsign: 'СОКІЛ-1', messageCount: 0 } as NetworkCallsign;
    type ListReq = { includeActivityInfo: boolean; period: string | null };

    function mockListAndStats(statsResponse: Promise<{ networkCallsigns: NetworkCallsign[] }>) {
      callsignsApiMock.listSources.mockResolvedValue([]);
      callsignsApiMock.listNetworkCallsigns.mockImplementation((req: ListReq) =>
        req.includeActivityInfo ? statsResponse : Promise.resolve({ networkCallsigns: [ROW] }),
      );
    }

    async function flush() {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    it('shows the full list before its stats arrive', async () => {
      installDefaultApiMocks();
      renderHookHarness();
      const stats = createDeferred<{ networkCallsigns: NetworkCallsign[] }>();
      mockListAndStats(stats.promise);

      await act(async () => {
        void latestLoadCallsigns?.(42, { network: 'Last21Days' });
      });
      await flush();

      expect(callsignsApiMock.listNetworkCallsigns).toHaveBeenCalledWith({
        networkId: 42,
        sortBy: ['NetworkCallsignAsc'],
        period: null,
        includeActivityInfo: false,
      });
      expect(callsignsApiMock.listNetworkCallsigns).toHaveBeenCalledWith({
        networkId: 42,
        sortBy: ['NetworkCallsignAsc'],
        period: 'Last21Days',
        includeActivityInfo: true,
      });
      expect(latestState?.networkCallsigns).toEqual([ROW]);
      expect(latestState?.networkCallsignsLoaded).toBe(true);
      expect(latestState?.networkCallsignsLoading).toBe(false);
      expect(latestState?.networkCallsignStatsLoading).toBe(true);
      expect(latestState?.networkCallsignStatsPeriod).toBe('Last21Days');

      await act(async () => {
        stats.resolve({ networkCallsigns: [{ ...ROW, messageCount: 5 }] });
      });
      await flush();

      expect(latestState?.networkCallsignStatsLoading).toBe(false);
      expect(latestState?.networkCallsignStats.get(1)?.messageCount).toBe(5);
    });

    it('forgets locally added rows once a new stats request can see them', async () => {
      installDefaultApiMocks();
      renderHookHarness({ ...EMPTY_STATE, networkCallsignsAddedSinceStats: new Set([7]) });
      mockListAndStats(Promise.resolve({ networkCallsigns: [] }));

      await act(async () => {
        void latestLoadNetworkCallsignStats?.(42, 'Last21Days');
      });
      await flush();

      expect(latestState?.networkCallsignsAddedSinceStats.size).toBe(0);
    });

    it('keeps the list and reports a stats failure separately', async () => {
      installDefaultApiMocks();
      renderHookHarness();
      mockListAndStats(Promise.reject(new Error('stats failed')));

      await act(async () => {
        void latestLoadCallsigns?.(42, { network: 'Last21Days' });
      });
      await flush();

      expect(latestState?.networkCallsigns).toEqual([ROW]);
      expect(latestState?.networkCallsignsError).toBeNull();
      expect(latestState?.networkCallsignStatsLoading).toBe(false);
      expect(latestState?.networkCallsignStatsError).toContain('stats failed');
    });

    it('ignores a stats response superseded by a newer window', async () => {
      installDefaultApiMocks();
      renderHookHarness();
      const slow = createDeferred<{ networkCallsigns: NetworkCallsign[] }>();
      const fast = createDeferred<{ networkCallsigns: NetworkCallsign[] }>();
      callsignsApiMock.listNetworkCallsigns.mockImplementation((req: ListReq) =>
        req.period === 'Unlimited' ? slow.promise : fast.promise,
      );

      await act(async () => {
        void latestLoadNetworkCallsignStats?.(42, 'Unlimited');
        void latestLoadNetworkCallsignStats?.(42, 'Last7Days');
      });
      await act(async () => {
        fast.resolve({ networkCallsigns: [{ ...ROW, messageCount: 7 }] });
      });
      await flush();
      await act(async () => {
        slow.resolve({ networkCallsigns: [{ ...ROW, messageCount: 900 }] });
      });
      await flush();

      expect(latestState?.networkCallsignStatsPeriod).toBe('Last7Days');
      expect(latestState?.networkCallsignStats.get(1)?.messageCount).toBe(7);
    });
  });

  it('hides network-owned intercepted rows at display time without discarding payload', () => {
    const intercepted = [
      {
        callsign: 'СОКІЛ-1',
        messageCount: 5,
        lastDatetime: 1710000000000,
        freqs: ['145.1000'],
        isOld: false,
        isInDictionary: false,
        activity: null,
      },
      {
        callsign: 'ГІЄНА-4',
        messageCount: 9,
        lastDatetime: 1710300000000,
        freqs: ['145.3000'],
        isOld: false,
        isInDictionary: false,
        activity: null,
      },
    ];

    expect(
      excludeNetworkOwnedInterceptedCallsigns(intercepted, [
        { id: 1, callsign: 'сокіл-1' } as NetworkCallsign,
      ]).map((item) => item.callsign),
    ).toEqual(['ГІЄНА-4']);

    // Empty ownership (e.g. truly empty network) must not be confused mid-reload:
    // loadNetworkCallsigns keeps the previous list until a replacement succeeds.
    expect(
      excludeNetworkOwnedInterceptedCallsigns(intercepted, []).map((item) => item.callsign),
    ).toEqual(['СОКІЛ-1', 'ГІЄНА-4']);
  });
});
