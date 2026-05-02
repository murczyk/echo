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

function Harness({ allFrequencies, queryState }: { allFrequencies: string[]; queryState: AnalysisQueryState }) {
  const [currentQueryState, setCurrentQueryState] = useState(queryState);
  latest = useAnalysisSavedFilters({
    allFrequencies,
    onError: vi.fn(),
    onUnauthorized: vi.fn(() => false),
    queryState: currentQueryState,
    setQueryState: setCurrentQueryState,
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
});
