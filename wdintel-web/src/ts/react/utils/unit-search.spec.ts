import { describe, expect, it } from 'vitest';

import type { Unit } from '../../../Bindings';
import {
  UNIT_FILTER_UNSET_ID,
  buildSelectableUnitOptions,
  buildUnitFilterOptions,
  buildUnitLookupOptions,
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

describe('buildSelectableUnitOptions', () => {
  it('drops blank names, trims labels, dedupes by name and keeps the lowest id', () => {
    const options = buildSelectableUnitOptions([
      makeUnit(8, ' 3 мсб '),
      makeUnit(4, '3 мсб'),
      makeUnit(7, ''),
      makeUnit(2, ' 4 мсб'),
      makeUnit(1, '4 мсб '),
      makeUnit(9, '   '),
    ]);

    expect(options.map((unit) => ({ id: unit.id, name: unit.name }))).toEqual([
      { id: 4, name: '3 мсб' },
      { id: 1, name: '4 мсб' },
    ]);
  });

  it('excludes inactive units from selection options', () => {
    expect(
      buildSelectableUnitOptions([
        makeUnit(1, 'Active'),
        { ...makeUnit(2, 'Inactive'), active: false },
      ]).map((unit) => unit.id),
    ).toEqual([1]);
  });
});

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

describe('buildUnitLookupOptions', () => {
  it('adds only explicitly referenced inactive units to active options', () => {
    const options = buildUnitLookupOptions(
      [makeUnit(1, 'Active'), { ...makeUnit(2, 'Inactive'), active: false }],
      [2, 99],
    );

    expect(options).toEqual([
      { id: 1, label: 'Active' },
      { id: 2, label: 'Inactive' },
      { id: 99, label: '#99' },
    ]);
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
