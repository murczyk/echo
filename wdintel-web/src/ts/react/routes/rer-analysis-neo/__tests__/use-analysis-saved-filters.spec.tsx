/**
 * @vitest-environment happy-dom
 */
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SavedFilter } from '../../../../../Bindings';
import { buildAnalysisReq, emptyQueryState } from '../helpers';
import { buildUnitFilterOptions } from '../../../utils/unit-search';
import { buildUnitHierarchyIndex } from '../../shared/unit-children-filter';
import type { AnalysisQueryState } from '../types';
import { useAnalysisSavedFilters } from '../use-analysis-saved-filters';

const analysisApiMock = vi.hoisted(() => ({
  deleteAnalysisSavedFilter: vi.fn(),
  listAnalysisSavedFilters: vi.fn(),
  renameAnalysisSavedFilter: vi.fn(),
  upsertAnalysisSavedFilter: vi.fn(),
}));

vi.mock('../../../services/api/analysis', () => analysisApiMock);

type HookResult = ReturnType<typeof useAnalysisSavedFilters>;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: HookResult | null = null;
let currentQueryState: AnalysisQueryState | null = null;
let setCurrentQueryState: ((queryState: AnalysisQueryState) => void) | null = null;

function buildSavedFilter(): SavedFilter {
  const queryState = {
    ...emptyQueryState(),
    fromDateTimeStr: '2026-05-02T10:00',
    toDateTimeStr: '2026-05-02T11:00',
    freqsSelected: ['100.0000'],
    adjacentFreqsRange: 0.005,
  };
  const req = buildAnalysisReq(queryState, ['100.0000', '100.0030']);
  if (req == null) throw new Error('expected request to build');

  return {
    id: 1,
    name: 'Matched filter',
    req,
  };
}

function buildLegacyUnitFilter() {
  const unit = buildUnitFilterOptions([])[0];
  const unitHierarchy = buildUnitHierarchyIndex([
    { ...unit, id: 20, name: '27 омсбр', army: '6 А', brigade: '27 омсбр' },
    {
      ...unit,
      id: 21,
      name: '1 мср 27 омсбр',
      army: '6 А',
      brigade: '27 омсбр',
      company: '1 мср',
    },
  ]);
  const queryState = {
    ...emptyQueryState(),
    fromDateTimeStr: '2026-05-02T10:00',
    toDateTimeStr: '2026-05-02T11:00',
    unitsSelected: ['unit-id:20'],
    unitHierarchy,
  };
  const req = buildAnalysisReq({ ...queryState, unitsSelected: [] });
  if (req == null) throw new Error('expected request to build');
  const savedFilter: SavedFilter = {
    id: 2,
    name: 'Legacy parent filter',
    req: { ...req, selectedUnitIds: [20] },
    unitFilter: null,
  };
  return { queryState, savedFilter };
}

function Harness({
  allFrequencies,
  queryState,
}: {
  allFrequencies: string[];
  queryState: AnalysisQueryState;
}) {
  const [queryStateValue, setQueryStateValue] = useState(queryState);
  currentQueryState = queryStateValue;
  setCurrentQueryState = setQueryStateValue;
  latest = useAnalysisSavedFilters({
    allFrequencies,
    onError: vi.fn(),
    onUnauthorized: vi.fn(() => false),
    queryState: queryStateValue,
    setQueryState: setQueryStateValue,
  });
  return null;
}

async function renderHook(allFrequencies: string[], queryState = emptyQueryState()) {
  if (container == null) throw new Error('container not initialized');

  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(Harness, { allFrequencies, queryState }));
  });
}

