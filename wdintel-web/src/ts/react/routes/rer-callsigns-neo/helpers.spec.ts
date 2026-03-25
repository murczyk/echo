/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';

import {
  buildListCallsignsReq,
  createDefaultFilters,
  getSortDescriptor,
  nextSortState,
  parseDateTimeLocalToMs,
  toBackendSort,
  validateDraftRows,
  validateEditForm,
} from './helpers';
import type { CallsignsSortState } from './types';

describe('rer-callsigns helpers', () => {
  it('creates default filters with OnlyNonDeveloping selected', () => {
    const filters = createDefaultFilters(new Date('2026-03-18T12:00:00Z'));

    expect(filters.filterDeveloping).toBe('OnlyNonDeveloping');
    expect(filters.isIgnoringDateFilter).toBe(true);
  });

  it('builds list request using trimmed filters and explicit developing status', () => {
    const filters = {
      ...createDefaultFilters(new Date('2026-03-18T12:00:00Z')),
      filterText: '  alpha  ',
      filterCallsign: '  bravo  ',
      filterDeveloping: 'All' as const,
      isIgnoringDateFilter: false,
      fromDateTimeLocal: '2026-03-10T10:00',
      toDateTimeLocal: '2026-03-18T12:00',
    };
    const sort: CallsignsSortState = { column: 'createdAt', direction: 'desc' };

    const req = buildListCallsignsReq({
      filters,
      sort,
      query: { afterId: 42, limit: 100 },
    });

    expect(req.filterText).toBe('alpha');
    expect(req.filterCallsign).toBe('bravo');
    expect(req.filterDeveloping).toBe('All');
    expect(req.afterId).toBe(42);
    expect(req.sortBy).toEqual(['CallsignCreatedAtDesc']);
    expect(req.sinceDateInclusiveMs).toBe(parseDateTimeLocalToMs('2026-03-10T10:00'));
    expect(req.tillDateInclusiveMs).toBe(parseDateTimeLocalToMs('2026-03-18T12:00'));
  });

  it('keeps sidebar hierarchy filters in the request, including empty hierarchy nodes', () => {
    const req = buildListCallsignsReq({
      filters: createDefaultFilters(new Date('2026-03-18T12:00:00Z')),
      sort: { column: 'unit', direction: 'asc' },
      query: { afterId: null, limit: 100 },
      sidebarUnitHierarchyFilter: {
        army: 'A',
        division: '',
        regiment: null,
        battalion: null,
      },
    });

    expect(req.filterUnitArmy).toBe('A');
    expect(req.filterUnitDivision).toBe('');
    expect(req.filterUnitRegiment).toBeNull();
    expect(req.filterUnitBattalion).toBeNull();
  });

  it('maps sort state to backend sort enums', () => {
    expect(toBackendSort({ column: 'callsign', direction: 'asc' })).toEqual(['CallsignAsc']);
    expect(toBackendSort({ column: 'sourceName', direction: 'desc' })).toEqual(['CallsignSourceDesc']);
    expect(toBackendSort({ column: 'unit', direction: 'asc' })).toEqual(['CallsignUnitAsc']);
  });

  it('advances sort state consistently and reports descriptor labels', () => {
    const current: CallsignsSortState = { column: 'unit', direction: 'asc' };

    expect(nextSortState(current, 'unit')).toEqual({ column: 'unit', direction: 'desc' });
    expect(nextSortState(current, 'createdAt')).toEqual({ column: 'createdAt', direction: 'desc' });
    expect(nextSortState(current, 'position', 'asc')).toEqual({ column: 'position', direction: 'asc' });

    expect(getSortDescriptor({ column: 'position', direction: 'asc' }, 'position')).toEqual({
      backend: ['CallsignPositionAsc'],
      label: 'asc',
    });
    expect(getSortDescriptor({ column: 'position', direction: 'asc' }, 'unit')).toEqual({
      backend: [],
      label: 'none',
    });
  });

  it("requires callsign or comment for draft rows", () => {
    expect(validateDraftRows([{ callsign: "", position: "Командир", comment: "", developing: false, radioFreq: "" }], null)).toEqual({
      valid: false,
      error: "Заповніть поле \"Позивний\" або \"Коментар\"",
    });

    expect(validateDraftRows([{ callsign: "", position: "Командир", comment: "Іваненко І.І.", developing: false, radioFreq: "" }], null)).toEqual({
      valid: true,
      error: null,
    });
  });

  it("requires callsign or comment when editing", () => {
    expect(validateEditForm({
      id: 1,
      callsign: "",
      position: "Командир",
      comment: "",
      callsignAdditionalSourceIds: [],
      unitId: 10,
      sourceId: 1,
      developing: false,
      radioFreq: "",
      createdAt: 0,
      active: true,
    })).toEqual({
      valid: false,
      error: "Заповніть поле \"Позивний\" або \"Коментар\"",
    });

    expect(validateEditForm({
      id: 1,
      callsign: "",
      position: "Командир",
      comment: "Іваненко І.І.",
      callsignAdditionalSourceIds: [],
      unitId: 10,
      sourceId: 1,
      developing: false,
      radioFreq: "",
      createdAt: 0,
      active: true,
    })).toEqual({
      valid: true,
      error: null,
    });
  });
});
