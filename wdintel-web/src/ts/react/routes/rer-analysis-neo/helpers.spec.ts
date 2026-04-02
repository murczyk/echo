import { describe, expect, it } from 'vitest';

import type { SavedFilter } from '../../../../Bindings';
import { RER_ANALYSIS_QUERY_STATE_KEY } from '../../../rer-analysis-query-state';
import {
  buildAnalysisReq,
  createInitialQueryState,
  buildInboxReq,
  parseQueryStateFromWindow,
  emptyQueryState,
  queryStateComparisonKey,
  queryStateFromSavedFilter,
  queryStateMatchesSavedFilter,
} from './helpers';
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
  it('treats managed url params as authoritative over stored query state', () => {
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        clear: () => storage.clear(),
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => {
          storage.delete(key);
        },
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
      },
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: {
          href: 'https://example.test/rer-analysis-neo?search=uid-1',
        },
      },
    });

    globalThis.localStorage.setItem(
      RER_ANALYSIS_QUERY_STATE_KEY,
      JSON.stringify({
        freqsSelected: ['123.4'],
        tags: [7],
      }),
    );

    expect(parseQueryStateFromWindow()).toMatchObject({
      search: 'uid-1',
      freqsSelected: [],
      tags: [],
    });

    delete (globalThis as { localStorage?: Storage }).localStorage;
    delete (globalThis as { window?: Window }).window;
  });

  it('ignores legacy state params on the neo page', () => {
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        clear: () => storage.clear(),
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => {
          storage.delete(key);
        },
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
      },
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: {
          href: 'https://example.test/rer-analysis-neo?state=%7B%22search%22%3A%22legacy%22%2C%22freqs_selected%22%3A%5B%22123.4%22%5D%7D',
        },
      },
    });

    globalThis.localStorage.setItem(
      RER_ANALYSIS_QUERY_STATE_KEY,
      JSON.stringify({
        search: 'stored',
        freqsSelected: ['432.1'],
      }),
    );

    expect(parseQueryStateFromWindow()).toMatchObject({
      search: 'stored',
      freqsSelected: ['432.1'],
    });

    delete (globalThis as { localStorage?: Storage }).localStorage;
    delete (globalThis as { window?: Window }).window;
  });

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

  it('preserves null unitsExactMatchOnly for server-default requests', () => {
    const state = createQueryState({ unitsExactMatchOnly: null, unitsSelected: ['Unit A'] });
    const analysisReq = buildAnalysisReq(state);
    const inboxReq = buildInboxReq(state);

    expect(analysisReq?.unitsExactMatchOnly).toBeNull();
    expect(inboxReq?.unitsExactMatchOnly).toBeNull();
  });

  it('starts neo query state with unitsExactMatchOnly unset', () => {
    expect(emptyQueryState().unitsExactMatchOnly).toBeNull();
  });

  it('derives default analysis dates in the app timezone', () => {
    const state = createInitialQueryState(emptyQueryState(), new Date(Date.UTC(2026, 0, 15, 22, 30, 0)));

    expect(state.dateToStr).toBe('2026-01-16');
    expect(state.timeToStr).toBe('00:30');
    expect(state.dateFromStr).toBe('2026-01-15');
    expect(state.timeFromStr).toBe('12:30');
  });

  it('fills missing times when only analysis dates are restored', () => {
    const state = createInitialQueryState(
      createQueryState({
        dateFromStr: '2026-01-15',
        timeFromStr: '',
        dateToStr: '2026-01-16',
        timeToStr: '',
      }),
      new Date(Date.UTC(2026, 0, 16, 10, 30, 0)),
    );

    expect(state.dateFromStr).toBe('2026-01-15');
    expect(state.timeFromStr).toBe('00:30');
    expect(state.dateToStr).toBe('2026-01-16');
    expect(state.timeToStr).toBe('12:30');
    expect(buildAnalysisReq(state)).not.toBeNull();
  });

  it('rejects malformed time bounds instead of building a date range', () => {
    expect(
      buildAnalysisReq(
        createQueryState({
          timeFromStr: '24:99',
        }),
      ),
    ).toBeNull();

    expect(
      buildAnalysisReq(
        createQueryState({
          timeToStr: '99:99',
        }),
      ),
    ).toBeNull();
  });

  it('resets adjacent frequency expansion when applying a saved filter', () => {
    const savedFilter = createSavedFilter(createQueryState({ freqsSelected: ['123.4'] }));
    const currentState = createQueryState({
      adjacentFreqsRange: 0.002,
      freqsSelected: ['999.9'],
    });

    const nextState = queryStateFromSavedFilter(savedFilter, currentState);

    expect(nextState.freqsSelected).toEqual(['123.4']);
    expect(nextState.adjacentFreqsRange).toBe(0);
  });
});
