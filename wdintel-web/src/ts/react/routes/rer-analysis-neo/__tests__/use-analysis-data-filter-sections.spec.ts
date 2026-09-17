/**
 * @vitest-environment happy-dom
 */
import { act, createElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Unit } from '../../../../../Bindings';
import { buildAnalysisReq, emptyQueryState } from '../helpers';
import {
  filterSectionsToInvalidateForPatch,
  useAnalysisFilterSections,
} from '../use-analysis-data-filter-sections';
import { loadFilterSectionData } from '../use-analysis-data.reload';

const analysisApiMocks = vi.hoisted(() => ({
  fetchAnalysisGroups: vi.fn(),
  fetchAnalysisCallsigns: vi.fn(),
  fetchAnalysisSenders: vi.fn(),
  fetchAnalysisTags: vi.fn(),
  fetchAnalysisUnits: vi.fn(),
  fetchAnalysisNetworks: vi.fn(),
  fetchNetworksByIds: vi.fn(),
  getLatestSenders: vi.fn(),
  getTagsForDisplay: vi.fn(),
}));

vi.mock('../../../services/api/analysis', () => ({
  fetchAnalysisGroups: analysisApiMocks.fetchAnalysisGroups,
  fetchAnalysisCallsigns: analysisApiMocks.fetchAnalysisCallsigns,
  fetchAnalysisSenders: analysisApiMocks.fetchAnalysisSenders,
  fetchAnalysisTags: analysisApiMocks.fetchAnalysisTags,
  fetchAnalysisUnits: analysisApiMocks.fetchAnalysisUnits,
  fetchAnalysisNetworks: analysisApiMocks.fetchAnalysisNetworks,
  fetchNetworksByIds: analysisApiMocks.fetchNetworksByIds,
  getLatestSenders: analysisApiMocks.getLatestSenders,
  getTagsForDisplay: analysisApiMocks.getTagsForDisplay,
}));

type HookApi = ReturnType<typeof useAnalysisFilterSections>;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: HookApi | null = null;

function Harness() {
  const unitsMapRef = useRef<Record<number, Unit>>({});
  latest = useAnalysisFilterSections({
    queryState: {
      ...emptyQueryState(),
      fromDateTimeStr: '2026-03-30T08:00',
      toDateTimeStr: '2026-03-31T08:00',
    },
    optionsFreqValues: [],
    unitsMapRef,
    onError: vi.fn(),
    onUnauthorized: vi.fn(() => false),
    setAorEntries: vi.fn(),
    setGroupInfos: vi.fn(),
    setNetworks: vi.fn(),
    setOptions: vi.fn(),
    setProfiles: vi.fn(),
    setTagsMap: vi.fn(),
    setTagsOrder: vi.fn(),
  });
  return null;
}

async function renderHook() {
  if (container == null) throw new Error('container not initialized');

  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(Harness));
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  latest = null;
  analysisApiMocks.fetchAnalysisGroups.mockResolvedValue({ groups: [], groupNames: [] });
  analysisApiMocks.fetchAnalysisCallsigns.mockResolvedValue({ callsigns: [] });
  analysisApiMocks.fetchAnalysisSenders.mockResolvedValue({ senders: [] });
  analysisApiMocks.fetchAnalysisTags.mockResolvedValue({ tags: [] });
  analysisApiMocks.fetchAnalysisUnits.mockResolvedValue({ units: [] });
  analysisApiMocks.fetchAnalysisNetworks.mockResolvedValue({ networks: [], networkNames: [] });
  analysisApiMocks.fetchNetworksByIds.mockResolvedValue([]);
  analysisApiMocks.getLatestSenders.mockResolvedValue({ data: {} });
  analysisApiMocks.getTagsForDisplay.mockResolvedValue({ tagsMap: {}, tagsOrder: [] });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  latest = null;
  vi.clearAllMocks();
});

