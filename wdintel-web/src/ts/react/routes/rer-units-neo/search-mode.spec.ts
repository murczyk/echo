import { describe, expect, it } from 'vitest';

import type { Unit } from '../../../../Bindings';
import { isUnitSearchMatch, isUnitSearchMatchForUnit } from './search-mode';

describe('isUnitSearchMatch', () => {
  it('does not match query number inside another number in strict mode', () => {
    expect(isUnitSearchMatch('2 мсб 27 омсбр', '22 сб')).toBe(false);
    expect(isUnitSearchMatch('2 мсб 27 омсбр', '7 омсбр')).toBe(false);
  });

  it('works in strict mode with text tokens', () => {
    expect(isUnitSearchMatch('2 мсб 27 омсбр', 'мсб омсбр')).toBe(true);
    expect(isUnitSearchMatch('2 мсб 27 омсбр', 'омсбр мсб')).toBe(false);
  });
});

describe('isUnitSearchMatchForUnit', () => {
  it('searches across unit fields in strict mode', () => {
    const unit: Unit = {
      id: 7,
      name: '2 мсб',
      company: '2',
      battalion: 'Взвод',
      regiment: '27 омсбр',
      division: '',
      army: '',
      militaryDistrict: '',
      armyRegion: '',
      comment: 'додаток',
      orbitNote: null,
      active: true,
      isDeduplicateCandidate: null,
      createdAt: 0,
      createdByLoginId: 'alice',
      hasOrbit: false,
      orbitUnitIds: [],
    };

    expect(isUnitSearchMatchForUnit(unit, '22')).toBe(false);
    expect(isUnitSearchMatchForUnit(unit, '27 омсбр')).toBe(true);
  });
});
