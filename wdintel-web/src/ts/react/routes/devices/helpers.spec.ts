import { describe, expect, it } from 'vitest';

import type { Unit } from '../../../../Bindings';
import {
  buildDevicesListReq,
  buildDevicesSortBy,
  createDefaultDevicesFilterState,
  formatAorsLabel,
  hasActiveDevicesFilters,
  resolveDeviceSidebarUnitIds,
} from './helpers';

function buildUnit(overrides: Partial<Unit>): Unit {
  return {
    id: 1,
    company: '',
    battalion: '',
    regiment: '',
    division: '',
    army: '',
    comment: '',
    name: 'Unit',
    active: true,
    createdAt: 0,
    createdBy: 'tester',
    ...overrides,
  };
}

describe('devices list query mapping', () => {
  it('maps default query to active-only updated-at-desc first page', () => {
    expect(
      buildDevicesListReq({
        searchText: '  ',
        filters: createDefaultDevicesFilterState(),
        sorting: [],
        limit: 100,
        offset: 0,
      }),
    ).toEqual({
      filterText: null,
      archivedFilter: 'active_only',
      aorIds: null,
      unitIds: null,
      createdBy: null,
      ids: null,
      limit: 100,
      offset: 0,
      sortBy: ['updated_at_desc'],
    });
  });

  it('maps archived filters to backend enum values', () => {
    expect(
      buildDevicesListReq({
        searchText: '',
        filters: { ...createDefaultDevicesFilterState(), archivedFilter: 'archived' },
        sorting: [],
        limit: 100,
        offset: 0,
      }).archivedFilter,
    ).toBe('archived_only');

    expect(
      buildDevicesListReq({
        searchText: '',
        filters: { ...createDefaultDevicesFilterState(), archivedFilter: 'all' },
        sorting: [],
        limit: 100,
        offset: 0,
      }).archivedFilter,
    ).toBe('all');
  });

  it('trims search/status/unit filters and sends removed smuha/creator filters as null', () => {
    expect(
      buildDevicesListReq({
        searchText: '  drone  ',
        filters: {
          archivedFilter: 'all',
          unitIds: [30],
        },
        sorting: [{ id: 'name', desc: false }],
        limit: 50,
        offset: 100,
      }),
    ).toMatchObject({
      filterText: 'drone',
      archivedFilter: 'all',
      aorIds: null,
      unitIds: [30],
      createdBy: null,
      limit: 50,
      offset: 100,
      sortBy: ['name_asc'],
    });
  });

  it('formats smuha labels from names with id fallback', () => {
    expect(formatAorsLabel([1, 2], ['Alpha', 'Beta'])).toBe('Alpha, Beta');
    expect(formatAorsLabel([1, 2], ['Alpha', ''])).toBe('Alpha, AOR #2 — назва недоступна');
    expect(formatAorsLabel([1, 2], [])).toBe(
      'AOR #1 — назва недоступна, AOR #2 — назва недоступна',
    );
    expect(formatAorsLabel([], [])).toBe('—');
  });

  it('maps supported sorts and resets unsupported sorts', () => {
    expect(buildDevicesSortBy([{ id: 'name', desc: true }])).toEqual(['name_desc']);
    expect(buildDevicesSortBy([{ id: 'updatedAt', desc: false }])).toEqual(['updated_at_asc']);
    expect(buildDevicesSortBy([{ id: 'createdBy', desc: true }])).toEqual(['updated_at_desc']);
  });

  it('resolves sidebar leaf and hierarchy filters to deterministic unit ids', () => {
    const units = [
      buildUnit({ id: 4, name: 'Beta', army: 'A', division: 'D1' }),
      buildUnit({ id: 2, name: 'Alpha', army: 'A', division: 'D2' }),
      buildUnit({ id: 3, name: 'Beta', army: 'B', division: 'D3' }),
    ];

    expect(
      resolveDeviceSidebarUnitIds(
        { kind: 'leaf', label: 'Beta', unitName: 'Beta', unitId: 4 },
        units,
      ),
    ).toEqual([4]);
    expect(
      resolveDeviceSidebarUnitIds({ kind: 'leaf', label: 'Beta', unitName: 'Beta' }, units),
    ).toEqual([3, 4]);
    expect(
      resolveDeviceSidebarUnitIds(
        {
          kind: 'group',
          label: 'A',
          hierarchy: { army: 'A', division: null, regiment: null, battalion: null },
        },
        units,
      ),
    ).toEqual([2, 4]);
  });

  it('detects active filters for empty states', () => {
    expect(hasActiveDevicesFilters('', createDefaultDevicesFilterState())).toBe(false);
    expect(hasActiveDevicesFilters('device', createDefaultDevicesFilterState())).toBe(true);
    expect(
      hasActiveDevicesFilters('', { ...createDefaultDevicesFilterState(), archivedFilter: 'all' }),
    ).toBe(true);
    expect(
      hasActiveDevicesFilters('', { ...createDefaultDevicesFilterState(), unitIds: [1] }),
    ).toBe(true);
  });
});
