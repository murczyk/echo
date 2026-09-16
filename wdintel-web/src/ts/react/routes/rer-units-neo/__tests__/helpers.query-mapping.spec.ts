import { describe, expect, it } from 'vitest';

import { buildUnitsListReq, readUnitNameColumnFilter, readUnitOrbitColumnFilter } from '../helpers';

// @test-scope parser: server-side unit query and hierarchy-filter fixtures.
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
      sortBy: 'NaturalMilitarySortAsc',
      includeInactive: true,
      filterActive: false,
      filterText: '55 омсбр',
      filterArmy: '3 АК',
      searchMode: 'Strict',
      limit: 20,
      offset: 40,
    });
  });

  // @test-scope parser: unit-list request fixture that preserves table sorting without a global search.
  it('keeps table sorting when there is no global unit search', () => {
    expect(
      buildUnitsListReq({
        statusFilter: 'active',
        globalFilter: '',
        columnFilters: [],
        sorting: [{ id: 'createdAt', desc: true }],
        searchMode: 'strict',
        pagination: { pageIndex: 0, pageSize: 20 },
      }).sortBy,
    ).toBe('CreatedAtDesc');
  });

  it('builds duplicate and Orbit presence filters with Orbit-link sorting', () => {
    expect(
      buildUnitsListReq({
        statusFilter: 'all',
        globalFilter: '',
        columnFilters: [
          {
            id: 'name',
            value: { text: ' 55 омсбр ', duplicateCandidate: 'yes' },
          },
          {
            id: 'hasOrbit',
            value: { text: ' примітка ', linked: 'no', comment: 'yes' },
          },
        ],
        sorting: [{ id: 'hasOrbit', desc: true }],
        searchMode: 'strict',
        pagination: { pageIndex: 0, pageSize: 20 },
      }),
    ).toMatchObject({
      sortBy: 'UnitOrbitLinkedDesc',
      filterName: '55 омсбр',
      filterIsDeduplicateCandidate: true,
      filterOrbitNote: 'примітка',
      filterHasOrbit: false,
      filterHasOrbitNote: true,
    });
  });

  it('keeps legacy text-only unit column filters', () => {
    expect(readUnitNameColumnFilter('назва')).toEqual({
      text: 'назва',
      duplicateCandidate: 'Усі',
    });
    expect(readUnitOrbitColumnFilter('коментар')).toEqual({
      text: 'коментар',
      linked: 'Усі',
      comment: 'Усі',
    });
  });
});
