/**
 * @vitest-environment happy-dom
 */
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SavedFilter } from '../../../../../Bindings';
import { buildAnalysisReq, emptyQueryState } from './helpers';
import type { AnalysisQueryState } from './types';
import { useAnalysisSavedFilters } from './use-analysis-saved-filters';

const analysisApiMock = vi.hoisted(() => ({
  deleteAnalysisSavedFilter: vi.fn(),
  listAnalysisSavedFilters: vi.fn(),
  renameAnalysisSavedFilter: vi.fn(),
  upsertAnalysisSavedFilter: vi.fn(),
}));

vi.mock('../../services/api/analysis', () => analysisApiMock);

type HookResult = ReturnType<typeof useAnalysisSavedFilters>;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: HookResult | null = null;
let currentQueryState: AnalysisQueryState | null = null;

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

function Harness({
  allFrequencies,
  queryState,
  unitsExactMatchOnlyDefault,
}: {
  allFrequencies: string[];
  queryState: AnalysisQueryState;
  unitsExactMatchOnlyDefault: boolean | null;
}) {
  const [queryStateValue, setQueryStateValue] = useState(queryState);
  currentQueryState = queryStateValue;
  latest = useAnalysisSavedFilters({
    allFrequencies,
    onError: vi.fn(),
    onUnauthorized: vi.fn(() => false),
    queryState: queryStateValue,
    unitsExactMatchOnlyDefault,
    setQueryState: setQueryStateValue,
  });
  return null;
}

async function renderHook(allFrequencies: string[], queryState = emptyQueryState(), unitsExactMatchOnlyDefault: boolean | null = null) {
  if (container == null) throw new Error('container not initialized');

  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(Harness, { allFrequencies, queryState, unitsExactMatchOnlyDefault }));
  });
}

async function rerenderHook(allFrequencies: string[], queryState = emptyQueryState(), unitsExactMatchOnlyDefault: boolean | null = null) {
  await act(async () => {
    root?.render(createElement(Harness, { allFrequencies, queryState, unitsExactMatchOnlyDefault }));
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
  });

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

    expect(latest?.loadedSavedFilter).toEqual(expect.objectContaining({ id: 1, name: 'Matched filter' }));
    expect(latest?.savedFilterName).toBe('Matched filter');
  });

  it('clears the selected saved filter when applying null', async () => {
    const savedFilter = buildSavedFilter();
    await renderHook(['100.0000', '100.0030']);
    await flushEffects();

    await act(async () => {
      latest?.applySavedFilter(savedFilter);
    });
    await flushEffects();

    expect(latest?.loadedSavedFilter).toEqual(expect.objectContaining({ id: 1, name: 'Matched filter' }));

    await act(async () => {
      latest?.applySavedFilter(null);
    });
    await flushEffects();

    expect(latest?.loadedSavedFilter).toBe(null);
    expect(latest?.savedFilterName).toBe('');
  });

  it('applies the loaded default when a saved filter leaves units exact-match unset', async () => {
    const savedFilter = buildSavedFilter();
    await renderHook(['100.0000', '100.0030'], emptyQueryState(), true);
    await flushEffects();

    await act(async () => {
      latest?.applySavedFilter(savedFilter);
    });
    await flushEffects();

    expect(currentQueryState?.unitsExactMatchOnly).toBe(true);
  });
});
