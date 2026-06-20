/**
 * @vitest-environment happy-dom
 */
import { act, createElement, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NetworkCallsign, NetworkCallsignRes, Source } from '../../../../Bindings';
import { NO_DATA_LABEL } from '../../utils/misc';
import { EMPTY_STATE, type NetworkDetailsNeoPageState } from './use-rer-network-details-neo-page.types';
import { derivePelengEnabledFreqs, useRerNetworkDetailsNeoPageLoad } from './use-rer-network-details-neo-page.load';

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
  getModulations: vi.fn(),
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
vi.mock('../../services/api/modulations', () => ({ getModulations: otherApiMocks.getModulations }));
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

function HookHarness() {
  const reloadGeneration = useRef(1);
  const [state, setState] = useState<NetworkDetailsNeoPageState>(EMPTY_STATE);
  const pageLoad = useRerNetworkDetailsNeoPageLoad(42, setState, reloadGeneration);

  latestState = state;
  latestLoadCallsigns = pageLoad.loadCallsigns;

  return null;
}

function renderHookHarness() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  rendered.push(root);

  act(() => {
    root.render(createElement(HookHarness));
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
  otherApiMocks.getModulations.mockReset();
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
  otherApiMocks.getModulations.mockResolvedValue([]);
  otherApiMocks.getUnitsList.mockResolvedValue([]);
  otherApiMocks.listPosts.mockResolvedValue([]);
  otherApiMocks.getNetworkCallsignRelations.mockResolvedValue({ freqs: [] });
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
      derivePelengEnabledFreqs([], [
        { freq: '   ' },
        { freq: '146.5000' },
        { freq: '146.5000' },
      ]),
    ).toEqual(['146.5000', NO_DATA_LABEL]);
  });

  it('falls back to all loaded peleng frequencies when nothing stays enabled', () => {
    expect(derivePelengEnabledFreqs(['149.0000'], [{ freq: '   ' }, { freq: '146.5000' }])).toEqual([
      '146.5000',
      NO_DATA_LABEL,
    ]);
  });

  it('lets catalog resolve while intercepted is still loading', async () => {
    installDefaultApiMocks();
    renderHookHarness();

    const networkCallsignsDeferred = createDeferred<{ networkCallsigns: never[] }>();
    const sourcesDeferred = createDeferred<Source[]>();
    const catalogDeferred = createDeferred<{ callsigns: NetworkCallsignRes[] }>();
    const interceptedDeferred = createDeferred<{ callsigns: NetworkCallsignRes[] }>();
    const activityDeferred = createDeferred<{ callsignsActivity: never[] }>();

    callsignsApiMock.listNetworkCallsigns.mockReturnValue(networkCallsignsDeferred.promise);
    callsignsApiMock.listSources.mockReturnValue(sourcesDeferred.promise);
    callsignsApiMock.getNetworkCallsigns.mockImplementation((req: { section?: string | null }) => {
      return req.section === 'Catalog' ? catalogDeferred.promise : interceptedDeferred.promise;
    });
    callsignsApiMock.getNetworkCallsignsActivity.mockReturnValue(activityDeferred.promise);

    await act(async () => {
      void latestLoadCallsigns?.(42);
    });

    await act(async () => {
      catalogDeferred.resolve({ callsigns: [] });
      await Promise.resolve();
    });

    expect(latestState?.networkCallsignsLoading).toBe(true);
    expect(latestState?.catalogCallsignsLoaded).toBe(true);
    expect(latestState?.catalogCallsignsLoading).toBe(false);
    expect(latestState?.interceptedCallsignsLoaded).toBe(false);
    expect(latestState?.interceptedCallsignsLoading).toBe(true);
    expect(latestState?.callsignsLoading).toBe(true);

    await act(async () => {
      interceptedDeferred.resolve({ callsigns: [] });
      sourcesDeferred.resolve([]);
      networkCallsignsDeferred.resolve({ networkCallsigns: [] });
      activityDeferred.resolve({ callsignsActivity: [] });
      await Promise.resolve();
    });

    expect(latestState?.networkCallsignsLoaded).toBe(true);
    expect(latestState?.networkCallsignsLoading).toBe(false);
    expect(latestState?.callsignsLoaded).toBe(true);
    expect(latestState?.callsignsLoading).toBe(false);
  });

  it('does not use network rows as an activity fallback', async () => {
    installDefaultApiMocks();
    renderHookHarness();

    const networkCallsignsDeferred = createDeferred<{ networkCallsigns: never[] }>();
    const sourcesDeferred = createDeferred<Source[]>();
    const catalogDeferred = createDeferred<{ callsigns: NetworkCallsignRes[] }>();
    const interceptedDeferred = createDeferred<{ callsigns: NetworkCallsignRes[] }>();

    callsignsApiMock.listNetworkCallsigns.mockReturnValue(networkCallsignsDeferred.promise);
    callsignsApiMock.listSources.mockReturnValue(sourcesDeferred.promise);
    callsignsApiMock.getNetworkCallsigns.mockImplementation((req: { section?: string | null }) => {
      if (req.section === 'Catalog') {
        return catalogDeferred.promise;
      }
      return interceptedDeferred.promise;
    });
    callsignsApiMock.getNetworkCallsignsActivity.mockResolvedValue({ callsignsActivity: [] });

    await act(async () => {
      void latestLoadCallsigns?.(42);
    });

    await act(async () => {
      catalogDeferred.resolve({ callsigns: [] });
      interceptedDeferred.resolve({ callsigns: [] });
      sourcesDeferred.resolve([]);
      networkCallsignsDeferred.resolve({ networkCallsigns: [{ id: 1 } as never] });
      await Promise.resolve();
    });

    expect(callsignsApiMock.getNetworkCallsignsActivity).toHaveBeenCalledTimes(0);
  });

  it('lets intercepted resolve while catalog is still loading', async () => {
    installDefaultApiMocks();
    renderHookHarness();

    const networkCallsignsDeferred = createDeferred<{ networkCallsigns: never[] }>();
    const sourcesDeferred = createDeferred<Source[]>();
    const catalogDeferred = createDeferred<{ callsigns: NetworkCallsignRes[] }>();
    const interceptedDeferred = createDeferred<{ callsigns: NetworkCallsignRes[] }>();
    const activityDeferred = createDeferred<{ callsignsActivity: never[] }>();

    callsignsApiMock.listNetworkCallsigns.mockReturnValue(networkCallsignsDeferred.promise);
    callsignsApiMock.listSources.mockReturnValue(sourcesDeferred.promise);
    callsignsApiMock.getNetworkCallsigns.mockImplementation((req: { section?: string | null }) => {
      return req.section === 'Intercepted' ? interceptedDeferred.promise : catalogDeferred.promise;
    });
    callsignsApiMock.getNetworkCallsignsActivity.mockReturnValue(activityDeferred.promise);

    await act(async () => {
      void latestLoadCallsigns?.(42);
    });

    await act(async () => {
      interceptedDeferred.resolve({ callsigns: [] });
      await Promise.resolve();
    });

    expect(latestState?.catalogCallsignsLoaded).toBe(false);
    expect(latestState?.catalogCallsignsLoading).toBe(true);
    expect(latestState?.interceptedCallsignsLoaded).toBe(true);
    expect(latestState?.interceptedCallsignsLoading).toBe(false);

    await act(async () => {
      catalogDeferred.resolve({ callsigns: [] });
      sourcesDeferred.resolve([]);
      networkCallsignsDeferred.resolve({ networkCallsigns: [] });
      activityDeferred.resolve({ callsignsActivity: [] });
      await Promise.resolve();
    });

    expect(latestState?.catalogCallsignsLoaded).toBe(true);
    expect(latestState?.catalogCallsignsLoading).toBe(false);
    expect(latestState?.callsignsLoaded).toBe(true);
  });

  it('does not fail intercepted when catalog errors first', async () => {
    installDefaultApiMocks();
    renderHookHarness();

    const networkCallsignsDeferred = createDeferred<{ networkCallsigns: never[] }>();
    const sourcesDeferred = createDeferred<Source[]>();
    const interceptedDeferred = createDeferred<{ callsigns: NetworkCallsignRes[] }>();
    const activityDeferred = createDeferred<{ callsignsActivity: never[] }>();

    callsignsApiMock.listNetworkCallsigns.mockReturnValue(networkCallsignsDeferred.promise);
    callsignsApiMock.listSources.mockReturnValue(sourcesDeferred.promise);
    callsignsApiMock.getNetworkCallsigns.mockImplementation((req: { section?: string | null }) => {
      if (req.section === 'Catalog') {
        return Promise.reject(new Error('catalog failed'));
      }
      return interceptedDeferred.promise;
    });
    callsignsApiMock.getNetworkCallsignsActivity.mockReturnValue(activityDeferred.promise);

    await act(async () => {
      void latestLoadCallsigns?.(42);
      await Promise.resolve();
    });

    expect(latestState?.catalogCallsignsLoaded).toBe(false);
    expect(latestState?.catalogCallsignsLoading).toBe(false);
    expect(latestState?.catalogCallsignsError).toContain('catalog failed');
    expect(latestState?.interceptedCallsignsLoaded).toBe(false);
    expect(latestState?.interceptedCallsignsLoading).toBe(true);
    expect(latestState?.interceptedCallsignsError).toBeNull();

    await act(async () => {
      interceptedDeferred.resolve({ callsigns: [] });
      sourcesDeferred.resolve([]);
      networkCallsignsDeferred.resolve({ networkCallsigns: [] });
      activityDeferred.resolve({ callsignsActivity: [] });
      await Promise.resolve();
    });

    expect(latestState?.interceptedCallsignsLoaded).toBe(true);
    expect(latestState?.interceptedCallsignsError).toBeNull();
  });

  it('does not fail catalog when intercepted errors first', async () => {
    installDefaultApiMocks();
    renderHookHarness();

    const networkCallsignsDeferred = createDeferred<{ networkCallsigns: never[] }>();
    const sourcesDeferred = createDeferred<Source[]>();
    const catalogDeferred = createDeferred<{ callsigns: NetworkCallsignRes[] }>();
    const activityDeferred = createDeferred<{ callsignsActivity: never[] }>();

    callsignsApiMock.listNetworkCallsigns.mockReturnValue(networkCallsignsDeferred.promise);
    callsignsApiMock.listSources.mockReturnValue(sourcesDeferred.promise);
    callsignsApiMock.getNetworkCallsigns.mockImplementation((req: { section?: string | null }) => {
      if (req.section === 'Intercepted') {
        return Promise.reject(new Error('intercepted failed'));
      }
      return catalogDeferred.promise;
    });
    callsignsApiMock.getNetworkCallsignsActivity.mockReturnValue(activityDeferred.promise);

    await act(async () => {
      void latestLoadCallsigns?.(42);
      await Promise.resolve();
    });

    expect(latestState?.interceptedCallsignsLoaded).toBe(false);
    expect(latestState?.interceptedCallsignsLoading).toBe(false);
    expect(latestState?.interceptedCallsignsError).toContain('intercepted failed');
    expect(latestState?.catalogCallsignsLoaded).toBe(false);
    expect(latestState?.catalogCallsignsLoading).toBe(true);
    expect(latestState?.catalogCallsignsError).toBeNull();

    await act(async () => {
      catalogDeferred.resolve({ callsigns: [] });
      sourcesDeferred.resolve([]);
      networkCallsignsDeferred.resolve({ networkCallsigns: [] });
      activityDeferred.resolve({ callsignsActivity: [] });
      await Promise.resolve();
    });

    expect(latestState?.catalogCallsignsLoaded).toBe(true);
    expect(latestState?.catalogCallsignsError).toBeNull();
  });

  it('drops a stale unknown intercepted callsign when network callsigns resolve after the tab data', async () => {
    installDefaultApiMocks();
    renderHookHarness();

    const networkCallsignsDeferred = createDeferred<{ networkCallsigns: NetworkCallsign[] }>();
    const sourcesDeferred = createDeferred<Source[]>();
    const catalogDeferred = createDeferred<{ callsigns: NetworkCallsignRes[] }>();
    const interceptedDeferred = createDeferred<{ callsigns: NetworkCallsignRes[] }>();

    callsignsApiMock.listNetworkCallsigns.mockReturnValue(networkCallsignsDeferred.promise);
    callsignsApiMock.listSources.mockReturnValue(sourcesDeferred.promise);
    callsignsApiMock.getNetworkCallsigns.mockImplementation((req: { section?: string | null }) => {
      if (req.section === 'Catalog') {
        return catalogDeferred.promise;
      }
      return interceptedDeferred.promise;
    });
    callsignsApiMock.getNetworkCallsignsActivity.mockRejectedValue(new Error('activity failed'));

    await act(async () => {
      void latestLoadCallsigns?.(42);
    });

    await act(async () => {
      catalogDeferred.resolve({
        callsigns: [
          {
            callsign: 'СОКІЛ-1',
            knownCallsigns: [],
            messageCount: 5,
            lastDatetime: 1710000000000,
            freqs: null,
            isOld: false,
            isInDictionary: false,
          } as NetworkCallsignRes,
        ],
      });
      interceptedDeferred.resolve({ callsigns: [] });
      await Promise.resolve();
    });

    expect(latestState?.unknownInterceptedCallsigns).toEqual([
      expect.objectContaining({ callsign: 'СОКІЛ-1' }),
    ]);

    await act(async () => {
      sourcesDeferred.resolve([]);
      networkCallsignsDeferred.resolve({
        networkCallsigns: [{ id: 1, callsign: 'СОКІЛ-1' } as NetworkCallsign],
      });
      await Promise.resolve();
    });

    expect(latestState?.unknownInterceptedCallsigns).toEqual([]);
    expect(latestState?.catalogCallsignGroups).toEqual([]);
  });
});
