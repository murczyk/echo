import { describe, expect, it } from 'vitest';

import {
  buildAnalysisReq,
  buildInboxReq,
  combineDateTimeToMs,
  createInitialQueryState,
  createResetQueryState,
  emptyQueryState,
  isValidDateInput,
  queryStateFromSavedFilter,
  queryStateMatchesSavedFilter,
} from './helpers';

describe('rer-analysis-neo helpers', () => {
  it('rejects invalid early years', () => {
    expect(isValidDateInput('0001-01-01')).toBe(false);
    expect(combineDateTimeToMs('0001-01-01', '12:00')).toBeNull();
  });

  it('builds analysis request from query state', () => {
    const state = {
      ...emptyQueryState(),
      dateFromStr: '2026-03-19',
      timeFromStr: '00:00',
      dateToStr: '2026-03-20',
      timeToStr: '12:00',
      groupsSelected: ['g1'],
      networksSelected: ['12'],
    };

    expect(buildAnalysisReq(state)).toMatchObject({
      selectedGroups: ['g1'],
      selectedNetworks: [12],
    });
  });

  it('expands selected freqs with adjacent frequencies in range', () => {
    const state = {
      ...emptyQueryState(),
      dateFromStr: '2026-03-19',
      timeFromStr: '00:00',
      dateToStr: '2026-03-20',
      timeToStr: '12:00',
      freqsSelected: ['100.0000'],
      adjacentFreqsRange: 0.002,
    };

    expect(buildAnalysisReq(state, ['99.9975', '100.0000', '100.0015', '100.0045'])?.selectedFreqs).toEqual([
      '100.0000',
      '100.0015',
    ]);
  });

  it('carries analysis-only flags into inbox request', () => {
    const state = {
      ...emptyQueryState(),
      dateFromStr: '2026-03-19',
      timeFromStr: '00:00',
      dateToStr: '2026-03-20',
      timeToStr: '12:00',
      filterTagsOption: 'AllTags' as const,
      reportTagsOnlyThisUnit: true,
      unitsExactMatchOnly: false,
      withoutModelTags: true,
    };

    expect(buildInboxReq(state)).toMatchObject({
      filterTagsOption: 'AllTags',
      reportTagsOnlyThisUnit: true,
      unitsExactMatchOnly: false,
      withoutModelTags: true,
    });
  });

  it('applies saved filter request onto current date strings', () => {
    const state = {
      ...emptyQueryState(),
      dateFromStr: '2026-03-19',
      timeFromStr: '00:00',
      dateToStr: '2026-03-20',
      timeToStr: '12:00',
    };

    const next = queryStateFromSavedFilter(
      {
        id: 1,
        name: 'Saved',
        req: {
          sinceDateInclusiveMs: 1,
          tillDateNoninclusiveMs: 2,
          selectedGroups: ['alpha'],
          selectedSenders: null,
          selectedFreqs: null,
          selectedPosts: null,
          selectedCallsigns: null,
          selectedUnits: null,
          selectedLocations: null,
          selectedAors: null,
          orWithExtendedForm: null,
          orBookmarked: null,
          orImportant: null,
          orWithCoords: null,
          search: null,
          selectedTags: null,
          selectedNetworks: null,
          withoutNetwork: null,
          metadataCc: null,
          metadataSender: null,
          metadataReceiver: null,
          metadataHash: null,
          onlyWithMetadata: null,
          withoutMetadata: null,
          includePelengLocations: null,
          unitsExactMatchOnly: null,
          filterTagsOption: null,
          withoutModelTags: null,
          reportTagsOnlyThisUnit: null,
        },
      },
      state,
    );

    expect(next.groupsSelected).toEqual(['alpha']);
    expect(next.dateFromStr).toBe('2026-03-19');
  });

  it('matches saved filters including analysis-specific flags', () => {
    const state = {
      ...emptyQueryState(),
      dateFromStr: '2026-03-19',
      timeFromStr: '00:00',
      dateToStr: '2026-03-20',
      timeToStr: '12:00',
      filterTagsOption: 'AllTags' as const,
      reportTagsOnlyThisUnit: true,
      unitsExactMatchOnly: false,
      withoutModelTags: true,
    };

    const savedFilter = {
      id: 1,
      name: 'Saved',
      req: buildAnalysisReq(state)!,
    };

    expect(queryStateMatchesSavedFilter(state, savedFilter)).toBe(true);
    expect(
      queryStateMatchesSavedFilter(
        {
          ...state,
          reportTagsOnlyThisUnit: false,
        },
        savedFilter,
      ),
    ).toBe(false);
  });

  it('fills missing initial date range from local time defaults', () => {
    const now = new Date(2026, 2, 20, 12, 34, 56);

    expect(createInitialQueryState(emptyQueryState(), now)).toMatchObject({
      dateFromStr: '2026-03-20',
      timeFromStr: '00:34',
      dateToStr: '2026-03-20',
      timeToStr: '12:34',
    });
  });

  it('resets filters to a fresh default range instead of preserving saved selections', () => {
    const now = new Date(2026, 2, 20, 12, 34, 56);

    expect(
      createResetQueryState(now),
    ).toMatchObject({
      dateFromStr: '2026-03-20',
      timeFromStr: '00:34',
      dateToStr: '2026-03-20',
      timeToStr: '12:34',
      search: '',
      groupsSelected: [],
      freqsSelected: [],
      unitsSelected: [],
      tags: [],
      reportTagsOnlyThisUnit: false,
    });
  });
});
