/**
 * @vitest-environment happy-dom
 */
import { act, createElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Unit } from '../../../../Bindings';
import { buildAnalysisReq, emptyQueryState } from './helpers';
import { buildFilterSectionsToLoad, filterSectionsToInvalidateForPatch, useAnalysisFilterSections } from './use-analysis-data-filter-sections';

const analysisApiMocks = vi.hoisted(() => ({
  fetchAnalysisGroups: vi.fn(),
  fetchAnalysisSenders: vi.fn(),
  fetchAnalysisTags: vi.fn(),
  fetchAnalysisUnits: vi.fn(),
  getLatestSenders: vi.fn(),
  getTagsMapForDisplay: vi.fn(),
}));

vi.mock('../../services/api/analysis', () => ({
  fetchAnalysisGroups: analysisApiMocks.fetchAnalysisGroups,
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

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  latest = null;
  analysisApiMocks.fetchAnalysisGroups.mockResolvedValue({ groups: [], groupNames: [] });
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
    expect(buildFilterSectionsToLoad(emptyQueryState(), [], false)).toEqual(['tags', 'groups', 'senders']);
  });

  it('reloads previously loaded lazy sections on a forced reload', () => {
    const sections = buildFilterSectionsToLoad(
      {
        ...emptyQueryState(),
        unitsSelected: ['u1'],
      },
      ['units', 'locations', 'posts'],
      true,
    );

    expect(sections).toEqual(expect.arrayContaining(['tags', 'groups', 'senders', 'units', 'locations', 'posts']));
  });

  it.each([
    ['tags', { tags: [1] }],
    ['unitsExactMatchOnly', { unitsExactMatchOnly: true }],
    ['metadataCc', { metadataCc: ['cc-1'] }],
    ['onlyWithMetadata', { onlyWithMetadata: true }],
    ['withoutMetadata', { withoutMetadata: true }],
    ['orWithoutCoords', { orWithoutCoords: true }],
    ['filterTagsOption', { filterTagsOption: 'AllTags' }],
    ['withoutModelTags', { withoutModelTags: true }],
    ['reportTagsOnlyThisUnit', { reportTagsOnlyThisUnit: true }],
    ['includePelengLocations', { includePelengLocations: false }],
  ] as const)('invalidates all option sections for %s changes', (_name, patch) => {
    expect(filterSectionsToInvalidateForPatch(patch)).toEqual([...ALL_OPTION_SECTIONS]);
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

  it('returns loaded matching sections when targeted invalidation hits them', async () => {
    await renderHook();

    await act(async () => {
      await latest?.loadFilterSection('units');
      await Promise.resolve();
    });

    act(() => {
      latest?.invalidateFilterSectionLoadsForPatch({ unitsSelected: ['u1'] });
    });

    expect(latest?.getReloadFilterSections()).toEqual(['units']);
  });

  it('keeps a failed targeted section queued for retry', async () => {
    await renderHook();

    await act(async () => {
      await latest?.loadFilterSection('units');
      await Promise.resolve();
    });

    act(() => {
      latest?.invalidateFilterSectionLoadsForPatch({ unitsSelected: ['u1'] });
    });

    analysisApiMocks.fetchAnalysisUnits.mockRejectedValueOnce(new Error('boom'));

    const analysisReq = buildAnalysisReq({
      ...emptyQueryState(),
      fromDateTimeStr: '2026-03-30T08:00',
      toDateTimeStr: '2026-03-31T08:00',
    });
    if (analysisReq == null) throw new Error('expected analysis req');

    await act(async () => {
      await latest?.loadInitialFilterSections(analysisReq, true, ['units']);
      await Promise.resolve();
    });

    expect(latest?.getReloadFilterSections()).toEqual(['units']);
  });
});
