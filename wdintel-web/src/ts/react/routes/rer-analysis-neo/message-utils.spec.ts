import { describe, expect, it } from 'vitest';

import type { Network, SignalProfileEntry, Unit } from '../../../../Bindings';
import { buildNetworkDisplayMap, buildSenderFilterOptions } from './message-utils';

function buildUnit(id: number, name: string): Unit {
  return {
    id,
    company: '',
    battalion: '',
    regiment: '',
    division: '',
    army: '',
    comment: '',
    name,
    active: true,
    createdAt: 0,
    createdBy: '',
  };
}

function buildNetwork(id: number, name: string, unitIds: number[] | null, location = 'KYIV'): Network {
  return {
    id,
    freqs: [],
    unitIds,
    aorIds: [],
    name,
    location,
    radioStation: null,
    createdAt: 0,
    purpose: null,
    operationMode: null,
    operationType: null,
    operationPeriod: null,
    lastUpdatedAt: 0,
    lastUpdatedBy: null,
    activeFrom: null,
    activeTo: null,
    postIds: [],
    descriptions: [],
    deleted: false,
    status: 'NetworkActive',
  };
}

describe('buildNetworkDisplayMap', () => {
  it('concatenates network name and unit names into a full display label', () => {
    const network = buildNetwork(12, 'управління', [1, 2]);
    const unitsMap = {
      1: buildUnit(1, '1 гсад 60 сап 69 мсд 6 ЗА'),
      2: buildUnit(2, '2 гсад 60 сап 69 мсд 6 ЗА'),
    };

    expect(buildNetworkDisplayMap([network], unitsMap)).toEqual({
      12: 'р/м управління 1 гсад 60 сап 69 мсд 6 ЗА, 2 гсад 60 сап 69 мсд 6 ЗА',
    });
  });

  it('omits unknown unit placeholders when unit metadata is missing', () => {
    const network = buildNetwork(12, 'управління', [1, 2]);

    expect(buildNetworkDisplayMap([network], {} as Record<number, Unit>)).toEqual({
      12: 'р/м управління',
    });
  });
});

describe('buildSenderFilterOptions', () => {
  function buildProfile(givenName: string | null, familyName: string | null): SignalProfileEntry {
    return {
      givenName,
      familyName,
      createdAt: 0,
      createdBy: '',
    };
  }

  it('builds human-readable labels and disambiguates duplicate names without duplicating the count', () => {
    const options = buildSenderFilterOptions(
      [
        { uuid: 'aaaaaaaa-1111', count: 7, freqBreakdown: [], perDay: {} },
        { uuid: 'aaaaaaaa-2222', count: 3, freqBreakdown: [], perDay: {} },
        { uuid: 'bbbbbbbb-1111', count: 5, freqBreakdown: [], perDay: {} },
      ],
      {
        'aaaaaaaa-1111': buildProfile('Alpha', 'Team'),
        'aaaaaaaa-2222': buildProfile('Alpha', 'Team'),
        'bbbbbbbb-1111': buildProfile(null, null),
      },
    );

    expect(options).toEqual([
      { value: 'aaaaaaaa-1111', label: 'Alpha Team [aaaaaaaa]', count: 7 },
      { value: 'aaaaaaaa-2222', label: 'Alpha Team [aaaaaaaa]', count: 3 },
      { value: 'bbbbbbbb-1111', label: 'bbbbbbbb-1111', count: 5 },
    ]);
  });
});
