/**
 * @vitest-environment happy-dom
 */
import { act, createElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Unit } from '../../../../Bindings';
import type { AnalysisFilterSectionId } from './types';
import { buildAnalysisReq, emptyQueryState } from './helpers';
import { buildFilterSectionsToLoad, filterSectionsToInvalidateForPatch, useAnalysisFilterSections } from './use-analysis-data-filter-sections';

const analysisApiMocks = vi.hoisted(() => ({
  fetchAnalysisGroups: vi.fn(),
  fetchAnalysisCallsigns: vi.fn(),
  fetchAnalysisSenders: vi.fn(),
  fetchAnalysisTags: vi.fn(),
  fetchAnalysisUnits: vi.fn(),
  getLatestSenders: vi.fn(),
  getTagsMapForDisplay: vi.fn(),
}));

vi.mock('../../services/api/analysis', () => ({
  fetchAnalysisGroups: analysisApiMocks.fetchAnalysisGroups,
  fetchAnalysisCallsigns: analysisApiMocks.fetchAnalysisCallsigns,
  fetchAnalysisSenders: analysisApiMocks.fetchAnalysisSenders,
  fetchAnalysisTags: analysisApiMocks.fetchAnalysisTags,
  fetchAnalysisUnits: analysisApiMocks.fetchAnalysisUnits,
  getLatestSenders: analysisApiMocks.getLatestSenders,
  getTagsMapForDisplay: analysisApiMocks.getTagsMapForDisplay,
}));

const ALL_OPTION_SECTIONS = ['tags', 'aors', 'groups', 'senders', 'callsigns', 'units', 'locations', 'posts', 'networks', 'metadata'] as const;

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
    setNetworkDisplayMap: vi.fn(),
    setNetworks: vi.fn(),
    setOptions: vi.fn(),
    setProfiles: vi.fn(),
    setTagsMap: vi.fn(),
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
  analysisApiMocks.getLatestSenders.mockResolvedValue({ data: {} });
  analysisApiMocks.getTagsMapForDisplay.mockResolvedValue({});
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

describe('buildFilterSectionsToLoad', () => {
  it('keeps the initial default sections for a normal load', () => {
    expect(
      buildFilterSectionsToLoad({
        mode: 'full',
        sectionsToReload: ['tags', 'groups', 'senders'],
        selectedSections: [],
        loadedSections: [],
      }),
    ).toEqual(['tags', 'groups', 'senders']);
  });

  it('loads selected sections on the first pass when nothing is cached yet', () => {
    const sections = buildFilterSectionsToLoad({
      mode: 'full',
      sectionsToReload: ['tags', 'groups', 'senders'],
      selectedSections: ['units', 'callsigns'],
      loadedSections: [],
    });

    expect(sections).toEqual(expect.arrayContaining(['tags', 'groups', 'senders', 'units', 'callsigns']));
  });

  it('reloads previously loaded lazy sections on a forced reload', () => {
    const sections = buildFilterSectionsToLoad({
      mode: 'full',
      sectionsToReload: ['tags', 'groups', 'senders', 'units', 'locations', 'posts'],
      selectedSections: [],
      loadedSections: ['units', 'locations', 'posts'],
    });

    expect(sections).toEqual(expect.arrayContaining(['tags', 'groups', 'senders', 'units', 'locations', 'posts']));
  });

  it('does not re-add selected sections on a reload when cached sections already exist', () => {
    const sections = buildFilterSectionsToLoad({
      mode: 'targeted',
      sectionsToReload: ['callsigns'],
    });

    expect(sections).toEqual(['callsigns']);
  });

  it.each([
    ['tags', { tags: [1] }, ['aors', 'groups', 'senders', 'callsigns', 'units', 'locations', 'posts', 'networks', 'metadata']],
    ['callsignsSelected', { callsignsSelected: ['a'] }, ['tags', 'aors', 'groups', 'senders', 'units', 'locations', 'posts', 'networks', 'metadata']],
    ['unitsSelected', { unitsSelected: ['u1'] }, ['tags', 'aors', 'groups', 'senders', 'callsigns', 'locations', 'posts', 'networks', 'metadata']],
    ['networksSelected', { networksSelected: ['1'] }, ['tags', 'aors', 'groups', 'senders', 'callsigns', 'units', 'locations', 'posts', 'metadata']],
    ['unitsExactMatchOnly', { unitsExactMatchOnly: true }, [...ALL_OPTION_SECTIONS]],
    ['metadataCc', { metadataCc: ['cc-1'] }, ['tags', 'aors', 'groups', 'senders', 'callsigns', 'units', 'locations', 'posts', 'networks']],
    ['onlyWithMetadata', { onlyWithMetadata: true }, ['tags', 'aors', 'groups', 'senders', 'callsigns', 'units', 'locations', 'posts', 'networks']],
    ['withoutMetadata', { withoutMetadata: true }, ['tags', 'aors', 'groups', 'senders', 'callsigns', 'units', 'locations', 'posts', 'networks']],
    ['orWithoutCoords', { orWithoutCoords: true }, [...ALL_OPTION_SECTIONS]],
    ['filterTagsOption', { filterTagsOption: 'AllTags' }, [...ALL_OPTION_SECTIONS]],
    ['withoutModelTags', { withoutModelTags: true }, [...ALL_OPTION_SECTIONS]],
    ['reportTagsOnlyThisUnit', { reportTagsOnlyThisUnit: true }, [...ALL_OPTION_SECTIONS]],
    ['includePelengLocations', { includePelengLocations: false }, [...ALL_OPTION_SECTIONS]],
  ] as const)('invalidates the expected option sections for %s changes', (_name, patch, expected) => {
    expect(filterSectionsToInvalidateForPatch(patch)).toEqual(expected);
  });

});

describe('useAnalysisFilterSections', () => {
  it('returns null when no targeted invalidation is pending', async () => {
    await renderHook();

    expect(latest?.getReloadFilterSections()).toBeNull();
  });

  it('returns an empty reload list when targeted invalidation does not hit a loaded section', async () => {
    await renderHook();

    act(() => {
      latest?.invalidateFilterSectionLoadsForPatch({ unitsSelected: ['u1'] });
    });

    expect(latest?.getReloadFilterSections()).toEqual([]);
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
