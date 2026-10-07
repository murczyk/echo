/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  fetchAnalysisLocations: vi.fn(),
  fetchAnalysisUnits: vi.fn(),
}));

vi.mock('../../../services/api/analysis', () => api);

import { emptyQueryState } from '../helpers';
import { useAnalysisTopSidebarData } from '../use-analysis-top-sidebar-data';

type HookResult = ReturnType<typeof useAnalysisTopSidebarData>;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: HookResult | null = null;
let queryState = emptyQueryState();

function Harness() {
  latest = useAnalysisTopSidebarData({
    onError: vi.fn(),
    onUnauthorized: vi.fn(() => false),
    optionsFreqValues: ['100.0000'],
    queryState,
  });
  return null;
}

function renderHook() {
  if (container == null) throw new Error('container not initialized');

  root = createRoot(container);
  act(() => {
    root?.render(createElement(Harness));
  });

  if (!latest) throw new Error('Hook did not render');
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  latest = null;
  queryState = emptyQueryState();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  latest = null;
  queryState = emptyQueryState();
  vi.clearAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function validQueryState() {
  return {
    ...emptyQueryState(),
    fromDateTimeStr: '2026-03-01T00:00',
    toDateTimeStr: '2026-03-02T00:00',
  };
}
describe('useAnalysisTopSidebarData', () => {
  it('keeps top sidebar counters visible while invalidating the right sidebar load state', () => {
    renderHook();

    act(() => {
      latest?.setTopFreqs([{ key: '100.0000', count: 3 }]);
      latest?.setTopCallsigns([{ key: 'ABC', count: 2 }]);
      latest?.setTopLocations([{ key: 'Kyiv', count: 4 }]);
      latest?.setTopUnits([{ key: 'Unit 1', count: 5 }]);
    });

    expect(latest?.topFreqs).toEqual([{ key: '100.0000', count: 3 }]);
    expect(latest?.topCallsigns).toEqual([{ key: 'ABC', count: 2 }]);
    expect(latest?.topLocations).toEqual([{ key: 'Kyiv', count: 4 }]);
    expect(latest?.topUnits).toEqual([{ key: 'Unit 1', count: 5 }]);

    act(() => {
      latest?.invalidateRightSidebarData();
    });

    expect(latest?.topFreqs).toEqual([{ key: '100.0000', count: 3 }]);
    expect(latest?.topCallsigns).toEqual([{ key: 'ABC', count: 2 }]);
    expect(latest?.topLocations).toEqual([{ key: 'Kyiv', count: 4 }]);
    expect(latest?.topUnits).toEqual([{ key: 'Unit 1', count: 5 }]);
  });

  it('clears outdated right-sidebar data for an invalid request and ignores a late response', async () => {
    queryState = validQueryState();
    const units = deferred<{ units: Array<{ name: string; count: number; unitId: number }> }>();
    const locations = deferred<{ locations: Array<{ location: string; count: number }> }>();
    api.fetchAnalysisUnits.mockReturnValue(units.promise);
    api.fetchAnalysisLocations.mockReturnValue(locations.promise);
    renderHook();

    await act(async () => {
      void latest?.loadTopSidebarData();
    });
    expect(latest?.rightSidebarLoading).toBe(true);

    await act(async () => {
      units.resolve({ units: [{ name: 'Unit 1', count: 5, unitId: 1 }] });
      locations.resolve({ locations: [{ location: 'Kyiv', count: 4 }] });
      await Promise.resolve();
    });
    expect(latest?.rightSidebarOutdated).toBe(false);

    act(() => {
      latest?.invalidateRightSidebarData();
    });
    expect(latest?.rightSidebarOutdated).toBe(true);

    const lateUnits = deferred<{ units: Array<{ name: string; count: number; unitId: number }> }>();
    const lateLocations = deferred<{ locations: Array<{ location: string; count: number }> }>();
    api.fetchAnalysisUnits.mockReturnValue(lateUnits.promise);
    api.fetchAnalysisLocations.mockReturnValue(lateLocations.promise);
    await act(async () => {
      void latest?.loadTopSidebarData();
    });

    queryState = emptyQueryState();
    act(() => {
      root?.render(createElement(Harness));
    });
    await act(async () => {
      await latest?.loadTopSidebarData();
    });
    expect(latest?.rightSidebarLoading).toBe(false);
    expect(latest?.rightSidebarOutdated).toBe(false);
    expect(latest?.topUnits).toEqual([]);
    expect(latest?.topLocations).toEqual([]);

    await act(async () => {
      lateUnits.resolve({ units: [{ name: 'Late unit', count: 9, unitId: 9 }] });
      lateLocations.resolve({ locations: [{ location: 'Late location', count: 9 }] });
      await Promise.resolve();
    });
    expect(latest?.topUnits).toEqual([]);
    expect(latest?.topLocations).toEqual([]);

    queryState = validQueryState();
    api.fetchAnalysisUnits.mockResolvedValue({ units: [{ name: 'Unit 2', count: 2, unitId: 2 }] });
    api.fetchAnalysisLocations.mockResolvedValue({ locations: [{ location: 'Lviv', count: 2 }] });
    act(() => {
      root?.render(createElement(Harness));
    });
    await act(async () => {
      await latest?.loadTopSidebarData();
    });
    expect(latest?.topUnits).toEqual([{ key: 'Unit 2', count: 2, value: 'unit-id:2' }]);
    expect(latest?.rightSidebarOutdated).toBe(false);
  });
});
