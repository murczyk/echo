import { describe, expect, it } from 'vitest';

import type { Unit } from '../../../../Bindings';
import {
  defaultUnitMasks,
  EMPTY_UNIT_FORM,
  findPotentialDuplicates,
  isUnitFormValid,
  uniqueTrimmed,
} from './helpers';

function unit(overrides: Partial<Unit>): Unit {
  return {
    id: 1,
    company: '',
    battalion: '',
    regiment: '',
    division: '',
    army: '',
    comment: '',
    name: '',
    active: true,
    createdAt: 0,
    createdByLoginId: '',
    hasOrbit: false,
    ...overrides,
  };
}

describe('rer units helpers', () => {
  it('requires at least one hierarchy value', () => {
    expect(isUnitFormValid(EMPTY_UNIT_FORM)).toBe(false);
    expect(isUnitFormValid({ ...EMPTY_UNIT_FORM, battalion: ' 2 батальйон ' })).toBe(true);
  });

  it('builds forward and reverse masks without duplicates', () => {
    expect(
      defaultUnitMasks({
        ...EMPTY_UNIT_FORM,
        battalion: '2 батальйон',
        regiment: '10 бригада',
      }),
    ).toEqual(['2 батальйон 10 бригада', '10 бригада 2 батальйон']);
    expect(defaultUnitMasks({ ...EMPTY_UNIT_FORM, army: '1 армія' })).toEqual(['1 армія']);
  });

  it('normalizes comma-separated chips case-insensitively', () => {
    expect(uniqueTrimmed([' Київ, Харків ', 'київ', 'Одеса'])).toEqual(['Київ', 'Харків', 'Одеса']);
  });

  it('finds existing units matching all entered hierarchy values', () => {
    const units = [
      unit({ id: 1, battalion: '2 батальйон', regiment: '10 бригада' }),
      unit({ id: 2, battalion: '3 батальйон', regiment: '10 бригада' }),
    ];

    expect(
      findPotentialDuplicates(units, {
        ...EMPTY_UNIT_FORM,
        battalion: '2',
        regiment: 'бригада',
      }).map(({ id }) => id),
    ).toEqual([1]);
  });
});
