import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  compactRerAnalysisQueryState,
  hasRerAnalysisQueryStateParams,
  loadRerAnalysisQueryState,
  normalizeRerAnalysisQueryState,
  parseRerAnalysisQueryStateFromSearchParams,
  RER_ANALYSIS_QUERY_STATE_KEY,
  saveRerAnalysisQueryState,
  writeRerAnalysisQueryStateToSearchParams,
} from './rer-analysis-query-state';
import {
  loadLegacyRerAnalysisQueryState,
  parseRerAnalysisLegacyState,
  RER_ANALYSIS_LEGACY_QUERY_STATE_KEY,
  saveLegacyRerAnalysisQueryState,
} from './rer-analysis-query-state-legacy';

describe('rer analysis query state', () => {
  beforeEach(() => {
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
  });

  beforeEach(() => {
    globalThis.localStorage.clear();
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it('normalizes legacy snake_case keys through the legacy adapter', () => {
    expect(
      parseRerAnalysisLegacyState(
        JSON.stringify({
          date_from_str: '2026-03-27',
          time_from_str: '21:52',
          freqs_selected: ['123.4'],
          without_network: true,
          metadata_cc: ['cc-1'],
          include_peleng_locations: false,
          adjacent_freqs_range: 0.002,
          filter_tags_option: 'AllOfTags',
          report_tags_only_this_unit: true,
        }),
      ),
    ).toEqual({
      dateFromStr: '2026-03-27',
      timeFromStr: '21:52',
      freqsSelected: ['123.4'],
      withoutNetwork: true,
      metadataCc: ['cc-1'],
      includePelengLocations: false,
      unitsExactMatchOnly: null,
      adjacentFreqsRange: 0.002,
      filterTagsOption: 'AllTags',
      reportTagsOnlyThisUnit: true,
    });
  });

  it('keeps canonical normalization limited to canonical keys', () => {
    expect(
      normalizeRerAnalysisQueryState({
        date_from_str: '2026-03-27',
        search: 'abc',
      }),
    ).toEqual({
      search: 'abc',
    });
  });

  it('preserves an unset unitsExactMatchOnly state for legacy state payloads', () => {
    expect(parseRerAnalysisLegacyState(JSON.stringify({ search: 'abc' }))).toEqual({
      search: 'abc',
      unitsExactMatchOnly: null,
    });
  });

  it('compacts query state before persisting it', () => {
    const compacted = compactRerAnalysisQueryState({
      dateFromStr: '2026-03-27',
      timeFromStr: '21:52',
      dateToStr: '2026-03-28',
      timeToStr: '09:52',
      includeOnlyNewFreqs: true,
      freqsSelected: ['123.4', '123.5'],
      groupsSelected: [],
      withoutNetwork: false,
      includePelengLocations: true,
      unitsExactMatchOnly: null,
      filterTagsOption: 'OneOfTags',
      reportTagsOnlyThisUnit: false,
      date_from_str: 'legacy-should-not-win',
    });

    expect(compacted).toEqual({
      dateFromStr: '2026-03-27',
      timeFromStr: '21:52',
      dateToStr: '2026-03-28',
      timeToStr: '09:52',
      includeOnlyNewFreqs: true,
      freqsSelected: ['123.4', '123.5'],
    });
  });

  it('loads stored canonical state in normalized form', () => {
    globalThis.localStorage.setItem(
      RER_ANALYSIS_QUERY_STATE_KEY,
      JSON.stringify({
        search: 'abc',
        metadataSender: ['sigint'],
        withoutModelTags: true,
      }),
    );

    expect(loadRerAnalysisQueryState()).toEqual({
      search: 'abc',
      metadataSender: ['sigint'],
      withoutModelTags: true,
    });
  });

  it('loads stored legacy state through the legacy storage key', () => {
    globalThis.localStorage.setItem(
      RER_ANALYSIS_LEGACY_QUERY_STATE_KEY,
      JSON.stringify({
        search: 'abc',
        metadata_sender: ['sigint'],
        without_model_tags: true,
      }),
    );

    expect(loadLegacyRerAnalysisQueryState()).toEqual({
      search: 'abc',
      metadataSender: ['sigint'],
      unitsExactMatchOnly: null,
      withoutModelTags: true,
    });
  });

  it('saves only compact canonical state', () => {
    saveRerAnalysisQueryState({
      search: 'uid-1',
      groupsSelected: [],
      without_network: false,
      include_peleng_locations: true,
      metadata_hash: [],
      unitsExactMatchOnly: null,
    });

    expect(globalThis.localStorage.getItem(RER_ANALYSIS_QUERY_STATE_KEY)).toBe(JSON.stringify({ search: 'uid-1' }));
  });

  it('persists explicit exact-match mode in canonical state', () => {
    saveRerAnalysisQueryState({
      search: 'uid-1',
      unitsExactMatchOnly: true,
    });

    expect(globalThis.localStorage.getItem(RER_ANALYSIS_QUERY_STATE_KEY)).toBe(
      JSON.stringify({ search: 'uid-1', unitsExactMatchOnly: true }),
    );
  });

  it('saves legacy state without canonical compaction on the legacy storage key', () => {
    saveLegacyRerAnalysisQueryState({
      search: 'uid-1',
      metadata_sender: ['sigint'],
    });

    expect(globalThis.localStorage.getItem(RER_ANALYSIS_LEGACY_QUERY_STATE_KEY)).toBe(
      JSON.stringify({ search: 'uid-1', metadata_sender: ['sigint'] }),
    );
  });

  it('writes flat query params instead of legacy state json', () => {
    const params = new URLSearchParams('foo=bar&state=%7B%22search%22%3A%22old%22%7D');

    writeRerAnalysisQueryStateToSearchParams(params, {
      dateFromStr: '2026-03-27',
      timeFromStr: '21:52',
      dateToStr: '2026-03-28',
      timeToStr: '09:52',
      search: 'uid-1',
      includeOnlyNewFreqs: true,
      freqsSelected: ['123.4', '123.5'],
      includePelengLocations: true,
      groupsSelected: [],
    });

    expect(params.toString()).toBe(
      'foo=bar&dateFrom=2026-03-27&timeFrom=21%3A52&dateTo=2026-03-28&timeTo=09%3A52&onlyNewFreqs=true&freqs=123.4&freqs=123.5&search=uid-1',
    );
  });

  it('omits nullable canonical booleans when they match the neo default', () => {
    const params = new URLSearchParams();

    writeRerAnalysisQueryStateToSearchParams(params, {
      unitsExactMatchOnly: null,
    });

    expect(params.toString()).toBe('');
    expect(parseRerAnalysisQueryStateFromSearchParams(params)).toBeNull();
  });

  it('parses flat query params into canonical query state', () => {
    const params = new URLSearchParams(
      'dateFrom=2026-03-27&timeFrom=21%3A52&onlyNewFreqs=true&freqs=123.4&freqs=123.5&withoutNetwork=true&tags=7&tags=11&filterTagsOption=AllTags',
    );

    expect(parseRerAnalysisQueryStateFromSearchParams(params)).toEqual({
      dateFromStr: '2026-03-27',
      timeFromStr: '21:52',
      includeOnlyNewFreqs: true,
      freqsSelected: ['123.4', '123.5'],
      withoutNetwork: true,
      tags: [7, 11],
      filterTagsOption: 'AllTags',
    });
    expect(hasRerAnalysisQueryStateParams(params)).toBe(true);
  });
});
