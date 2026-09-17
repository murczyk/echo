import { describe, expect, it } from 'vitest';

import type { SavedFilter } from '../../../../../Bindings';
import {
  buildAnalysisReq,
  buildSavedFilterReq,
  createResetQueryState,
  buildInboxReq,
  buildInboxOverallCountReq,
  parseQueryStateFromWindow,
  emptyQueryState,
  normalizeQueryState,
  queryStateComparisonKey,
  queryStateFromSavedFilter,
  queryStateMatchesSavedFilter,
  pushQueryStateToUrl,
} from '../helpers';
import type { AnalysisQueryState } from '../types';

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
  // @test-scope parser: preserves managed analysis URL query normalization.
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

  // @test-scope parser: rejects unsupported legacy analysis URL state.
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

  // @test-scope parser: preserves URL and request-wire normalization for hidden analysis selections.
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

  // @test-scope parser: preserves analysis and inbox request time-basis wire values.
  it('sends the creation date basis to analysis and inbox requests', () => {
    const state = createQueryState({
      messageTimeBasis: 'creation',
      fromDateTimeStr: '2026-08-28T00:00',
      toDateTimeStr: '2026-08-29T00:00',
      groupsSelected: ['group'],
      freqsSelected: ['100.0'],
    });

    expect(buildAnalysisReq(state)?.messageTimeBasis).toBe('creation');
    expect(buildInboxReq(state)?.sortBy).toBe('IMSCreatedAt');
    expect(buildInboxOverallCountReq(state)).toMatchObject({
      sortBy: 'IMSCreatedAt',
      sinceDateInclusiveMs: Date.UTC(2026, 7, 27, 21),
      tillDateInclusiveMs: Date.UTC(2026, 7, 28, 21),
      selectedGroups: null,
      selectedFreqs: null,
    });
    expect(buildInboxOverallCountReq(createQueryState())?.sortBy).toBeNull();
  });

  // @test-scope parser: preserves server-default unit matching request values.
  it('preserves null unitsExactMatchOnly for server-default requests', () => {
    const state = createQueryState({ unitsExactMatchOnly: null, unitsSelected: ['Unit A'] });
    const analysisReq = buildAnalysisReq(state);
    const inboxReq = buildInboxReq(state);

    expect(analysisReq?.unitsExactMatchOnly).toBeNull();
    expect(inboxReq?.unitsExactMatchOnly).toBeNull();
  });

  // @test-scope parser: normalizes numeric unit selections onto request identifiers.
  it('routes numeric unit selections through stable id fields', () => {
    const state = createQueryState({
      unitsSelected: ['unit-id:42', 'Legacy unit'],
      unitsExactMatchOnly: true,
    });
    const analysisReq = buildAnalysisReq(state);
    const inboxReq = buildInboxReq(state);

    expect(analysisReq).toMatchObject({
      selectedUnitIds: [42],
      selectedUnits: ['Legacy unit'],
      unitsExactMatchOnly: true,
    });
    expect(inboxReq).toMatchObject({
      selectedUnitIds: [42],
      selectedUnits: ['Legacy unit'],
      unitsExactMatchOnly: true,
    });
  });

  // @test-scope parser: preserves supported legacy unit selection values.
  it('preserves undefined and numeric-looking legacy unit selections', () => {
    const req = buildAnalysisReq(
      createQueryState({ unitsSelected: ['', '01', '123', '1e3'], unitsExactMatchOnly: true }),
    );

    expect(req).toMatchObject({
      selectedUnitIds: null,
      selectedUnits: ['', '01', '123', '1e3'],
      unitsExactMatchOnly: true,
    });
  });

  // @test-scope parser: normalizes legacy unit matching request compatibility.
  it('disables legacy exact matching for id-only unit selections', () => {
    const state = createQueryState({
      unitsSelected: ['unit-id:42'],
      unitsExactMatchOnly: true,
    });

    expect(buildAnalysisReq(state)?.unitsExactMatchOnly).toBeNull();
    expect(buildInboxReq(state)?.unitsExactMatchOnly).toBeNull();
  });

  // @test-scope parser: separates inbox-only media filtering from analysis request fields.
  it('keeps inbox-only media filtering out of the analysis request while passing it to the inbox request', () => {
    const state = createQueryState({ onlyWithMedia: true });

    expect(buildAnalysisReq(state)).toMatchObject({
      onlyWithMetadata: false,
      withoutMetadata: false,
    });
    expect(buildInboxReq(state, [], true)?.onlyWithMedia).toBe(true);
  });

  // @test-scope parser: maps included tags to the analysis request wire field.
  it('routes selected tags to selectedTags in include mode', () => {
    const state = createQueryState({ tags: [3, 7], tagsExcludeMode: false });
    const analysisReq = buildAnalysisReq(state);
    const inboxReq = buildInboxReq(state);

    expect(analysisReq?.selectedTags).toEqual([3, 7]);
    expect(analysisReq?.deniedTags).toBeNull();
    expect(inboxReq?.selectedTags).toEqual([3, 7]);
    expect(inboxReq?.deniedTags).toBeNull();
  });

  // @test-scope parser: maps excluded tags to the analysis request wire field.
  it('routes selected tags to deniedTags in exclude mode', () => {
    const state = createQueryState({ tags: [3, 7], tagsExcludeMode: true });
    const analysisReq = buildAnalysisReq(state);
    const inboxReq = buildInboxReq(state);

    expect(analysisReq?.selectedTags).toBeNull();
    expect(analysisReq?.deniedTags).toEqual([3, 7]);
    expect(inboxReq?.selectedTags).toBeNull();
    expect(inboxReq?.deniedTags).toEqual([3, 7]);
  });

  // @test-scope parser: preserves excluded-tag mode through saved-filter request normalization.
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

  // @test-scope parser: normalizes callsign request values for backend filtering.
  it('normalizes selected callsigns for case-sensitive backend filtering', () => {
    expect(
      normalizeQueryState(createQueryState({ callsignsSelected: ['alpha', 'Bravo', ' BRAVO '] }))
        .callsignsSelected,
    ).toEqual(['alpha', 'bravo']);
  });

  // @test-scope parser: preserves device-name selections in request and saved-filter wire values.
  it('persists device-name selections in requests and saved filters', () => {
    const state = createQueryState({ deviceNamesSelected: ['cyber-echo-01'] });
    const savedFilter = createSavedFilter(state);
    const restored = queryStateFromSavedFilter(savedFilter, createResetQueryState());

    expect(buildAnalysisReq(state)?.selectedDeviceNames).toEqual(['cyber-echo-01']);
    expect(buildInboxReq(state)?.selectedDeviceNames).toEqual(['cyber-echo-01']);
    expect(restored.deviceNamesSelected).toEqual(['cyber-echo-01']);
  });

  // @test-scope parser: normalizes legacy unit aliases at the analysis request boundary.
  it('normalizes legacy unit aliases in query state normalization', () => {
    expect(
      normalizeQueryState(createQueryState({ unitsSelected: ['Не визначено', 'Unit A', ''] }))
        .unitsSelected,
    ).toEqual(['', 'Unit A']);
  });

  // @test-scope parser: preserves coordinate filter request flags through normalization.
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

  // @test-scope parser: normalizes conflicting coordinate filter request flags.
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

  // @test-scope parser: rejects malformed analysis request date-time wire values.
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

  // @test-scope parser: rejects inverted analysis request date-time wire values.
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

  // @test-scope regression: https://github.com/echoua/echo/issues/3455
  it('keeps the active creation-time preference when applying a saved filter', () => {
    const savedFilter = createSavedFilter(createQueryState({ freqsSelected: ['123.4'] }));
    const currentState = createQueryState({
      messageTimeBasis: 'creation',
      freqsSelected: ['999.9'],
    });

    const nextState = queryStateFromSavedFilter(savedFilter, currentState);

    expect(nextState.messageTimeBasis).toBe('creation');
    expect(nextState.freqsSelected).toEqual(['123.4']);
  });

  // @test-scope regression: https://github.com/echoua/echo/issues/3455
  it('ignores the active time preference when matching saved filters', () => {
    const interception = createQueryState({ messageTimeBasis: 'interception' });
    const creation = createQueryState({ messageTimeBasis: 'creation' });
    const savedFilter = createSavedFilter(interception);

    expect(queryStateComparisonKey(creation)).toBe(queryStateComparisonKey(interception));
    expect(queryStateMatchesSavedFilter(creation, savedFilter)).toBe(true);
  });

  // @test-scope regression: https://github.com/echoua/echo/issues/3455
  it('does not persist the active time preference in saved-filter requests', () => {
    const req = buildSavedFilterReq(createQueryState({ messageTimeBasis: 'creation' }));

    expect(req).not.toBeNull();
    expect(req?.messageTimeBasis).toBeNull();
  });
});