// @test-scope safeguard: prevents stale or failed filter-section loads from replacing current selectable options.
describe('loadFilterSectionData', () => {
  it('drops stale network filter options during a late networks load', async () => {
    analysisApiMocks.fetchAnalysisNetworks.mockResolvedValue({
      networks: [{ networkId: 11, count: 3 }],
      networkNames: [{ id: 11, name: 'new network' }],
    });
    analysisApiMocks.fetchNetworksByIds.mockResolvedValue([{ id: 11, name: 'new network' }]);
    const setNetworks = vi.fn((update) => {
      if (typeof update === 'function') {
        expect(update([{ id: 7, name: 'Network 7' }])).toEqual([
          { id: 7, name: 'Network 7' },
          { id: 11, name: 'new network' },
        ]);
      }
    });
    const setOptions = vi.fn((update) => {
      if (typeof update === 'function') {
        expect(
          update({
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
            networks: [
              { value: '7', label: 'old selected', count: 9 },
              { value: '8', label: 'old unselected', count: 5 },
            ],
            metadataCcs: [],
            metadataSenders: [],
            metadataReceivers: [],
            metadataHashes: [],
          }),
        ).toEqual({
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
          networks: [
            { value: '11', label: 'new network', count: 3 },
            { value: '7', label: 'old selected', count: 0, values: ['7'] },
          ],
          metadataCcs: [],
          metadataSenders: [],
          metadataReceivers: [],
          metadataHashes: [],
        });
      }
    });

    await act(async () => {
      await loadFilterSectionData('networks', {
        analysisReq: buildAnalysisReq(
          {
            ...emptyQueryState(),
            fromDateTimeStr: '2026-03-30T08:00',
            toDateTimeStr: '2026-03-31T08:00',
            networksSelected: ['7'],
          },
          [],
        )!,
        loadVersion: 0,
        loadVersionRef: { current: 0 },
        queryState: {
          ...emptyQueryState(),
          fromDateTimeStr: '2026-03-30T08:00',
          toDateTimeStr: '2026-03-31T08:00',
          networksSelected: ['7'],
        },
        setAorEntries: vi.fn(),
        setGroupInfos: vi.fn(),
        setNetworks,
        setOptions,
        setProfiles: vi.fn(),
        setTagsMap: vi.fn(),
        setTagsOrder: vi.fn(),
        unitsMap: { 1: { id: 1, name: 'Fresh Unit' } },
      });
      await Promise.resolve();
    });

    expect(setNetworks).toHaveBeenCalledTimes(1);
    expect(setOptions).toHaveBeenCalledTimes(1);
    expect(setOptions.mock.calls[0][0]).toEqual(expect.any(Function));
  });
});

