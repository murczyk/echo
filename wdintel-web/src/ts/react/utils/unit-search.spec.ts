import { describe, expect, it } from 'vitest';

import type { Unit } from '../../../Bindings';
import {
  buildSelectableUnitOptions,
  buildUnitFilterOptions,
  buildUnitLookupOptions,
  getCanonicalUnitIdValue,
  getUnitFilterValue,
  getUnitIdFilterValue,
  isCanonicalUnitIdValue,
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

// @test-scope parser: unit records to selectable-option normalization fixtures.
describe('buildSelectableUnitOptions', () => {
  it('drops blank names, trims labels, and keeps duplicate names by id', () => {
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
      { id: 8, name: '3 мсб' },
      { id: 1, name: '4 мсб' },
      { id: 2, name: '4 мсб' },
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

// @test-scope parser: persisted unit-filter value normalization fixtures.
describe('buildUnitFilterOptions', () => {
  it('uses stable ids as filter values', () => {
    const options = buildUnitFilterOptions([
      makeUnit(5, ' 3 мсб '),
      makeUnit(2, '3 мсб'),
      makeUnit(7, ''),
    ]);

    expect(options.map((unit) => unit.id)).toEqual([0, 2, 5]);
    expect(options.map(getUnitFilterValue)).toEqual(['Не визначено', 'unit-id:2', 'unit-id:5']);
    expect(getUnitIdFilterValue(0)).toBe('Не визначено');
  });

  it('distinguishes tagged ids from numeric legacy labels', () => {
    expect(isCanonicalUnitIdValue('123')).toBe(false);
    expect(getCanonicalUnitIdValue('123')).toBeNull();
    expect(getCanonicalUnitIdValue('unit-id:123')).toBe(123);
  });
});

// @test-scope parser: active and persisted unit lookup normalization fixture.
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

// @test-scope parser: persisted unit-filter value round-trip fixtures.
describe('unitsFromNames / unitNamesFromUnits', () => {
  const options = buildUnitFilterOptions([makeUnit(2, '3 мсб'), makeUnit(4, '4 мсб')]);

  it('round-trips saved ids through unit options', () => {
    const ids = [getUnitIdFilterValue(2), getUnitIdFilterValue(4)];
    const units = unitsFromNames(ids, options);

    expect(units.map((unit) => unit.id)).toEqual([2, 4]);
    expect(unitNamesFromUnits(units)).toEqual(ids);
  });

  it('omits unknown saved names', () => {
    expect(unitsFromNames(['missing unit'], options)).toEqual([]);
  });
});
