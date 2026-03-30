import { describe, expect, it } from 'vitest';

import {
  buildAnalysisReq,
  buildInboxReq,
  createInitialQueryState,
  createResetQueryState,
  emptyQueryState,
  hasMeaningfulFiltersBeyondDateRange,
  queryStateFromSavedFilter,
  queryStateMatchesSavedFilter,
  shouldRebuildAnalysisRequests,
} from './helpers';
import { combineDateTimeToMs, isValidDateInput } from '../../utils/misc';

describe('rer-analysis-neo helpers', () => {
  it('rejects invalid early years', () => {
    expect(isValidDateInput('2021-12-31')).toBe(false);
    expect(isValidDateInput('2022-01-01')).toBe(true);
    expect(combineDateTimeToMs('2021-12-31', '12:00')).toBeNull();
    expect(combineDateTimeToMs('2022-01-01', '12:00')).not.toBeNull();
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

  it('drops selected networks when withoutNetwork is enabled together with metadata filters', () => {
    const state = {
      ...emptyQueryState(),
      dateFromStr: '2026-03-19',
      timeFromStr: '00:00',
      dateToStr: '2026-03-20',
      timeToStr: '12:00',
      networksSelected: ['12'],
      withoutNetwork: true,
      withoutMetadata: true,
      metadataCc: ['cc-1'],
    };

    expect(buildAnalysisReq(state)).toMatchObject({
      selectedNetworks: null,
      withoutNetwork: true,
      withoutMetadata: true,
      onlyWithMetadata: false,
      metadataCc: null,
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

  it('requests a rebuild when adjacent expansion becomes possible after frequencies load', () => {
    const state = {
      ...emptyQueryState(),
      dateFromStr: '2026-03-19',
      timeFromStr: '00:00',
      dateToStr: '2026-03-20',
      timeToStr: '12:00',
      freqsSelected: ['100.0000'],
      adjacentFreqsRange: 0.002,
    };

    expect(shouldRebuildAnalysisRequests(state, [], ['99.9975', '100.0000', '100.0015', '100.0045'])).toBe(true);
    expect(
      shouldRebuildAnalysisRequests(state, ['99.9975', '100.0000', '100.0015', '100.0045'], ['99.9975', '100.0000', '100.0015', '100.0045']),
    ).toBe(false);
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

  it('treats backend nulls as equal to frontend defaults for saved filters', () => {
    const state = {
      ...emptyQueryState(),
      dateFromStr: '2026-03-19',
      timeFromStr: '00:00',
      dateToStr: '2026-03-20',
      timeToStr: '12:00',
      includePelengLocations: true,
      filterTagsOption: 'OneOfTags' as const,
    };

    const req = buildAnalysisReq(state)!;
    const savedFilter = {
      id: 1,
      name: 'Saved',
      req: {
        ...req,
        orWithExtendedForm: null,
        orBookmarked: null,
        orImportant: null,
        orWithCoords: null,
        withoutNetwork: null,
        onlyWithMetadata: null,
        withoutMetadata: null,
        includePelengLocations: null,
        filterTagsOption: null,
        withoutModelTags: null,
        reportTagsOnlyThisUnit: null,
      },
    };

    expect(queryStateMatchesSavedFilter(state, savedFilter)).toBe(true);
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

  it('treats a plain date range as not enough to enable reset by itself', () => {
    expect(
      hasMeaningfulFiltersBeyondDateRange({
        ...emptyQueryState(),
        dateFromStr: '2026-03-20',
        timeFromStr: '00:34',
        dateToStr: '2026-03-20',
        timeToStr: '12:34',
      }),
    ).toBe(false);

    expect(
      hasMeaningfulFiltersBeyondDateRange({
        ...emptyQueryState(),
        dateFromStr: '2026-03-20',
        timeFromStr: '00:34',
        dateToStr: '2026-03-20',
        timeToStr: '12:34',
        groupsSelected: ['alpha'],
      }),
    ).toBe(true);
  });
});
