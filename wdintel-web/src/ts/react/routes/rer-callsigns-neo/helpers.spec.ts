/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';

import {
  CALLSIGN_FORM_HINT,
  EMPTY_CALLSIGN_ROW_ERROR,
  LEGACY_CALLSIGN_CLEAR_ERROR,
  buildListCallsignsReq,
  createDefaultFilters,
  getSortDescriptor,
  normalizeDuplicateLookupValue,
  nextSortState,
  parseTabDelimitedInput,
  parseDateTimeLocalToMs,
  QUICK_PASTE_TSV_FORMAT_ERROR,
  RO_SOURCE_RADIO_FREQ_REQUIRED_ERROR,
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
    expect(CALLSIGN_FORM_HINT).toContain('"Позивний"');
  });

  it('builds list request using trimmed filters and explicit developing status', () => {
    const filters = {
      ...createDefaultFilters(new Date('2026-03-18T12:00:00Z')),
      filterText: '  alpha  ',
      filterCallsign: '  bravo  ',
      filterFullName: '  Іваненко  ',
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
    expect(req.filterFullName).toBe('Іваненко');
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
    expect(toBackendSort({ column: 'fullName', direction: 'asc' })).toEqual(['CallsignFullNameAsc']);
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

  it("requires callsign or full name for draft rows", () => {
    expect(validateDraftRows([{ callsign: "", position: "Командир", fullName: "", comment: "", developing: false, radioFreq: "" }], null)).toEqual({
      valid: true,
      error: null,
    });

    expect(validateDraftRows([{ callsign: "", position: "Командир", fullName: "Іваненко І.І.", comment: "", developing: false, radioFreq: "" }], null)).toEqual({
      valid: true,
      error: null,
    });
  });

  it('rejects draft rows that remain completely empty after filtering', () => {
    expect(validateDraftRows([{ callsign: "", position: "", fullName: "", comment: "", developing: false, radioFreq: "" }], null)).toEqual({
      valid: false,
      error: 'Заповніть хоча б один рядок',
    });
  });

  it("requires radio frequency for draft rows with source 'РО'", () => {
    expect(validateDraftRows([{ callsign: "ALPHA", position: "Командир", fullName: "", comment: "", developing: false, radioFreq: "" }], 2)).toEqual({
      valid: false,
      error: RO_SOURCE_RADIO_FREQ_REQUIRED_ERROR,
    });

    expect(validateDraftRows([{ callsign: "ALPHA", position: "Командир", fullName: "", comment: "", developing: false, radioFreq: "145.500" }], 2)).toEqual({
      valid: true,
      error: null,
    });
  });

  it("requires callsign or full name when editing", () => {
    expect(validateEditForm({
      id: 1,
      callsign: "",
      position: "Командир",
      fullName: "",
      comment: "",
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

    expect(validateEditForm({
      id: 1,
      callsign: "",
      position: "Командир",
      fullName: "Іваненко І.І.",
      comment: "",
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

  it('allows editing legacy rows without callsign/full name while they still contain other data', () => {
    expect(validateEditForm({
      id: 1,
      callsign: "",
      position: "Командир",
      fullName: "",
      comment: "старий коментар",
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

  it('allows editing legacy rows without callsign/full name when only metadata remains', () => {
    expect(validateEditForm({
      id: 1,
      callsign: "",
      position: "",
      fullName: "",
      comment: "",
      callsignAdditionalSourceIds: [3],
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

  it('rejects clearing all meaningful data from legacy rows without callsign/full name', () => {
    expect(validateEditForm({
      id: 1,
      callsign: "",
      position: "",
      fullName: "",
      comment: "",
      callsignAdditionalSourceIds: [],
      unitId: 0,
      sourceId: null,
      developing: false,
      radioFreq: "",
      createdAt: 0,
      active: true,
    })).toEqual({
      valid: false,
      error: LEGACY_CALLSIGN_CLEAR_ERROR,
    });
  });

  it('allows removing identity from an existing record when other meaningful data remains', () => {
    expect(validateEditForm({
      id: 1,
      callsign: "",
      position: "",
      fullName: "",
      comment: "старий коментар",
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

  it('keeps legacy TSV quick-paste format as callsign, position, comment', () => {
    expect(parseTabDelimitedInput('alpha\tКомандир\tстарий коментар')).toEqual({
      rows: [
        {
          callsign: 'ALPHA',
          position: 'Командир',
          fullName: '',
          comment: 'старий коментар',
          developing: false,
          radioFreq: '',
        },
      ],
      error: null,
    });
  });

  it('parses 4-column TSV quick-paste as callsign, position, full name, comment', () => {
    expect(parseTabDelimitedInput('alpha\tКомандир\tІваненко Іван Іванович\tновий коментар')).toEqual({
      rows: [
        {
          callsign: 'ALPHA',
          position: 'Командир',
          fullName: 'Іваненко Іван Іванович',
          comment: 'новий коментар',
          developing: false,
          radioFreq: '',
        },
      ],
      error: null,
    });
  });

  it('preserves an empty trailing TSV column instead of collapsing the row shape', () => {
    expect(parseTabDelimitedInput('alpha\tКомандир\tІваненко Іван Іванович\t')).toEqual({
      rows: [
        {
          callsign: 'ALPHA',
          position: 'Командир',
          fullName: 'Іваненко Іван Іванович',
          comment: '',
          developing: false,
          radioFreq: '',
        },
      ],
      error: null,
    });

    expect(parseTabDelimitedInput('alpha\tКомандир\t')).toEqual({
      rows: [
        {
          callsign: 'ALPHA',
          position: 'Командир',
          fullName: '',
          comment: '',
          developing: false,
          radioFreq: '',
        },
      ],
      error: null,
    });
  });

  it('parses multiline TSV with mixed 3-column and 4-column rows per line', () => {
    expect(parseTabDelimitedInput(
      'alpha\tКомандир\tстарий коментар\nbravo\tНавідник\tПетренко Петро Петрович\tновий коментар',
    )).toEqual({
      rows: [
        {
          callsign: 'ALPHA',
          position: 'Командир',
          fullName: '',
          comment: 'старий коментар',
          developing: false,
          radioFreq: '',
        },
        {
          callsign: 'BRAVO',
          position: 'Навідник',
          fullName: 'Петренко Петро Петрович',
          comment: 'новий коментар',
          developing: false,
          radioFreq: '',
        },
      ],
      error: null,
    });
  });

  it('returns a validation error for unsupported TSV quick-paste row shapes', () => {
    expect(parseTabDelimitedInput('alpha\tКомандир')).toEqual({
      rows: [],
      error: QUICK_PASTE_TSV_FORMAT_ERROR,
    });
  });

  it('treats flat multi-row TSV streams as invalid to keep quick-paste unambiguous', () => {
    expect(parseTabDelimitedInput('alpha\tКомандир\tкоментар\tbravo\tНавідник\tінший коментар')).toEqual({
      rows: [],
      error: QUICK_PASTE_TSV_FORMAT_ERROR,
    });
  });

  it('normalizes duplicate-hint values for full names', () => {
    expect(normalizeDuplicateLookupValue('  Іваненко   Іван  ')).toBe('іваненко іван');
  });
});
