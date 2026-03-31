import { describe, expect, it } from 'vitest';

import type { SavedFilter } from '../../../../Bindings';
import { buildAnalysisReq, emptyQueryState, queryStateComparisonKey, queryStateMatchesSavedFilter } from './helpers';
import type { AnalysisQueryState } from './types';

function createQueryState(overrides: Partial<AnalysisQueryState> = {}): AnalysisQueryState {
  return {
    ...emptyQueryState(),
    dateFromStr: '2026-03-30',
    timeFromStr: '08:00',
    dateToStr: '2026-03-31',
    timeToStr: '08:00',
    groupsSelected: ['Alpha'],
    search: 'signal',
    ...overrides,
  };
}

function createSavedFilter(reqState: AnalysisQueryState): SavedFilter {
  const req = buildAnalysisReq(reqState);
  if (req == null) {
    throw new Error('Expected valid analysis request for test setup');
  }

  return {
    id: 1,
    name: 'Saved filter',
    req,
  } as SavedFilter;
}

describe('rer-analysis-neo helpers', () => {
  it('keeps the saved filter clean when only the date range differs', () => {
    const savedFilter = createSavedFilter(createQueryState());
    const currentState = createQueryState({
      dateFromStr: '2026-03-31',
      timeFromStr: '10:30',
      dateToStr: '2026-03-31',
      timeToStr: '12:30',
    });

    expect(queryStateMatchesSavedFilter(currentState, savedFilter)).toBe(true);
    expect(queryStateComparisonKey(currentState)).toBe(queryStateComparisonKey(createQueryState()));
  });

  it('treats non-date filter changes as dirty', () => {
    const savedFilter = createSavedFilter(createQueryState());
    const changedState = createQueryState({ groupsSelected: ['Bravo'] });

    expect(queryStateMatchesSavedFilter(changedState, savedFilter)).toBe(false);
    expect(queryStateComparisonKey(changedState)).not.toBe(queryStateComparisonKey(createQueryState()));
  });
});
