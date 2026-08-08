import { describe, expect, it } from 'vitest';

import type { Unit } from '../../../../Bindings';
import {
  defaultUnitMasks,
  buildUnitsListReq,
  EMPTY_UNIT_FORM,
  filterUnitsByStatus,
  findPotentialDuplicates,
  isUnitFormValid,
  trimUnitForm,
  unitToForm,
  unitStatusCounts,
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
    militaryDistrict: '',
    armyRegion: '',
    comment: '',
    orbitNote: null,
    name: '',
    active: true,
    isDeduplicateCandidate: null,
    createdAt: 0,
    createdByLoginId: '',
    hasOrbit: false,
    orbitUnitIds: [],
    ...overrides,
  };
}

describe('rer units helpers', () => {
  it('builds a server-side inactive page request from table state', () => {
    expect(
      buildUnitsListReq({
        statusFilter: 'inactive',
        globalFilter: ' 55 омсбр ',
        columnFilters: [{ id: 'army', value: ' 3 АК ' }],
        sorting: [{ id: 'createdAt', desc: true }],
        searchMode: 'strict',
        pagination: { pageIndex: 2, pageSize: 20 },
      }),
    ).toMatchObject({
      sortBy: 'CreatedAtDesc',
      includeInactive: true,
      filterActive: false,
      filterText: '55 омсбр',
      filterArmy: '3 АК',
      searchMode: 'Strict',
      limit: 20,
      offset: 40,
    });
  });

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

  it('counts and filters units by activity', () => {
    const units = [unit({ id: 1, active: true }), unit({ id: 2, active: false })];

    expect(unitStatusCounts(units)).toEqual({ active: 1, inactive: 1 });
    expect(filterUnitsByStatus(units, 'active').map(({ id }) => id)).toEqual([1]);
    expect(filterUnitsByStatus(units, 'inactive').map(({ id }) => id)).toEqual([2]);
  });

  it('preserves the three-state deduplication candidate value', () => {
    expect(unitToForm(unit({ isDeduplicateCandidate: true })).isDeduplicateCandidate).toBe(true);
    expect(
      trimUnitForm({ ...EMPTY_UNIT_FORM, isDeduplicateCandidate: null }).isDeduplicateCandidate,
    ).toBeNull();
  });
});
