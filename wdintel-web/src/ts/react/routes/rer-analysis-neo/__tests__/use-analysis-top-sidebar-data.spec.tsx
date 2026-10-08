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
let onError = vi.fn();
let onUnauthorized = vi.fn(() => false);

function Harness() {
  latest = useAnalysisTopSidebarData({
    onError,
    onUnauthorized,
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
  onError = vi.fn();
  onUnauthorized = vi.fn(() => false);
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
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
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

  it.each(['units', 'locations'] as const)(
    'keeps stale rows and clears loading after a failed %s refresh',
    async (failedFacet) => {
      queryState = validQueryState();
      api.fetchAnalysisUnits.mockResolvedValue({
        units: [{ name: 'Unit 1', count: 5, unitId: 1 }],
      });
      api.fetchAnalysisLocations.mockResolvedValue({
        locations: [{ location: 'Kyiv', count: 4 }],
      });
      renderHook();

      await act(async () => {
        await latest?.loadTopSidebarData();
      });
      act(() => {
        latest?.invalidateRightSidebarData();
      });
      if (failedFacet === 'units') {
        api.fetchAnalysisUnits.mockRejectedValueOnce(new Error('units refresh failed'));
      } else {
        api.fetchAnalysisLocations.mockRejectedValueOnce(new Error('locations refresh failed'));
      }

      await act(async () => {
        await latest?.loadTopSidebarData();
      });

      expect(latest?.rightSidebarLoading).toBe(false);
      expect(latest?.rightSidebarOutdated).toBe(true);
      expect(latest?.topUnits).toEqual([{ key: 'Unit 1', count: 5, value: 'unit-id:1' }]);
      expect(latest?.topLocations).toEqual([{ key: 'Kyiv', count: 4 }]);
      expect(onError).toHaveBeenCalledWith(
        failedFacet === 'units' ? 'units refresh failed' : 'locations refresh failed',
      );

      api.fetchAnalysisUnits.mockResolvedValue({
        units: [{ name: 'Unit 2', count: 2, unitId: 2 }],
      });
      api.fetchAnalysisLocations.mockResolvedValue({
        locations: [{ location: 'Lviv', count: 2 }],
      });
      await act(async () => {
        await latest?.loadTopSidebarData();
      });

      expect(latest?.rightSidebarLoading).toBe(false);
      expect(latest?.rightSidebarOutdated).toBe(false);
      expect(latest?.topUnits).toEqual([{ key: 'Unit 2', count: 2, value: 'unit-id:2' }]);
      expect(latest?.topLocations).toEqual([{ key: 'Lviv', count: 2 }]);
    },
  );

  it('ignores an obsolete refresh failure while a newer refresh succeeds', async () => {
    queryState = validQueryState();
    api.fetchAnalysisUnits.mockResolvedValue({
      units: [{ name: 'Unit 1', count: 5, unitId: 1 }],
    });
    api.fetchAnalysisLocations.mockResolvedValue({
      locations: [{ location: 'Kyiv', count: 4 }],
    });
    renderHook();
    await act(async () => {
      await latest?.loadTopSidebarData();
    });

    const staleUnits = deferred<{
      units: Array<{ name: string; count: number; unitId: number }>;
    }>();
    const staleLocations = deferred<{ locations: Array<{ location: string; count: number }> }>();
    api.fetchAnalysisUnits.mockReturnValueOnce(staleUnits.promise).mockResolvedValueOnce({
      units: [{ name: 'Unit 2', count: 2, unitId: 2 }],
    });
    api.fetchAnalysisLocations.mockReturnValueOnce(staleLocations.promise).mockResolvedValueOnce({
      locations: [{ location: 'Lviv', count: 2 }],
    });
    act(() => {
      latest?.invalidateRightSidebarData();
      void latest?.loadTopSidebarData();
      latest?.invalidateRightSidebarData();
      void latest?.loadTopSidebarData();
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(latest?.rightSidebarLoading).toBe(false);
    expect(latest?.rightSidebarOutdated).toBe(false);
    expect(latest?.topUnits).toEqual([{ key: 'Unit 2', count: 2, value: 'unit-id:2' }]);

    await act(async () => {
      staleUnits.reject(new Error('obsolete refresh failed'));
      staleLocations.resolve({ locations: [{ location: 'Obsolete', count: 1 }] });
      await Promise.resolve();
    });
    expect(onError).not.toHaveBeenCalled();
    expect(latest?.rightSidebarOutdated).toBe(false);
    expect(latest?.topLocations).toEqual([{ key: 'Lviv', count: 2 }]);
  });
});
