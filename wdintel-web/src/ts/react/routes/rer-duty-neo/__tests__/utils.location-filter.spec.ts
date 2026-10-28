import { describe, expect, it } from 'vitest';

import { inboxMsgtoSnakeBody } from '../../../services/api/inbox-messages';
import {
  buildDutyLocationsStatsReq,
  normalizeDutyLocationValue,
  sortDutyLocations,
} from '../duty-location-filter';
import { buildFeedCountSignature } from '../rerDutyFeedCount';
import {
  DUTY_LOCATIONS_LOOKBACK_MS,
  buildInboxReq,
  clearActiveFeedFilter,
  emptyFilter,
  filtersEqual,
  hasActiveFeedFilter,
  type MessageFeedState,
} from '../utils';

describe('Duty location filter state', () => {
  it('starts without location filters', () => {
    expect(emptyFilter()).toMatchObject({
      locationsSelected: null,
      locationsDenied: null,
      includePelengLocations: null,
    });
  });

  it.each([
    ['selected', { locationsSelected: ['КИЇВ'] }],
    ['denied', { locationsDenied: ['КИЇВ'] }],
  ])('treats %s locations as an active filter', (_label, locations) => {
    expect(hasActiveFeedFilter({ ...emptyFilter(), ...locations })).toBe(true);
  });

  it('does not treat the peleng toggle alone as an active filter', () => {
    expect(hasActiveFeedFilter({ ...emptyFilter(), includePelengLocations: true })).toBe(false);
  });

  it('clears location filters with the active filter', () => {
    const cleared = clearActiveFeedFilter({
      ...emptyFilter(),
      locationsSelected: ['КИЇВ'],
      locationsDenied: ['ЛЬВІВ'],
      includePelengLocations: true,
    });
    expect(cleared).toMatchObject({
      locationsSelected: null,
      locationsDenied: null,
      includePelengLocations: null,
    });
  });

  it('compares location lists and the peleng toggle', () => {
    const base = { ...emptyFilter(), locationsSelected: ['КИЇВ'] };
    expect(filtersEqual(base, { ...base })).toBe(true);
    expect(filtersEqual(base, { ...base, locationsSelected: ['ЛЬВІВ'] })).toBe(false);
    expect(filtersEqual(base, { ...base, locationsDenied: ['ЛЬВІВ'] })).toBe(false);
    expect(filtersEqual(base, { ...base, includePelengLocations: true })).toBe(false);
    expect(filtersEqual(base, { ...base, includePelengLocations: false })).toBe(true);
  });
});

describe('Duty location inbox request', () => {
  it('sends null location filters for an empty filter', () => {
    const req = buildInboxReq({ filter: { ...emptyFilter(), includePelengLocations: true } });
    expect(req.selectedLocations).toBeNull();
    expect(req.deniedLocations).toBeNull();
    expect(req.includePelengLocations).toBeNull();
  });

  it('sends selected and denied locations with the peleng toggle', () => {
    const req = buildInboxReq({
      filter: {
        ...emptyFilter(),
        locationsSelected: ['КИЇВ'],
        locationsDenied: [''],
        includePelengLocations: true,
      },
    });
    expect(req.selectedLocations).toEqual(['КИЇВ']);
    expect(req.deniedLocations).toEqual(['']);
    expect(req.includePelengLocations).toBe(true);
    expect(inboxMsgtoSnakeBody(req)).toMatchObject({
      selected_locations: ['КИЇВ'],
      denied_locations: [''],
      include_peleng_locations: true,
    });
  });

  it('sends empty location lists as null', () => {
    const req = buildInboxReq({
      filter: { ...emptyFilter(), locationsSelected: [], locationsDenied: ['ЛЬВІВ'] },
    });
    expect(req.selectedLocations).toBeNull();
    expect(req.deniedLocations).toEqual(['ЛЬВІВ']);
    expect(req.includePelengLocations).toBeNull();
  });

  it('changes the feed count signature for location filters', () => {
    const feed = { filter: emptyFilter(), adjacentFreqsRange: 0 } as MessageFeedState;
    const withLocations = {
      ...feed,
      filter: { ...feed.filter, locationsDenied: ['ЛЬВІВ'] },
    } as MessageFeedState;
    const withPeleng = {
      ...withLocations,
      filter: { ...withLocations.filter, includePelengLocations: true },
    } as MessageFeedState;
    const signatures = [feed, withLocations, withPeleng].map((item) =>
      buildFeedCountSignature(item, []),
    );
    expect(new Set(signatures).size).toBe(3);
  });
});

describe('Duty location options', () => {
  it('builds a creation-time stats request for the fixed look-back', () => {
    const req = buildDutyLocationsStatsReq(1_000_000_000_000);
    expect(req.sinceDateInclusiveMs).toBe(1_000_000_000_000 - DUTY_LOCATIONS_LOOKBACK_MS);
    expect(req.tillDateNoninclusiveMs).toBe(1_000_000_000_000);
    expect(req.messageTimeBasis).toBe('creation');
    expect(req.selectedLocations).toBeNull();
    expect(req.includePelengLocations).toBeNull();
  });

  it('sorts locations with the empty location first', () => {
    expect(
      sortDutyLocations([
        { location: 'ЛЬВІВ', count: 1 },
        { location: '', count: 5 },
        { location: 'КИЇВ', count: 3 },
      ]),
    ).toEqual(['', 'КИЇВ', 'ЛЬВІВ']);
  });

  it('canonicalizes the backend empty-location sentinel before sorting', () => {
    expect(
      sortDutyLocations([
        { location: 'львів', count: 1 },
        { location: '--Не визначено--', count: 4 },
        { location: '', count: 2 },
        { location: 'ЛЬВІВ', count: 3 },
      ]),
    ).toEqual(['', 'ЛЬВІВ']);
  });

  it('normalizes free-entry locations', () => {
    expect(normalizeDutyLocationValue('  київ ')).toBe('КИЇВ');
    expect(normalizeDutyLocationValue('<не вказано>')).toBe('');
    expect(normalizeDutyLocationValue('--Не визначено--')).toBe('');
  });
});
