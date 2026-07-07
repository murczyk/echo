import { describe, expect, it } from 'vitest';

import {
  buildDevicesListReq,
  buildDevicesSortBy,
  createDefaultDevicesFilterState,
  formatAorsLabel,
  hasActiveDevicesFilters,
} from './helpers';

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
      deletedFilter: 'active_only',
      aorIds: null,
      unitIds: null,
      createdBy: null,
      ids: null,
      limit: 100,
      offset: 0,
      sortBy: ['updated_at_desc'],
    });
  });

  it('maps deleted filters to backend enum values', () => {
    expect(
      buildDevicesListReq({
        searchText: '',
        filters: { ...createDefaultDevicesFilterState(), deletedFilter: 'deleted' },
        sorting: [],
        limit: 100,
        offset: 0,
      }).deletedFilter,
    ).toBe('deleted_only');

    expect(
      buildDevicesListReq({
        searchText: '',
        filters: { ...createDefaultDevicesFilterState(), deletedFilter: 'all' },
        sorting: [],
        limit: 100,
        offset: 0,
      }).deletedFilter,
    ).toBe('all');
  });

  it('trims text filters and preserves selected lookup ids', () => {
    expect(
      buildDevicesListReq({
        searchText: '  drone  ',
        filters: {
          deletedFilter: 'all',
          aorIds: [10, 20],
          unitIds: [30],
          createdBy: '  cyber-user  ',
        },
        sorting: [{ id: 'name', desc: false }],
        limit: 50,
        offset: 100,
      }),
    ).toMatchObject({
      filterText: 'drone',
      deletedFilter: 'all',
      aorIds: [10, 20],
      unitIds: [30],
      createdBy: 'cyber-user',
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

  it('detects active filters for empty states', () => {
    expect(hasActiveDevicesFilters('', createDefaultDevicesFilterState())).toBe(false);
    expect(hasActiveDevicesFilters('device', createDefaultDevicesFilterState())).toBe(true);
    expect(
      hasActiveDevicesFilters('', { ...createDefaultDevicesFilterState(), deletedFilter: 'all' }),
    ).toBe(true);
    expect(hasActiveDevicesFilters('', { ...createDefaultDevicesFilterState(), aorIds: [1] })).toBe(
      true,
    );
  });
});
