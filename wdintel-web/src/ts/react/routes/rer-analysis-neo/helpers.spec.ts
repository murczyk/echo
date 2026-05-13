import { describe, expect, it } from 'vitest';

import type { SavedFilter } from '../../../../Bindings';
import { RER_ANALYSIS_QUERY_STATE_KEY } from '../../../rer-analysis-query-state';
import {
  buildAnalysisReq,
  createInitialQueryState,
  buildInboxReq,
  parseQueryStateFromWindow,
  emptyQueryState,
  normalizeQueryState,
  queryStateComparisonKey,
  queryStateReloadKey,
  queryStateFromSavedFilter,
  queryStateMatchesSavedFilter,
  pushQueryStateToUrl,
  shouldOpenAnalysisMapFromSearchParams,
} from './helpers';
import type { AnalysisQueryState } from './types';

function createQueryState(overrides: Partial<AnalysisQueryState> = {}): AnalysisQueryState {
  return {
    ...emptyQueryState(),
    fromDateTimeStr: '2026-03-30T08:00',
    toDateTimeStr: '2026-03-31T08:00',
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

  it('uses stored query state when managed url params are absent', () => {
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

  it('preserves hidden selections in persistence while request normalization still excludes them', () => {
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

    let currentUrl = 'https://example.test/rer-analysis-neo';
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: {
          get href() {
            return currentUrl;
          },
          set href(value: string) {
            currentUrl = value;
          },
        },
        history: {
          replaceState: (_state: unknown, _title: string, nextUrl: string) => {
            currentUrl = `https://example.test${nextUrl}`;
          },
        },
      },
    });

    const state = createQueryState({
      withoutNetwork: true,
      networksSelected: ['7'],
      withoutMetadata: true,
      metadataCc: ['cc-1'],
      metadataSender: ['sender-1'],
      metadataReceiver: ['receiver-1'],
      metadataHash: ['hash-1'],
    });

    pushQueryStateToUrl(state);

    expect(JSON.parse(storage.get(RER_ANALYSIS_QUERY_STATE_KEY) ?? '{}')).toMatchObject({
      withoutNetwork: true,
      networksSelected: ['7'],
      withoutMetadata: true,
      metadataCc: ['cc-1'],
      metadataSender: ['sender-1'],
      metadataReceiver: ['receiver-1'],
      metadataHash: ['hash-1'],
    });

    expect(parseQueryStateFromWindow()).toMatchObject({
      withoutNetwork: true,
      networksSelected: ['7'],
      withoutMetadata: true,
      metadataCc: ['cc-1'],
      metadataSender: ['sender-1'],
      metadataReceiver: ['receiver-1'],
      metadataHash: ['hash-1'],
    });

    expect(buildAnalysisReq(state)).toMatchObject({
      withoutNetwork: true,
      selectedNetworks: null,
      withoutMetadata: true,
      metadataCc: null,
      metadataSender: null,
      metadataReceiver: null,
      metadataHash: null,
    });

    delete (globalThis as { localStorage?: Storage }).localStorage;
    delete (globalThis as { window?: Window }).window;
  });

  it('keeps the saved filter clean when only the date range differs', () => {
    const savedFilter = createSavedFilter(createQueryState());
    const currentState = createQueryState({
      fromDateTimeStr: '2026-03-31T10:30',
      toDateTimeStr: '2026-03-31T12:30',
    });

    expect(queryStateMatchesSavedFilter(currentState, savedFilter)).toBe(true);
    expect(queryStateComparisonKey(currentState)).toBe(queryStateComparisonKey(createQueryState()));
    expect(queryStateReloadKey(currentState)).not.toBe(queryStateReloadKey(createQueryState()));
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

  it('preserves selected callsign casing for case-sensitive backend filtering', () => {
    expect(normalizeQueryState(createQueryState({ callsignsSelected: ['alpha', 'Bravo'] })).callsignsSelected).toEqual([
      'alpha',
      'Bravo',
    ]);
  });

  it('normalizes legacy peleng flags so both true becomes the neutral all state', () => {
    expect(
      normalizeQueryState(
        createQueryState({
          orWithCoords: true,
          orWithoutCoords: true,
        }),
      ),
    ).toMatchObject({
      orWithCoords: false,
      orWithoutCoords: false,
    });
  });

  it('derives default analysis dates from today to tomorrow in the app timezone', () => {
    const state = createInitialQueryState(emptyQueryState(), new Date(Date.UTC(2026, 0, 15, 22, 30, 0)));

    expect(state.fromDateTimeStr).toBe('2026-01-16T00:00');
    expect(state.toDateTimeStr).toBe('2026-01-17T00:00');
  });

  it('fills missing datetime bounds when only analysis dates are restored', () => {
    const state = createInitialQueryState(
      createQueryState({
        fromDateTimeStr: '',
        toDateTimeStr: '',
      }),
      new Date(Date.UTC(2026, 0, 16, 10, 30, 0)),
    );

    expect(state.fromDateTimeStr).toBe('2026-01-16T00:00');
    expect(state.toDateTimeStr).toBe('2026-01-17T00:00');
    expect(buildAnalysisReq(state)).not.toBeNull();
  });

  it('rejects malformed time bounds instead of building a date range', () => {
    expect(
      buildAnalysisReq(
        createQueryState({
          fromDateTimeStr: '2026-01-15T24:99',
        }),
      ),
    ).toBeNull();

    expect(
      buildAnalysisReq(
        createQueryState({
          toDateTimeStr: '2026-01-16T99:99',
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

  it('detects showMap deep link for duty → analysis map tab', () => {
    expect(shouldOpenAnalysisMapFromSearchParams(new URLSearchParams('showMap=true'))).toBe(true);
    expect(shouldOpenAnalysisMapFromSearchParams(new URLSearchParams('showMap=1'))).toBe(false);
    expect(shouldOpenAnalysisMapFromSearchParams(new URLSearchParams(''))).toBe(false);
    expect(shouldOpenAnalysisMapFromSearchParams(new URLSearchParams('showMap=false'))).toBe(false);
  });
});
