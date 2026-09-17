/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';

import {
  EMPTY_CALLSIGN_ROW_ERROR,
  buildDuplicateHintGroups,
  LEGACY_CALLSIGN_CLEAR_ERROR,
  getExportPermission,
  getExportPermissionFromRoles,
  getUnitSelectionError,
  parseTabDelimitedInput,
  parseDateTimeLocalToMs,
  QUICK_PASTE_TSV_FORMAT_ERROR,
  RO_SOURCE_RADIO_FREQ_REQUIRED_ERROR,
  UNIT_SELECTION_REQUIRED_ERROR,
  validateDraftRows,
  validateEditForm,
} from '../helpers';
import type { Callsign, Unit, User } from '../../../../../Bindings';

const EMPTY_UNIT_HIERARCHY = {
  armyRegion: '',
  militaryDistrict: '',
  army: '',
  corps: '',
  division: '',
  brigade: '',
  regiment: '',
  battalion: '',
  company: '',
  platoon: '',
  squad: '',
  section: '',
  teamOrCrew: '',
  other: '',
} as const;

describe('rer-callsigns helpers', () => {
  // @test-scope safeguard: prevents duplicate hints from being assigned to the wrong draft callsign row
  it('groups duplicate hints by draft row and keeps row indices', () => {
    const unitsById = new Map<number, Unit>([
      [1, { id: 1, name: '11 АК' } as Unit],
      [2, { id: 2, name: '12 АК' } as Unit],
    ]);
    const callsigns = [
      {
        id: 10,
        callsign: 'ЛЕСНОЙ',
        position: 'Командир',
        fullName: 'Іваненко Іван',
        comment: '',
        unitId: 1,
      } as Callsign,
      {
        id: 11,
        callsign: 'БАРС-4',
        position: 'Старший',
        fullName: 'Петров Петро',
        comment: '',
        unitId: 2,
      } as Callsign,
    ];

    const groups = buildDuplicateHintGroups(
      [
        { rowIndex: 0, callsignInput: 'лес', fullNameInput: '', positionInput: '' },
        { rowIndex: 1, callsignInput: '', fullNameInput: 'петров', positionInput: '' },
      ],
      callsigns,
      null,
      unitsById,
    );

    expect(groups).toEqual([
      {
        rowIndex: 0,
        matches: [
          {
            id: 10,
            callsign: 'ЛЕСНОЙ',
            position: 'Командир',
            fullName: 'Іваненко Іван',
            comment: '',
            unitName: '11 АК',
          },
        ],
      },
      {
        rowIndex: 1,
        matches: [
          {
            id: 11,
            callsign: 'БАРС-4',
            position: 'Старший',
            fullName: 'Петров Петро',
            comment: '',
            unitName: '12 АК',
          },
        ],
      },
    ]);
  });

  // @test-scope safeguard: prevents a position change from hiding a real duplicate callsign warning
  it('does not hide duplicate hints when pasted position differs from the existing callsign', () => {
    const unitsById = new Map<number, Unit>([[1, { id: 1, name: '11 АК' } as Unit]]);
    const callsigns = [
      {
        id: 10,
        callsign: 'ЛЕСНОЙ',
        position: 'Старший оператор',
        fullName: 'Іваненко Іван',
        comment: '',
        unitId: 1,
      } as Callsign,
    ];

    const groups = buildDuplicateHintGroups(
      [{ rowIndex: 0, callsignInput: 'лесной', fullNameInput: '', positionInput: 'командир' }],
      callsigns,
      1,
      unitsById,
    );

    expect(groups).toEqual([
      {
        rowIndex: 0,
        matches: [
          {
            id: 10,
            callsign: 'ЛЕСНОЙ',
            position: 'Старший оператор',
            fullName: 'Іваненко Іван',
            comment: '',
            unitName: '11 АК',
          },
        ],
      },
    ]);
  });

  // @test-scope safeguard: prevents users without backend edit roles from receiving callsign mutation access
  it('keeps callsign edit access aligned with backend roles', () => {
    expect(getExportPermission({ roles: ['UnitsEditor'] } as User).canEdit).toBe(false);
    expect(getExportPermission({ roles: ['Admin'] } as User).canEdit).toBe(true);
    expect(getExportPermission({ roles: ['Rer', 'CallsignsEditor'] } as User).canEdit).toBe(true);
    expect(getExportPermission({ roles: ['Full', 'CallsignsEditor'] } as User).canEdit).toBe(true);
    expect(getExportPermission({ roles: ['Admin'] } as User).canExport).toBe(true);
    expect(getExportPermissionFromRoles(['UnitsEditor'])).toEqual({
      canEdit: false,
      canExport: false,
    });
    expect(getExportPermissionFromRoles(['Rer', 'CallsignsEditor'])).toEqual({
      canEdit: true,
      canExport: true,
    });
    expect(getExportPermissionFromRoles(['Full'])).toEqual({
      canEdit: false,
      canExport: true,
    });
    expect(getExportPermissionFromRoles(['Full', 'CallsignsEditor'])).toEqual({
      canEdit: true,
      canExport: true,
    });
  });

  // @test-scope safeguard: prevents submission of draft callsign rows without an identity
  it('requires callsign or full name for draft rows', () => {
    expect(
      validateDraftRows(
        [
          {
            callsign: '',
            position: 'Командир',
            fullName: '',
            comment: '',
            developing: false,
            radioFreq: '',
          },
        ],
        null,
      ),
    ).toEqual({
      valid: true,
      error: null,
    });

    expect(
      validateDraftRows(
        [
          {
            callsign: '',
            position: 'Командир',
            fullName: 'Іваненко І.І.',
            comment: '',
            developing: false,
            radioFreq: '',
          },
        ],
        null,
      ),
    ).toEqual({
      valid: true,
      error: null,
    });
  });

  // @test-scope safeguard: prevents empty callsign draft rows from producing a mutation
  it('rejects draft rows that remain completely empty after filtering', () => {
    expect(
      validateDraftRows(
        [
          {
            callsign: '',
            position: '',
            fullName: '',
            comment: '',
            developing: false,
            radioFreq: '',
          },
        ],
        null,
      ),
    ).toEqual({
      valid: false,
      error: 'Заповніть хоча б один рядок',
    });
  });

  // @test-scope safeguard: prevents radio-source callsign drafts without a required frequency from saving
  it("requires radio frequency for draft rows with source 'РО'", () => {
    expect(
      validateDraftRows(
        [
          {
            callsign: 'ALPHA',
            position: 'Командир',
            fullName: '',
            comment: '',
            developing: false,
            radioFreq: '',
          },
        ],
        2,
      ),
    ).toEqual({
      valid: false,
      error: RO_SOURCE_RADIO_FREQ_REQUIRED_ERROR,
    });

    expect(
      validateDraftRows(
        [
          {
            callsign: 'ALPHA',
            position: 'Командир',
            fullName: '',
            comment: '',
            developing: false,
            radioFreq: '145.500',
          },
        ],
        2,
      ),
    ).toEqual({
      valid: true,
      error: null,
    });
  });

  // @test-scope safeguard: prevents an edited callsign record from losing all identity fields
  it('requires callsign or full name when editing', () => {
    expect(
      validateEditForm({
        id: 1,
        callsign: '',
        position: 'Командир',
        fullName: '',
        comment: '',
        callsignAdditionalSourceIds: [],
        unitId: 10,
        sourceId: 1,
        developing: false,
        radioFreq: '',
        createdAt: 0,
        active: true,
      }),
    ).toEqual({
      valid: true,
      error: null,
    });

    expect(
      validateEditForm({
        id: 1,
        callsign: '',
        position: 'Командир',
        fullName: 'Іваненко І.І.',
        comment: '',
        callsignAdditionalSourceIds: [],
        unitId: 10,
        sourceId: 1,
        developing: false,
        radioFreq: '',
        createdAt: 0,
        active: true,
      }),
    ).toEqual({
      valid: true,
      error: null,
    });
  });

  // @test-scope safeguard: preserves valid legacy callsign rows that retain meaningful non-identity data
  it('allows editing legacy rows without callsign/full name while they still contain other data', () => {
    expect(
      validateEditForm({
        id: 1,
        callsign: '',
        position: 'Командир',
        fullName: '',
        comment: 'старий коментар',
        callsignAdditionalSourceIds: [],
        unitId: 10,
        sourceId: 1,
        developing: false,
        radioFreq: '',
        createdAt: 0,
        active: true,
      }),
    ).toEqual({
      valid: true,
      error: null,
    });
  });

  // @test-scope safeguard: preserves legacy callsign metadata records during compatible edits
  it('allows editing legacy rows without callsign/full name when only metadata remains', () => {
    expect(
      validateEditForm({
        id: 1,
        callsign: '',
        position: '',
        fullName: '',
        comment: '',
        callsignAdditionalSourceIds: [3],
        unitId: 10,
        sourceId: 1,
        developing: false,
        radioFreq: '',
        createdAt: 0,
        active: true,
      }),
    ).toEqual({
      valid: true,
      error: null,
    });
  });

  // @test-scope safeguard: prevents clearing every meaningful field from a legacy callsign record
  it('rejects clearing all meaningful data from legacy rows without callsign/full name', () => {
    expect(
      validateEditForm({
        id: 1,
        callsign: '',
        position: '',
        fullName: '',
        comment: '',
        callsignAdditionalSourceIds: [],
        unitId: 0,
        sourceId: null,
        developing: false,
        radioFreq: '',
        createdAt: 0,
        active: true,
      }),
    ).toEqual({
      valid: false,
      error: LEGACY_CALLSIGN_CLEAR_ERROR,
    });
  });

  // @test-scope safeguard: allows compatible identity removal without turning a populated legacy record into an invalid row
  it('allows removing identity from an existing record when other meaningful data remains', () => {
    expect(
      validateEditForm({
        id: 1,
        callsign: '',
        position: '',
        fullName: '',
        comment: 'старий коментар',
        callsignAdditionalSourceIds: [],
        unitId: 10,
        sourceId: 1,
        developing: false,
        radioFreq: '',
        createdAt: 0,
        active: true,
      }),
    ).toEqual({
      valid: true,
      error: null,
    });
  });

  // @test-scope parser: legacy callsign quick-paste TSV fixture
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

  // @test-scope parser: four-column callsign quick-paste TSV fixture
  it('parses 4-column TSV quick-paste as callsign, position, full name, comment', () => {
    expect(
      parseTabDelimitedInput('alpha\tКомандир\tІваненко Іван Іванович\tновий коментар'),
    ).toEqual({
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

  // @test-scope parser: callsign TSV trailing-empty-column fixture
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

  // @test-scope parser: multiline mixed-shape callsign TSV fixture
  it('parses multiline TSV with mixed 3-column and 4-column rows per line', () => {
    expect(
      parseTabDelimitedInput(
        'alpha\tКомандир\tстарий коментар\nbravo\tНавідник\tПетренко Петро Петрович\tновий коментар',
      ),
    ).toEqual({
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

  // @test-scope parser: unsupported callsign TSV row-shape rejection fixture
  it('returns a validation error for unsupported TSV quick-paste row shapes', () => {
    expect(parseTabDelimitedInput('alpha\tКомандир')).toEqual({
      rows: [],
      error: QUICK_PASTE_TSV_FORMAT_ERROR,
    });
  });

  // @test-scope parser: ambiguous flat multi-row callsign TSV rejection fixture
  it('treats flat multi-row TSV streams as invalid to keep quick-paste unambiguous', () => {
    expect(
      parseTabDelimitedInput('alpha\tКомандир\tкоментар\tbravo\tНавідник\tінший коментар'),
    ).toEqual({
      rows: [],
      error: QUICK_PASTE_TSV_FORMAT_ERROR,
    });
  });
});