// @test-scope safeguard: prevents invalidated filter facets from being treated as current before their reload completes.
describe('useAnalysisFilterSections', () => {
  it('returns null when no targeted invalidation is pending', async () => {
    await renderHook();

    expect(latest?.getReloadFilterSections()).toBeNull();
  });

  it('returns null when targeted invalidation does not hit a loaded section', async () => {
    await renderHook();

    act(() => {
      latest?.invalidateFilterSectionLoadsForPatch({ unitsSelected: ['u1'] });
    });

    expect(latest?.getReloadFilterSections()).toBeNull();
  });

  it('queues already loaded unrelated sections when targeted invalidation touches them', async () => {
    await renderHook();

    await act(async () => {
      await latest?.loadFilterSection('callsigns');
      await Promise.resolve();
    });

    act(() => {
      latest?.invalidateFilterSectionLoadsForPatch({ unitsSelected: ['u1'] });
    });

    expect(latest?.getReloadFilterSections()).toEqual(['callsigns']);
  });

  // @test-scope safeguard: prevents an invalidated in-flight facet from being lost instead of reloaded
  it('queues an in-flight excluded section when another targeted invalidation bumps the version', async () => {
    const groupsDeferred = deferred<{
      groups: Array<{ masterKey: string; count: number }>;
      groupNames: Array<{ masterKey: string; name: string }>;
    }>();
    analysisApiMocks.fetchAnalysisGroups.mockImplementationOnce(() => groupsDeferred.promise);

    await renderHook();

    await act(async () => {
      await latest?.loadFilterSection('tags');
      await Promise.resolve();
      void latest?.loadFilterSection('groups');
      await Promise.resolve();
    });

    expect(latest?.isFilterSectionLoading('groups')).toBe(true);

    act(() => {
      latest?.invalidateFilterSectionLoadsForPatch({ groupsSelected: ['x'] });
    });

    expect(latest?.getReloadFilterSections()).toEqual(expect.arrayContaining(['tags', 'groups']));
    expect(latest?.isFilterSectionStale('tags')).toBe(true);
    expect(latest?.isFilterSectionStale('groups')).toBe(true);

    await act(async () => {
      groupsDeferred.resolve({ groups: [], groupNames: [] });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latest?.isFilterSectionLoading('groups')).toBe(false);
    expect(latest?.isFilterSectionStale('groups')).toBe(true);
  });

  // @test-scope safeguard: prevents an early targeted invalidation from losing an in-flight facet reload
  it('treats an in-flight section as reloadable before loading state propagates', async () => {
    const callsignsDeferred = deferred<{ callsigns: Array<{ callsign: string; res: [] }> }>();
    analysisApiMocks.fetchAnalysisCallsigns.mockImplementationOnce(() => callsignsDeferred.promise);

    await renderHook();

    act(() => {
      void latest?.loadFilterSection('callsigns' as AnalysisFilterSectionId);
      latest?.invalidateFilterSectionLoadsForPatch({ unitsSelected: ['u1'] });
    });

    expect(latest?.getReloadFilterSections()).toEqual(['callsigns']);
    expect(latest?.isFilterSectionStale('callsigns')).toBe(true);

    await act(async () => {
      callsignsDeferred.resolve({ callsigns: [] });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latest?.getReloadFilterSections()).toEqual(['callsigns']);
    expect(latest?.isFilterSectionStale('callsigns')).toBe(true);
  });

  // @test-scope safeguard: prevents a failed targeted facet reload from silently dropping its retry
  it('keeps a failed targeted section queued for retry', async () => {
    await renderHook();

    await act(async () => {
      await latest?.loadFilterSection('callsigns');
      await Promise.resolve();
    });

    act(() => {
      latest?.invalidateFilterSectionLoadsForPatch({ unitsSelected: ['u1'] });
    });

    analysisApiMocks.fetchAnalysisCallsigns.mockRejectedValueOnce(new Error('boom'));

    const analysisReq = buildAnalysisReq({
      ...emptyQueryState(),
      fromDateTimeStr: '2026-03-30T08:00',
      toDateTimeStr: '2026-03-31T08:00',
    });
    if (analysisReq == null) throw new Error('expected analysis req');

    await act(async () => {
      await latest?.loadInitialFilterSections(analysisReq, {
        mode: 'targeted',
        sectionsToReload: ['callsigns'],
      });
      await Promise.resolve();
    });

    expect(latest?.getReloadFilterSections()).toEqual(['callsigns']);
  });

  // @test-scope safeguard: prevents tag changes from leaving stale facet counts cached for the next analysis reload
  it('marks the loaded tags facet stale and drops its cache so a reload refetches it', async () => {
    await renderHook();

    await act(async () => {
      await latest?.loadFilterSection('tags');
      await Promise.resolve();
    });

    expect(analysisApiMocks.fetchAnalysisTags).toHaveBeenCalledTimes(1);
    expect(latest?.isFilterSectionStale('tags')).toBe(false);

    act(() => {
      latest?.invalidateTagFacetLoad();
    });

    expect(latest?.isFilterSectionStale('tags')).toBe(true);

    // Cache key was dropped, so loading tags again re-hits the API.
    await act(async () => {
      await latest?.loadFilterSection('tags');
      await Promise.resolve();
    });

    expect(analysisApiMocks.fetchAnalysisTags).toHaveBeenCalledTimes(2);
  });

  it('leaves the tags facet untouched when it was never loaded', async () => {
    await renderHook();

    act(() => {
      latest?.invalidateTagFacetLoad();
    });

    expect(latest?.isFilterSectionStale('tags')).toBe(false);
    expect(analysisApiMocks.fetchAnalysisTags).not.toHaveBeenCalled();
  });

  it('refreshes an already-loaded tags facet', async () => {
    await renderHook();

    await act(async () => {
      await latest?.loadFilterSection('tags');
    });
    expect(analysisApiMocks.fetchAnalysisTags).toHaveBeenCalledTimes(1);

    await act(async () => {
      await latest?.refreshTagFacet();
    });

    expect(analysisApiMocks.fetchAnalysisTags).toHaveBeenCalledTimes(2);
  });

  it('does not refresh an unopened tags facet', async () => {
    await renderHook();

    await act(async () => {
      await latest?.refreshTagFacet();
    });

    expect(analysisApiMocks.fetchAnalysisTags).not.toHaveBeenCalled();
  });

  // @test-scope safeguard: prevents a late invalidated facet response from clearing the required reload
  it('moves an in-flight invalidated section to stale and keeps it queued for reload', async () => {
    const callsignsDeferred = deferred<{ callsigns: Array<{ callsign: string; res: [] }> }>();
    analysisApiMocks.fetchAnalysisCallsigns.mockImplementationOnce(() => callsignsDeferred.promise);

    await renderHook();

    await act(async () => {
      void latest?.loadFilterSection('callsigns' as AnalysisFilterSectionId);
      await Promise.resolve();
    });

    expect(latest?.isFilterSectionLoading('callsigns')).toBe(true);

    act(() => {
      latest?.invalidateFilterSectionLoadsForPatch({ unitsSelected: ['u1'] });
    });

    expect(latest?.isFilterSectionLoading('callsigns')).toBe(false);
    expect(latest?.isFilterSectionStale('callsigns')).toBe(true);
    expect(latest?.getReloadFilterSections()).toEqual(['callsigns']);

    await act(async () => {
      callsignsDeferred.resolve({ callsigns: [] });
      await Promise.resolve();
    });

    expect(latest?.isFilterSectionLoading('callsigns')).toBe(false);
    expect(latest?.isFilterSectionStale('callsigns')).toBe(true);
    expect(latest?.getReloadFilterSections()).toEqual(['callsigns']);
  });
});
