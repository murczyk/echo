/**
 * @vitest-environment happy-dom
 */
import { act, createElement, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  KnownCallsignShortRes,
  NetworkCallsign,
  NetworkCallsignRes,
  Source,
} from '../../../../Bindings';
import { NO_DATA_LABEL } from '../../utils/misc';
import {
  EMPTY_STATE,
  type NetworkDetailsNeoPageState,
} from './use-rer-network-details-neo-page.types';
import {
  derivePelengEnabledFreqs,
  deriveRelationsEnabledFreqs,
  useRerNetworkDetailsNeoPageLoad,
} from './use-rer-network-details-neo-page.load';

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
  listPosts: vi.fn(),
  fetchCurrentUser: vi.fn(),
}));

vi.mock('../../services/api/callsigns', () => callsignsApiMock);
vi.mock('../../services/api/aor', () => ({ listAors: otherApiMocks.listAors }));
vi.mock('../../services/api/networks', () => ({
  getNetworkById: otherApiMocks.getNetworkById,
  getNetworkCallsignRelations: otherApiMocks.getNetworkCallsignRelations,
  getNetworkGroupsActivityOne: otherApiMocks.getNetworkGroupsActivityOne,
  listNetworkPoints: otherApiMocks.listNetworkPoints,
}));
vi.mock('../../services/api/encryptions', () => ({ getEncryptions: otherApiMocks.getEncryptions }));
vi.mock('../../services/api/units', () => ({ getUnitsList: otherApiMocks.getUnitsList }));
vi.mock('../../services/api/posts', () => ({ listPosts: otherApiMocks.listPosts }));
vi.mock('../../services/api/user', () => ({ fetchCurrentUser: otherApiMocks.fetchCurrentUser }));

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
let latestLoadCallsigns: ((networkId: number) => Promise<void>) | null = null;

