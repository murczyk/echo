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

  it('normalizes legacy snake_case keys into canonical camelCase fields', () => {
    expect(
      normalizeRerAnalysisQueryState({
        date_from_str: '2026-03-27',
        time_from_str: '21:52',
        freqs_selected: ['123.4'],
        without_network: true,
        metadata_cc: ['cc-1'],
        include_peleng_locations: false,
        adjacent_freqs_range: 0.002,
        report_tags_only_this_unit: true,
      }),
    ).toEqual({
      dateFromStr: '2026-03-27',
      timeFromStr: '21:52',
      freqsSelected: ['123.4'],
      withoutNetwork: true,
      metadataCc: ['cc-1'],
      includePelengLocations: false,
      adjacentFreqsRange: 0.002,
      reportTagsOnlyThisUnit: true,
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
    });
  });

  it('loads stored legacy state in normalized form', () => {
    globalThis.localStorage.setItem(
      RER_ANALYSIS_QUERY_STATE_KEY,
      JSON.stringify({
        search: 'abc',
        metadata_sender: ['sigint'],
        without_model_tags: true,
      }),
    );

    expect(loadRerAnalysisQueryState()).toEqual({
      search: 'abc',
      metadataSender: ['sigint'],
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
    });

    expect(globalThis.localStorage.getItem(RER_ANALYSIS_QUERY_STATE_KEY)).toBe(JSON.stringify({ search: 'uid-1' }));
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
      'foo=bar&dateFrom=2026-03-27&timeFrom=21%3A52&dateTo=2026-03-28&timeTo=09%3A52&onlyNewFreqs=true&search=uid-1',
    );
  });

  it('parses flat query params into canonical query state', () => {
    const params = new URLSearchParams(
      'dateFrom=2026-03-27&timeFrom=21%3A52&onlyNewFreqs=true&freqs=123.4&freqs=123.5&withoutNetwork=true&tags=7&tags=11',
    );

    expect(parseRerAnalysisQueryStateFromSearchParams(params)).toEqual({
      dateFromStr: '2026-03-27',
      timeFromStr: '21:52',
      includeOnlyNewFreqs: true,
      freqsSelected: ['123.4', '123.5'],
      withoutNetwork: true,
      tags: [7, 11],
    });
    expect(hasRerAnalysisQueryStateParams(params)).toBe(true);
  });
});