async function rerenderHook(allFrequencies: string[], queryState = emptyQueryState()) {
  await act(async () => {
    root?.render(createElement(Harness, { allFrequencies, queryState }));
  });
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
describe('useAnalysisSavedFilters', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    latest = null;
    currentQueryState = null;
    setCurrentQueryState = null;

    analysisApiMock.listAnalysisSavedFilters.mockReset();
    analysisApiMock.listAnalysisSavedFilters.mockResolvedValue([buildSavedFilter()]);
    analysisApiMock.deleteAnalysisSavedFilter.mockReset();
    analysisApiMock.renameAnalysisSavedFilter.mockReset();
    analysisApiMock.upsertAnalysisSavedFilter.mockReset();
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container?.remove();
    container = null;
    latest = null;
    setCurrentQueryState = null;
  });

  it('#3527 keeps a legacy parent filter clean after applying it', async () => {
    const { queryState, savedFilter } = buildLegacyUnitFilter();
    analysisApiMock.listAnalysisSavedFilters.mockResolvedValue([savedFilter]);
    await renderHook([], { ...queryState, unitsSelected: [] });
    await flushEffects();

    await act(async () => {
      latest?.applySavedFilter(savedFilter);
    });
    await flushEffects();

    expect(currentQueryState?.unitsSelected).toEqual(['unit-id:20']);
    expect(buildAnalysisReq(currentQueryState!)?.selectedUnitIds).toEqual([20, 21]);
    expect(latest?.loadedSavedFilter?.id).toBe(savedFilter.id);
    expect(latest?.isDirty).toBe(false);

    await act(async () => {
      setCurrentQueryState?.({ ...currentQueryState!, unitsSelected: ['unit-id:21'] });
    });
    expect(latest?.isDirty).toBe(true);
  });

  it.each([false, true])(
    '#3527 preserves dirty state while a saved parent filter awaits catalog recovery: metadata=%s',
    async (withMetadata) => {
      const { queryState, savedFilter } = buildLegacyUnitFilter();
      if (withMetadata) {
        savedFilter.unitFilter = { values: ['unit-id:20'], includeChildren: false };
      }
      analysisApiMock.listAnalysisSavedFilters.mockResolvedValue([savedFilter]);
      await renderHook([], { ...queryState, unitsSelected: [], unitHierarchy: null });
      await flushEffects();
      await act(async () => latest?.applySavedFilter(savedFilter));
      expect(latest?.isDirty).toBe(false);
      expect(buildAnalysisReq(currentQueryState!)).toBeNull();

      await act(async () => setCurrentQueryState?.(queryState));
      expect(latest?.isDirty).toBe(false);
      await act(async () => setCurrentQueryState?.({ ...queryState, unitHierarchy: null }));
      expect(latest?.isDirty).toBe(false);

      await act(async () =>
        setCurrentQueryState?.({
          ...currentQueryState!,
          unitsSelected: ['unit-id:21'],
        }),
      );
      expect(latest?.isDirty).toBe(true);
      await act(async () =>
        setCurrentQueryState?.({ ...queryState, unitHierarchy: null, search: 'changed' }),
      );
      expect(latest?.isDirty).toBe(true);
    },
  );

  it.each([false, true])(
    '#3527 automatically matches a legacy parent filter when the catalog starts pending: %s',
    async (catalogPending) => {
      const { queryState, savedFilter } = buildLegacyUnitFilter();
      analysisApiMock.listAnalysisSavedFilters.mockResolvedValue([savedFilter]);
      await renderHook([], {
        ...queryState,
        unitHierarchy: catalogPending ? null : queryState.unitHierarchy,
      });
      await flushEffects();

      if (catalogPending) {
        expect(latest?.loadedSavedFilter).toBeNull();
        await act(async () => {
          setCurrentQueryState?.(queryState);
        });
        await flushEffects();
      }

      expect(latest?.loadedSavedFilter?.id).toBe(savedFilter.id);
      expect(latest?.savedFilterName).toBe(savedFilter.name);
      expect(latest?.isDirty).toBe(false);
    },
  );

  it('reselects a saved filter after frequency options load', async () => {
    const queryState = {
      ...emptyQueryState(),
      fromDateTimeStr: '2026-05-02T10:00',
      toDateTimeStr: '2026-05-02T11:00',
      freqsSelected: ['100.0000'],
      adjacentFreqsRange: 0.005,
    };

    await renderHook([], queryState);
    await flushEffects();
    expect(latest?.loadedSavedFilter).toBe(null);

    await rerenderHook(['100.0000', '100.0030'], queryState);
    await flushEffects();

    expect(latest?.loadedSavedFilter).toEqual(
      expect.objectContaining({ id: 1, name: 'Matched filter' }),
    );
    expect(latest?.savedFilterName).toBe('Matched filter');
  });

  it.each([true, false, null])(
    '#3940 marks a saved filter dirty when its RER scope changes: %s',
    async (onlyForRerReport) => {
      const savedFilter = buildSavedFilter();
      savedFilter.req.onlyForRerReport = onlyForRerReport;
      savedFilter.req.onlyWithNetwork = onlyForRerReport === null ? true : null;
      analysisApiMock.listAnalysisSavedFilters.mockResolvedValue([savedFilter]);
      await renderHook(['100.0000', '100.0030'], {
        ...emptyQueryState(),
        fromDateTimeStr: '2026-05-02T10:00',
        toDateTimeStr: '2026-05-02T11:00',
      });
      await flushEffects();
      await act(async () => latest?.applySavedFilter(savedFilter));

      const enabled = onlyForRerReport ?? true;
      expect(currentQueryState?.onlyWithNetwork).toBe(enabled);
      expect(latest?.isDirty).toBe(false);
      await act(async () =>
        setCurrentQueryState?.({ ...currentQueryState!, onlyWithNetwork: !enabled }),
      );
      expect(latest?.isDirty).toBe(true);
      await act(async () =>
        setCurrentQueryState?.({ ...currentQueryState!, onlyWithNetwork: enabled }),
      );
      expect(latest?.isDirty).toBe(false);
    },
  );

  it('clears the selected saved filter when applying null', async () => {
    const savedFilter = buildSavedFilter();
    await renderHook(['100.0000', '100.0030']);
    await flushEffects();

    await act(async () => {
      latest?.applySavedFilter(savedFilter);
    });
    await flushEffects();

    expect(latest?.loadedSavedFilter).toEqual(
      expect.objectContaining({ id: 1, name: 'Matched filter' }),
    );

    await act(async () => {
      latest?.applySavedFilter(null);
    });
    await flushEffects();

    expect(latest?.loadedSavedFilter).toBe(null);
    expect(latest?.savedFilterName).toBe('');
  });

  it('keeps units exact-match unset when applying a saved filter that leaves it unset', async () => {
    const savedFilter = buildSavedFilter();
    await renderHook(['100.0000', '100.0030'], emptyQueryState());
    await flushEffects();

    await act(async () => {
      latest?.applySavedFilter(savedFilter);
    });
    await flushEffects();

    expect(currentQueryState?.unitsExactMatchOnly).toBeNull();
  });
});