function createKnownCallsign(
  overrides: Partial<KnownCallsignShortRes> = {},
): KnownCallsignShortRes {
  return {
    id: 20,
    callsign: 'Барс-4',
    position: 'ЗКМ',
    comment: 'Збiг',
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
  otherApiMocks.listPosts.mockReset();
  otherApiMocks.fetchCurrentUser.mockReset();
});

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

  it('loads Everything candidates once and splits catalog and intercepted rows', async () => {
    installDefaultApiMocks();
    renderHookHarness();

    const networkCallsignsDeferred = createDeferred<{ networkCallsigns: NetworkCallsign[] }>();
    const sourcesDeferred = createDeferred<Source[]>();
    const candidateDeferred = createDeferred<{ callsigns: NetworkCallsignRes[] }>();
    const activityDeferred = createDeferred<{ callsignsActivity: never[] }>();

    callsignsApiMock.listNetworkCallsigns.mockReturnValue(networkCallsignsDeferred.promise);
    callsignsApiMock.listSources.mockReturnValue(sourcesDeferred.promise);
    callsignsApiMock.getNetworkCallsigns.mockReturnValue(candidateDeferred.promise);
    callsignsApiMock.getNetworkCallsignsActivity.mockReturnValue(activityDeferred.promise);

    await act(async () => {
      void latestLoadCallsigns?.(42);
    });

    await act(async () => {
      candidateDeferred.resolve({
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

    expect(callsignsApiMock.getNetworkCallsigns).toHaveBeenCalledTimes(1);
    expect(callsignsApiMock.getNetworkCallsigns).toHaveBeenCalledWith({
      networkId: 42,
      includeActivityInfo: false,
      section: 'Everything',
    });
    expect(latestState?.networkCallsignsLoading).toBe(true);
    expect(latestState?.catalogCallsignsLoaded).toBe(true);
    expect(latestState?.catalogCallsignsLoading).toBe(false);
    expect(latestState?.interceptedCallsignsLoaded).toBe(true);
    expect(latestState?.interceptedCallsignsLoading).toBe(false);
    expect(latestState?.callsignsLoading).toBe(true);
    expect(latestState?.catalogCallsignGroups.map((group) => group.callsign)).toEqual(['БАРС-4']);
    expect(latestState?.unknownInterceptedCallsigns.map((group) => group.callsign)).toEqual([
      'СОКІЛ-1',
    ]);

    await act(async () => {
      sourcesDeferred.resolve([]);
      networkCallsignsDeferred.resolve({ networkCallsigns: [] });
      activityDeferred.resolve({ callsignsActivity: [] });
      await Promise.resolve();
    });

    expect(callsignsApiMock.getNetworkCallsignsActivity).toHaveBeenCalledTimes(1);
    expect(callsignsApiMock.getNetworkCallsignsActivity).toHaveBeenCalledWith({
      networkId: 42,
      callsigns: ['БАРС-4', 'СОКІЛ-1'],
    });
    expect(latestState?.networkCallsignsLoaded).toBe(true);
    expect(latestState?.networkCallsignsLoading).toBe(false);
    expect(latestState?.callsignsLoaded).toBe(true);
    expect(latestState?.callsignsLoading).toBe(false);
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

  it('drops unknown intercepted rows once network callsigns load', async () => {
    installDefaultApiMocks();
    renderHookHarness();

    const networkCallsignsDeferred = createDeferred<{ networkCallsigns: NetworkCallsign[] }>();
    const sourcesDeferred = createDeferred<Source[]>();
    const candidateDeferred = createDeferred<{ callsigns: NetworkCallsignRes[] }>();

    callsignsApiMock.listNetworkCallsigns.mockReturnValue(networkCallsignsDeferred.promise);
    callsignsApiMock.listSources.mockReturnValue(sourcesDeferred.promise);
    callsignsApiMock.getNetworkCallsigns.mockReturnValue(candidateDeferred.promise);
    callsignsApiMock.getNetworkCallsignsActivity.mockResolvedValue({ callsignsActivity: [] });

    await act(async () => {
      void latestLoadCallsigns?.(42);
    });

    await act(async () => {
      candidateDeferred.resolve({
        callsigns: [
          createCallsignGroup({
            callsign: 'СОКІЛ-1',
            knownCallsigns: [],
          }),
        ],
      });
      await Promise.resolve();
    });

    expect(latestState?.unknownInterceptedCallsigns.map((group) => group.callsign)).toEqual([
      'СОКІЛ-1',
    ]);

    await act(async () => {
      sourcesDeferred.resolve([]);
      networkCallsignsDeferred.resolve({
        networkCallsigns: [{ id: 1, callsign: 'СОКІЛ-1' } as NetworkCallsign],
      });
      await Promise.resolve();
    });

    expect(latestState?.unknownInterceptedCallsigns).toEqual([]);
    expect(latestState?.networkCallsignGroups.map((group) => group.callsign)).toEqual(['СОКІЛ-1']);
  });

  it('surfaces activity failures while keeping section rows visible', async () => {
    installDefaultApiMocks();
    renderHookHarness();

    const networkCallsignsDeferred = createDeferred<{ networkCallsigns: NetworkCallsign[] }>();
    const sourcesDeferred = createDeferred<Source[]>();
    const candidateDeferred = createDeferred<{ callsigns: NetworkCallsignRes[] }>();

    callsignsApiMock.listNetworkCallsigns.mockReturnValue(networkCallsignsDeferred.promise);
    callsignsApiMock.listSources.mockReturnValue(sourcesDeferred.promise);
    callsignsApiMock.getNetworkCallsigns.mockReturnValue(candidateDeferred.promise);
    callsignsApiMock.getNetworkCallsignsActivity.mockRejectedValue(new Error('activity failed'));

    await act(async () => {
      void latestLoadCallsigns?.(42);
    });

    await act(async () => {
      candidateDeferred.resolve({
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
      sourcesDeferred.resolve([]);
      networkCallsignsDeferred.resolve({
        networkCallsigns: [],
      });
      await Promise.resolve();
    });

    expect(latestState?.callsignsError).toContain('activity failed');
    expect(latestState?.catalogCallsignGroups.map((group) => group.callsign)).toEqual(['БАРС-4']);
    expect(latestState?.unknownInterceptedCallsigns.map((group) => group.callsign)).toEqual([
      'СОКІЛ-1',
    ]);
  });
});
