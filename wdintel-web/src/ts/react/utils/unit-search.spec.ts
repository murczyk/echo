import { describe, expect, it } from 'vitest';

import type { Unit } from '../../../Bindings';
import {
  UNIT_FILTER_UNSET_ID,
  buildUnitFilterOptions,
  getUnitFilterValue,
  unitNamesFromUnits,
  unitsFromNames,
} from './unit-search';

function makeUnit(id: number, name: string): Unit {
  return {
    id,
    name,
    company: '',
    battalion: '',
    regiment: '',
    division: '',
    army: '',
    comment: '',
    active: true,
    createdAt: 0,
    createdBy: '',
  };
}

describe('buildUnitFilterOptions', () => {
  it('dedupes names and keeps the lowest id', () => {
    const options = buildUnitFilterOptions([
      makeUnit(5, ' 3 мсб '),
      makeUnit(2, '3 мсб'),
      makeUnit(7, ''),
    ]);

    expect(options.map((unit) => unit.id)).toEqual([UNIT_FILTER_UNSET_ID, 2]);
    expect(getUnitFilterValue(options[0]!)).toBe('Не визначено');
    expect(getUnitFilterValue(options[1]!)).toBe('3 мсб');
  });
});

describe('unitsFromNames / unitNamesFromUnits', () => {
  const options = buildUnitFilterOptions([makeUnit(2, '3 мсб'), makeUnit(4, '4 мсб')]);

  it('round-trips saved names through unit options', () => {
    const names = ['Не визначено', '3 мсб'];
    const units = unitsFromNames(names, options);

    expect(units.map((unit) => unit.id)).toEqual([UNIT_FILTER_UNSET_ID, 2]);
    expect(unitNamesFromUnits(units)).toEqual(names);
  });

  it('omits unknown saved names', () => {
    expect(unitsFromNames(['missing unit'], options)).toEqual([]);
  });
});
