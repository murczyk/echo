import { describe, expect, it } from 'vitest';

import type { DeviceUnitStat, Unit } from '../../../../../Bindings';
import {
  buildDevicesColumnFilters,
  buildDevicesListReq,
  buildDevicesSortBy,
  createDefaultDevicesFilterState,
  formatAorsLabel,
  hasActiveDevicesFilters,
  mergeDeviceUnitStatsWithUnits,
  mergeCurrentDeviceUnitOption,
  resolveDevicesColumnFilters,
  sanitizeDevicesColumnFilters,
  resolveDeviceSidebarUnitIds,
} from '../helpers';

// @test-scope parser: preserves device unit-option normalization for the device API boundary.
describe('device unit options', () => {
  it('keeps the current inactive unit available while editing', () => {
    expect(
      mergeCurrentDeviceUnitOption([{ id: 1, label: 'Active' }], {
        id: 2,
        name: 'Inactive',
      }),
    ).toEqual([
      { id: 1, label: 'Active' },
      { id: 2, label: 'Inactive' },
    ]);
  });
});

function buildUnit(overrides: Partial<Unit>): Unit {
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
    name: 'Unit',
    active: true,
    createdAt: 0,
    createdBy: 'tester',
    ...overrides,
  };
}

// @test-scope parser: preserves device list query mapping for existing API request compatibility.
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

  it('trims search and maps unit filters and display-title sorting', () => {
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
      limit: 50,
      offset: 100,
      sortBy: ['display_title_asc'],
    });
  });

  it('formats AOR summaries with id fallback', () => {
    expect(
      formatAorsLabel([
        { id: 1, name: 'Alpha' },
        { id: 2, name: 'Beta' },
      ]),
    ).toBe('Alpha, Beta');
    expect(
      formatAorsLabel([
        { id: 1, name: 'Alpha' },
        { id: 2, name: '' },
      ]),
    ).toBe('Alpha, AOR #2 — назва недоступна');
    expect(formatAorsLabel([])).toBe('—');
  });

  it('maps supported sorts and resets unsupported sorts', () => {
    expect(buildDevicesSortBy([{ id: 'name', desc: true }])).toEqual(['display_title_desc']);
    expect(buildDevicesSortBy([{ id: 'updatedAt', desc: false }])).toEqual(['updated_at_asc']);
    expect(buildDevicesSortBy([{ id: 'createdAt', desc: true }])).toEqual(['created_at_desc']);
    expect(buildDevicesSortBy([{ id: 'createdBy', desc: true }])).toEqual(['updated_at_desc']);
  });

  it('keeps device-scoped unit stats without the full unit catalog', () => {
    const unitStats: DeviceUnitStat[] = [{ unit: { id: 7, name: 'Visible unit' }, count: 3 }];

    expect(mergeDeviceUnitStatsWithUnits(unitStats, new Map<number, Unit>())).toEqual([
      {
        unitId: 7,
        unitName: 'Visible unit',
        armyRegion: '',
        militaryDistrict: '',
        army: '',
        division: '',
        regiment: '',
        battalion: '',
        count: 3,
      },
    ]);
  });

  it('resolves sidebar leaf and hierarchy filters to deterministic unit ids', () => {
    const units = [
      buildUnit({ id: 4, name: 'Beta', armyRegion: 'R1', army: 'A', division: 'D1' }),
      buildUnit({ id: 2, name: 'Alpha', armyRegion: 'R1', army: 'A', division: 'D2' }),
      buildUnit({ id: 3, name: 'Beta', armyRegion: 'R2', army: 'A', division: 'D3' }),
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
          hierarchy: {
            armyRegion: 'R1',
            militaryDistrict: null,
            army: 'A',
            division: null,
            regiment: null,
            battalion: null,
          },
        },
        units,
      ),
    ).toEqual([2, 4]);
  });

  it('round-trips shareable lifecycle and unit filters and drops malformed values', () => {
    const selectedSidebarUnitFilter = {
      kind: 'group' as const,
      label: 'Army A',
      hierarchy: {
        armyRegion: null,
        militaryDistrict: null,
        army: 'A',
        division: null,
        regiment: null,
        battalion: null,
      },
    };
    const columnFilters = buildDevicesColumnFilters({
      archivedFilter: 'archived',
      selectedSidebarUnitFilter,
    });

    expect(resolveDevicesColumnFilters(columnFilters)).toEqual({
      archivedFilter: 'archived',
      selectedSidebarUnitFilter,
    });
    expect(
      sanitizeDevicesColumnFilters([
        { id: 'lifecycle', value: 'unknown' },
        { id: 'unit', value: { kind: 'leaf', label: 1 } },
      ]),
    ).toEqual([]);
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
