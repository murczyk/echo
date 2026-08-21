/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MapPointsRsp } from '../../../../Bindings';
import { emptyQueryState } from './helpers';
import type { AnalysisQueryState } from './types';
import { useAnalysisMapData } from './use-analysis-map-data';

const api = vi.hoisted(() => ({
  fetchAnalysisMapPoints: vi.fn(),
  fetchMapSettlementMessages: vi.fn(),
  fetchMessagesByIds: vi.fn(),
  listMapPalitrasV2: vi.fn(),
}));

vi.mock('../../services/api/analysis', () => ({
  fetchAnalysisMapPoints: api.fetchAnalysisMapPoints,
  fetchMapSettlementMessages: api.fetchMapSettlementMessages,
  fetchMessagesByIds: api.fetchMessagesByIds,
}));

vi.mock('../../services/api/palitra', () => ({
  listMapPalitrasV2: api.listMapPalitrasV2,
}));

type HookResult = ReturnType<typeof useAnalysisMapData>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const settlement = {
  settlementId: 7,
  name: 'Харків',
  region: 'Харківська',
  lat: 49.99,
  lon: 36.23,
  inboxItemCount: 3,
};

function response(): MapPointsRsp {
  return { networkUnits: [], points: [], settlements: [settlement] };
}

function queryState(search = ''): AnalysisQueryState {
  return {
    ...emptyQueryState(),
    fromDateTimeStr: '2026-08-18T00:00',
    toDateTimeStr: '2026-08-19T00:00',
    search,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: HookResult | null = null;
let onError = vi.fn();

function Harness({ query }: { query: AnalysisQueryState }) {
  latest = useAnalysisMapData({
    canShowSettlements: true,
    loadMissingNetworksForMessages: vi.fn().mockResolvedValue(undefined),
    newestFirst: true,
    onError,
    onUnauthorized: vi.fn(() => false),
    optionsFreqValues: [],
    queryState: query,
  });
  return null;
}

async function renderHook(query = queryState()) {
  await act(async () => {
    root?.render(createElement(Harness, { query }));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  latest = null;
  onError = vi.fn();
  api.fetchAnalysisMapPoints.mockReset();
  api.fetchMapSettlementMessages.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  latest = null;
});

describe('useAnalysisMapData settlement overlays', () => {
  it('loads a bounded settlement page through the settlement endpoint', async () => {
    api.fetchMapSettlementMessages.mockResolvedValueOnce([]);
    await renderHook();

    await act(async () => {
      await latest!.loadSettlementMessagesForMap(7);
    });

    expect(api.fetchMapSettlementMessages).toHaveBeenCalledWith({
      settlementId: 7,
      inboxItemsFilter: expect.any(Object),
      beforeIdNoninclusive: null,
    });
  });

  it('propagates the toggle and ignores its response after an immediate toggle off', async () => {
    const request = deferred<MapPointsRsp>();
    api.fetchAnalysisMapPoints.mockReturnValueOnce(request.promise);
    await renderHook();

    let togglePromise!: Promise<void>;
    await act(async () => {
      togglePromise = latest!.setShowSettlements(true);
      await Promise.resolve();
    });
    expect(api.fetchAnalysisMapPoints.mock.calls[0][0].showSettlements).toBe(true);

    await act(async () => latest!.setShowSettlements(false));
    expect(latest?.mapLoading).toBe(false);
    request.resolve(response());
    await act(async () => togglePromise);

    expect(latest?.showSettlements).toBe(false);
    expect(latest?.mapSettlements).toEqual([]);
  });

  it('clears old markers and rejects a date-range response after filters change', async () => {
    api.fetchAnalysisMapPoints.mockResolvedValueOnce(response());
    await renderHook();
    await act(async () => latest!.setShowSettlements(true));
    expect(latest?.mapSettlements).toEqual([settlement]);

    const request = deferred<MapPointsRsp>();
    api.fetchAnalysisMapPoints.mockReturnValueOnce(request.promise);
    let refreshPromise!: Promise<void>;
    await act(async () => {
      refreshPromise = latest!.refreshMapDateRange({ startDate: 10, endDate: 20 });
      await Promise.resolve();
    });
    expect(latest?.mapSettlements).toEqual([]);

    await renderHook(queryState('new filter'));
    request.resolve(response());
    await act(async () => refreshPromise);

    expect(latest?.mapSettlements).toEqual([]);
  });

  it('preserves a pending date-range refresh when disabling settlements', async () => {
    api.fetchAnalysisMapPoints.mockResolvedValueOnce(response());
    await renderHook();
    await act(async () => latest!.setShowSettlements(true));

    const request = deferred<MapPointsRsp>();
    api.fetchAnalysisMapPoints.mockReturnValueOnce(request.promise);
    let refreshPromise!: Promise<void>;
    await act(async () => {
      refreshPromise = latest!.refreshMapDateRange({ startDate: 10, endDate: 20 });
      await Promise.resolve();
    });
    expect(latest?.mapLoading).toBe(true);

    await act(async () => latest!.setShowSettlements(false));
    expect(latest?.mapLoading).toBe(true);

    const point = {
      messageId: 11,
      messageUid: null,
      id: 12,
      lat: 49,
      lng: 36,
      mgrsCoords: 'MGRS',
      sk42Coords: 'SK42',
      freq: null,
    };
    const networkUnit = { name: 'unit', frequencies: ['1.0'] };
    request.resolve({
      points: [point],
      networkUnits: [networkUnit],
      settlements: [settlement],
    });
    await act(async () => refreshPromise);
    expect(latest?.mapLoading).toBe(false);
    expect(latest?.mapPoints).toEqual([point]);
    expect(latest?.mapNetworkUnits).toEqual([networkUnit]);
    expect(latest?.mapSettlements).toEqual([]);
  });

  it('does not retain markers when a date-range refresh fails', async () => {
    api.fetchAnalysisMapPoints.mockResolvedValueOnce(response());
    await renderHook();
    await act(async () => latest!.setShowSettlements(true));

    api.fetchAnalysisMapPoints.mockRejectedValueOnce(new Error('map failed'));
    await act(async () => latest!.refreshMapDateRange({ startDate: 10, endDate: 20 }));

    expect(latest?.mapSettlements).toEqual([]);
    expect(onError).toHaveBeenCalledWith('map failed');
  });
});
