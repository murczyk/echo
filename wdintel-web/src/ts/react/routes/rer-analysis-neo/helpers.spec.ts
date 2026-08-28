import { describe, expect, it } from 'vitest';

import type { SavedFilter } from '../../../../Bindings';
import {
  buildAnalysisReq,
  createInitialQueryState,
  createResetQueryState,
  buildInboxReq,
  extendQueryDateRangeForDirectMessage,
  hasMeaningfulFiltersBeyondDateRange,
  hasMeaningfulUiFiltersBeyondDateRange,
  parseQueryStateFromWindow,
  emptyQueryState,
  normalizeQueryState,
  queryStateComparisonKey,
  queryStateReloadKey,
  queryStateUiComparisonKey,
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
  it('treats managed url params as authoritative', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: {
          href: 'https://example.test/rer-analysis-neo?search=uid-1',
        },
      },
    });

    expect(parseQueryStateFromWindow()).toMatchObject({
      search: 'uid-1',
      freqsSelected: [],
      tags: [],
    });

    delete (globalThis as { window?: Window }).window;
  });

  it('ignores unsupported legacy state params when managed url params are absent', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: {
          href: 'https://example.test/rer-analysis-neo?state=%7B%22search%22%3A%22legacy%22%2C%22freqs_selected%22%3A%5B%22123.4%22%5D%7D',
        },
      },
    });

    expect(parseQueryStateFromWindow()).toEqual(emptyQueryState());

    delete (globalThis as { window?: Window }).window;
  });

  it('writes hidden selections only to the url while request normalization still excludes them', () => {
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
      onlyWithMedia: true,
    });

    pushQueryStateToUrl(state);

    const nextUrl = new URL(currentUrl);
    expect(nextUrl.searchParams.getAll('networks')).toEqual(['7']);
    expect(nextUrl.searchParams.get('withoutNetwork')).toBe('true');
    expect(nextUrl.searchParams.getAll('metadataCc')).toEqual(['cc-1']);
    expect(nextUrl.searchParams.getAll('metadataSender')).toEqual(['sender-1']);
    expect(nextUrl.searchParams.getAll('metadataReceiver')).toEqual(['receiver-1']);
    expect(nextUrl.searchParams.getAll('metadataHash')).toEqual(['hash-1']);
    expect(nextUrl.searchParams.get('only_with_media')).toBe('true');
    expect(parseQueryStateFromWindow()).toMatchObject({
      withoutNetwork: true,
      networksSelected: ['7'],
      withoutMetadata: true,
      metadataCc: ['cc-1'],
      metadataSender: ['sender-1'],
      metadataReceiver: ['receiver-1'],
      metadataHash: ['hash-1'],
      onlyWithMedia: true,
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
    expect(buildInboxReq(state, [], true)?.onlyWithMedia).toBe(true);
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
    expect(queryStateComparisonKey(changedState)).not.toBe(
      queryStateComparisonKey(createQueryState()),
    );
  });

  it('includes onlyWithMedia in the ui comparison key and dirty state while ignoring it for saved filters', () => {
    const baseState = createResetQueryState();
    const savedFilter = createSavedFilter(baseState);
    const mediaState = { ...baseState, onlyWithMedia: true };

    expect(queryStateUiComparisonKey(mediaState)).not.toBe(queryStateUiComparisonKey(baseState));
    expect(queryStateMatchesSavedFilter(mediaState, savedFilter)).toBe(true);
    expect(hasMeaningfulFiltersBeyondDateRange(mediaState)).toBe(false);
    expect(hasMeaningfulUiFiltersBeyondDateRange(mediaState)).toBe(true);
  });

  it('preserves null unitsExactMatchOnly for server-default requests', () => {
    const state = createQueryState({ unitsExactMatchOnly: null, unitsSelected: ['Unit A'] });
    const analysisReq = buildAnalysisReq(state);
    const inboxReq = buildInboxReq(state);

    expect(analysisReq?.unitsExactMatchOnly).toBeNull();
    expect(inboxReq?.unitsExactMatchOnly).toBeNull();
  });

  it('keeps inbox-only media filtering out of the analysis request while passing it to the inbox request', () => {
    const state = createQueryState({ onlyWithMedia: true });

    expect(buildAnalysisReq(state)).toMatchObject({
      onlyWithMetadata: false,
      withoutMetadata: false,
    });
    expect(buildInboxReq(state, [], true)?.onlyWithMedia).toBe(true);
  });

  it('starts neo query state with unitsExactMatchOnly unset', () => {
    expect(emptyQueryState().unitsExactMatchOnly).toBeNull();
  });

  it('routes selected tags to selectedTags in include mode', () => {
    const state = createQueryState({ tags: [3, 7], tagsExcludeMode: false });
    const analysisReq = buildAnalysisReq(state);
    const inboxReq = buildInboxReq(state);

    expect(analysisReq?.selectedTags).toEqual([3, 7]);
    expect(analysisReq?.deniedTags).toBeNull();
    expect(inboxReq?.selectedTags).toEqual([3, 7]);
    expect(inboxReq?.deniedTags).toBeNull();
  });

  it('routes selected tags to deniedTags in exclude mode', () => {
    const state = createQueryState({ tags: [3, 7], tagsExcludeMode: true });
    const analysisReq = buildAnalysisReq(state);
    const inboxReq = buildInboxReq(state);

    expect(analysisReq?.selectedTags).toBeNull();
    expect(analysisReq?.deniedTags).toEqual([3, 7]);
    expect(inboxReq?.selectedTags).toBeNull();
    expect(inboxReq?.deniedTags).toEqual([3, 7]);
  });

  it('round-trips exclude mode through saved filters', () => {
    const state = createQueryState({
      tags: [3, 7],
      tagsExcludeMode: true,
    });
    const savedFilter = createSavedFilter(state);
    const restored = queryStateFromSavedFilter(savedFilter, createResetQueryState());

    expect(restored.tags).toEqual([3, 7]);
    expect(restored.tagsExcludeMode).toBe(true);
  });

  it('normalizes selected callsigns for case-sensitive backend filtering', () => {
    expect(
      normalizeQueryState(createQueryState({ callsignsSelected: ['alpha', 'Bravo', ' BRAVO '] }))
        .callsignsSelected,
    ).toEqual(['alpha', 'bravo']);
  });

  it('persists device-name selections in requests and saved filters', () => {
    const state = createQueryState({ deviceNamesSelected: ['cyber-echo-01'] });
    const savedFilter = createSavedFilter(state);
    const restored = queryStateFromSavedFilter(savedFilter, createResetQueryState());

    expect(buildAnalysisReq(state)?.selectedDeviceNames).toEqual(['cyber-echo-01']);
    expect(buildInboxReq(state)?.selectedDeviceNames).toEqual(['cyber-echo-01']);
    expect(restored.deviceNamesSelected).toEqual(['cyber-echo-01']);
  });

  it('normalizes legacy unit aliases in query state normalization', () => {
    expect(
      normalizeQueryState(createQueryState({ unitsSelected: ['Не визначено', 'Unit A', ''] }))
        .unitsSelected,
    ).toEqual(['', 'Unit A']);
  });

  it('preserves standalone without-coords and with-coords flags through normalization and request building', () => {
    const withoutCoordsState = createQueryState({ orWithoutCoords: true });
    const withCoordsState = createQueryState({ orWithCoords: true });

    expect(normalizeQueryState(withoutCoordsState)).toMatchObject({
      orWithCoords: false,
      orWithoutCoords: true,
    });
    expect(normalizeQueryState(withCoordsState)).toMatchObject({
      orWithCoords: true,
      orWithoutCoords: false,
    });
    expect(buildAnalysisReq(withoutCoordsState)?.orWithoutCoords).toBe(true);
    expect(buildAnalysisReq(withoutCoordsState)?.orWithCoords).toBe(false);
    expect(buildAnalysisReq(withCoordsState)?.orWithCoords).toBe(true);
    expect(buildAnalysisReq(withCoordsState)?.orWithoutCoords).toBe(false);
  });

  it('clears both coordinate flags only when both are set', () => {
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
    const state = createInitialQueryState(
      emptyQueryState(),
      new Date(Date.UTC(2026, 0, 15, 22, 30, 0)),
    );

    expect(state.fromDateTimeStr).toBe('2026-01-16T00:00');
    expect(state.toDateTimeStr).toBe('2026-01-17T00:00');
  });

  it('extends a direct-link range from the day before the message through today', () => {
    const state = createQueryState({
      fromDateTimeStr: '2026-08-28T00:00',
      toDateTimeStr: '2026-08-29T00:00',
    });

    const next = extendQueryDateRangeForDirectMessage(
      state,
      { date: '2026-08-20', timestamp: null },
      new Date(Date.UTC(2026, 7, 28, 12)),
    );

    expect(next.fromDateTimeStr).toBe('2026-08-19T00:00');
    expect(next.toDateTimeStr).toBe('2026-08-29T00:00');
  });

  it('keeps earlier bounds and extends a direct-link range forward through today', () => {
    const state = createQueryState({
      fromDateTimeStr: '2026-08-18T00:00',
      toDateTimeStr: '2026-08-21T00:00',
    });

    const next = extendQueryDateRangeForDirectMessage(
      state,
      { date: '2026-08-20', timestamp: null },
      new Date(Date.UTC(2026, 7, 28, 12)),
    );

    expect(next.fromDateTimeStr).toBe('2026-08-18T00:00');
    expect(next.toDateTimeStr).toBe('2026-08-29T00:00');
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

  it('rejects inverted analysis date ranges but allows equal bounds', () => {
    expect(
      buildAnalysisReq(
        createQueryState({
          fromDateTimeStr: '2026-03-31T08:00',
          toDateTimeStr: '2026-03-31T08:00',
        }),
      ),
    ).not.toBeNull();

    expect(
      buildAnalysisReq(
        createQueryState({
          fromDateTimeStr: '2026-03-31T09:00',
          toDateTimeStr: '2026-03-31T08:00',
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
