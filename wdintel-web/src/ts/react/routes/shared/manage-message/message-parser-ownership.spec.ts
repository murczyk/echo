import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';

import type { DirectSubmitParseResponse } from '../../../services/api/direct-submit';
import { parseCoordinateBlock } from '../../../../maps/coordinate-parser';
import { EMPTY_FORM_VALUES, type MessageFormData } from './manage-message-drawer.schema';
import {
  acceptParsedCandidate,
  clearParserOwnedValues,
  createParserOwnershipState,
  recordManualChange,
  reconcileParserSnapshot,
  toParserSnapshot,
  type ParserSnapshot,
} from './message-parser-ownership';

const A_WGS = '49.12346, 37.23457';
const B_WGS = '49.22346, 37.33457';

function emptyForm(overrides: Partial<MessageFormData> = {}): MessageFormData {
  return { ...EMPTY_FORM_VALUES, ...overrides };
}

function emptySnapshot(overrides: Partial<ParserSnapshot['scalars']> = {}): ParserSnapshot {
  return {
    scalars: {
      text: undefined,
      freq: undefined,
      comment: undefined,
      post: undefined,
      unit: undefined,
      network_name: undefined,
      date: undefined,
      time: undefined,
      ...overrides,
    },
    lists: { coords: [], callsigns: [], locations: [] },
  };
}

function parseResponse(
  overrides: Partial<DirectSubmitParseResponse> = {},
): DirectSubmitParseResponse {
  return {
    text: '',
    coords: [],
    to: [],
    locations: [],
    ...overrides,
  };
}

describe('message parser field ownership', () => {
  it('updates and later clears a parser-owned scalar', () => {
    const first = reconcileParserSnapshot(
      createParserOwnershipState(),
      emptyForm(),
      emptySnapshot({ freq: '149.500' }),
    );

    expect(first.patch.freq).toBe('149.500');
    expect(first.state.scalarOrigins.freq).toBe('parsed');

    const second = reconcileParserSnapshot(
      first.state,
      emptyForm({ freq: '149.500' }),
      emptySnapshot(),
    );

    expect(second.patch.freq).toBe('');
    expect(second.changedFields).toContain('freq');
  });

  it('lets a parser candidate replace a never-owned initial value', () => {
    const result = reconcileParserSnapshot(
      createParserOwnershipState(),
      emptyForm({ unit: 'Початковий підрозділ' }),
      emptySnapshot({ unit: 'Розпізнаний підрозділ' }),
    );

    expect(result.patch.unit).toBe('Розпізнаний підрозділ');
    expect(result.state.scalarOrigins.unit).toBe('parsed');
  });

  it.each([
    ['freq', '', '149.500'],
    ['time', null, dayjs('2026-09-22T12:30:00Z')],
  ] as const)('protects a manually cleared %s field', (field, value, candidate) => {
    const manual = recordManualChange(createParserOwnershipState(), field, value, emptyForm());
    const result = reconcileParserSnapshot(
      manual,
      emptyForm({ [field]: value }),
      emptySnapshot({ [field]: candidate }),
    );

    expect(result.patch).not.toHaveProperty(field);
    expect(result.conflictFields).toContain(field);
  });

  it('does not report a conflict when the parsed candidate equals the manual value', () => {
    const current = emptyForm({ freq: '149.500' });
    const manual = recordManualChange(createParserOwnershipState(), 'freq', '149.500', current);

    const result = reconcileParserSnapshot(manual, current, emptySnapshot({ freq: '149.500' }));

    expect(result.conflictFields).not.toContain('freq');
    expect(result.patch).not.toHaveProperty('freq');
  });

  it('marks a conflict as removal when the latest parse has no candidate', () => {
    const current = emptyForm({ freq: '150.000' });
    const manual = recordManualChange(createParserOwnershipState(), 'freq', '150.000', current);

    const result = reconcileParserSnapshot(manual, current, emptySnapshot());

    expect(result.conflictFields).toContain('freq');
    expect(result.emptyCandidateFields).toContain('freq');
  });

  it('maps is_time_null to a present null candidate and clears absent parsed timestamps', () => {
    const withNullTime = toParserSnapshot(
      parseResponse({ timestamp: '2026-09-22T12:30:00Z', is_time_null: true }),
    );
    expect(Object.prototype.hasOwnProperty.call(withNullTime.scalars, 'time')).toBe(true);
    expect(withNullTime.scalars.time).toBeNull();

    const first = reconcileParserSnapshot(createParserOwnershipState(), emptyForm(), withNullTime);
    const second = reconcileParserSnapshot(
      first.state,
      emptyForm({ date: dayjs('2026-09-22'), time: null }),
      toParserSnapshot(parseResponse()),
    );

    expect(second.patch.date).toBeNull();
    expect(second.patch.time).toBeUndefined();
  });

  it.each([
    ['text', 'Ручний текст', 'Розпізнаний текст'],
    ['freq', '150.000', '151.000'],
    ['comment', 'Ручний коментар', 'Розпізнаний коментар'],
    ['post', 'Ручний пост', 'Розпізнаний пост'],
    ['unit', 'Ручний підрозділ', 'Розпізнаний підрозділ'],
    ['network_name', 'Ручна мережа', 'Розпізнана мережа'],
    ['date', dayjs('2026-09-21'), dayjs('2026-09-22')],
    ['time', dayjs('2026-09-22T12:30:00Z'), dayjs('2026-09-22T13:45:00Z')],
  ] as const)(
    'applies the last parsed %s candidate after explicit acceptance',
    (field, value, candidate) => {
      const current = emptyForm({ [field]: value });
      const manual = recordManualChange(createParserOwnershipState(), field, value, current);
      const conflicted = reconcileParserSnapshot(
        manual,
        current,
        emptySnapshot({ [field]: candidate }),
      );

      const accepted = acceptParsedCandidate(conflicted.state, current, field);

      expect(accepted.patch[field]).toEqual(candidate);
      expect(accepted.state.scalarOrigins[field]).toBe('parsed');
    },
  );

  it('removes parsed coordinate A while retaining manually added coordinate B', () => {
    const parsedA = reconcileParserSnapshot(
      createParserOwnershipState(),
      emptyForm(),
      toParserSnapshot(parseResponse({ coords: [{ lat: 49.12346, lon: 37.23457 }] })),
    );
    const currentA = emptyForm({ coords: A_WGS });
    const withManualB = recordManualChange(parsedA.state, 'coords', `${A_WGS}\n${B_WGS}`, currentA);

    const reparsed = reconcileParserSnapshot(
      withManualB,
      emptyForm({ coords: `${A_WGS}\n${B_WGS}` }),
      toParserSnapshot(parseResponse()),
    );

    expect(reparsed.patch.coords).toBe(B_WGS);
  });

  it('keeps coordinate ownership stable after API precision is serialized into the form', () => {
    const parsedA = reconcileParserSnapshot(
      createParserOwnershipState(),
      emptyForm(),
      toParserSnapshot(parseResponse({ coords: [{ lat: 49.123457, lon: 37.234568 }] })),
    );
    const serializedA = parsedA.patch.coords as string;
    const withManualB = recordManualChange(
      parsedA.state,
      'coords',
      `${serializedA}\n${B_WGS}`,
      emptyForm({ coords: serializedA }),
    );

    const cleared = clearParserOwnedValues(
      withManualB,
      emptyForm({ coords: `${serializedA}\n${B_WGS}` }),
    );

    expect(cleared.patch.coords).toBe(B_WGS);
  });

  it('suppresses a manually removed parsed coordinate across disappearance and reappearance', () => {
    const parsedA = reconcileParserSnapshot(
      createParserOwnershipState(),
      emptyForm(),
      toParserSnapshot(parseResponse({ coords: [{ lat: 49.12346, lon: 37.23457 }] })),
    );
    const suppressed = recordManualChange(
      parsedA.state,
      'coords',
      '',
      emptyForm({ coords: A_WGS }),
    );
    const absent = reconcileParserSnapshot(
      suppressed,
      emptyForm(),
      toParserSnapshot(parseResponse()),
    );
    const returned = reconcileParserSnapshot(
      absent.state,
      emptyForm(),
      toParserSnapshot(parseResponse({ coords: [{ lat: 49.12346, lon: 37.23457 }] })),
    );

    expect(returned.patch).not.toHaveProperty('coords');
    expect(returned.conflictFields).toContain('coords');
  });

  it('restores suppressed parsed list items without deleting manual items', () => {
    const parsedA = reconcileParserSnapshot(
      createParserOwnershipState(),
      emptyForm(),
      toParserSnapshot(parseResponse({ coords: [{ lat: 49.12346, lon: 37.23457 }] })),
    );
    const withB = recordManualChange(
      parsedA.state,
      'coords',
      `${A_WGS}\n${B_WGS}`,
      emptyForm({ coords: A_WGS }),
    );
    const suppressedA = recordManualChange(
      withB,
      'coords',
      B_WGS,
      emptyForm({ coords: `${A_WGS}\n${B_WGS}` }),
    );
    const conflicted = reconcileParserSnapshot(
      suppressedA,
      emptyForm({ coords: B_WGS }),
      toParserSnapshot(parseResponse({ coords: [{ lat: 49.12346, lon: 37.23457 }] })),
    );

    const accepted = acceptParsedCandidate(
      conflicted.state,
      emptyForm({ coords: B_WGS }),
      'coords',
    );

    expect(accepted.patch.coords).toBe(`${B_WGS}\n${A_WGS}`);
  });

  it.each([
    ['callsigns', 'ALPHA', ['ALPHA']],
    ['locations', 'Купʼянськ', ['Купʼянськ']],
  ] as const)(
    'restores a suppressed parsed %s item after explicit acceptance',
    (field, value, expected) => {
      const snapshot = emptySnapshot();
      snapshot.lists[field] = [{ key: value, value }];
      const parsed = reconcileParserSnapshot(createParserOwnershipState(), emptyForm(), snapshot);
      const current = emptyForm({ [field]: expected });
      const suppressed = recordManualChange(parsed.state, field, [], current);
      const conflicted = reconcileParserSnapshot(suppressed, emptyForm(), snapshot);

      const accepted = acceptParsedCandidate(conflicted.state, emptyForm(), field);

      expect(accepted.patch[field]).toEqual(expected);
    },
  );

  it('deduplicates one point across WGS and MGRS while retaining a nearby point', () => {
    const parsed = toParserSnapshot(parseResponse({ coords: [{ lat: 49.12346, lon: 37.23457 }] }));
    const mgrsA = parsed.lists.coords[0]?.key;
    expect(mgrsA).toBeTruthy();

    const result = recordManualChange(
      createParserOwnershipState(),
      'coords',
      `${A_WGS}\n${mgrsA}\n${B_WGS}`,
      emptyForm(),
    );

    expect(result.lists.coords.manual).toHaveLength(2);
  });

  it('normalizes callsign duplicates and keeps exact location duplicates once', () => {
    const callsigns = recordManualChange(
      createParserOwnershipState(),
      'callsigns',
      ['alpha', 'ALPHA', 'bravo'],
      emptyForm(),
    );
    const locations = recordManualChange(
      callsigns,
      'locations',
      ['Купʼянськ', 'Купʼянськ'],
      emptyForm(),
    );

    expect(locations.lists.callsigns.manual.map(({ value }) => value)).toEqual(['ALPHA', 'BRAVO']);
    expect(locations.lists.locations.manual.map(({ value }) => value)).toEqual(['Купʼянськ']);
  });

  it('clears only parser-owned values when source text becomes empty', () => {
    const parsed = reconcileParserSnapshot(
      createParserOwnershipState(),
      emptyForm({ unit: 'Початковий' }),
      emptySnapshot({ freq: '149.500' }),
    );
    const withManual = recordManualChange(
      parsed.state,
      'time',
      null,
      emptyForm({ unit: 'Початковий', freq: '149.500' }),
    );

    const cleared = clearParserOwnedValues(
      withManual,
      emptyForm({ unit: 'Початковий', freq: '149.500', time: null }),
    );

    expect(cleared.patch).toEqual({ freq: '' });
    expect(cleared.conflictFields).toEqual([]);
  });

  it('keeps two nearby coordinates as separate parsed points', () => {
    const snapshot = toParserSnapshot(
      parseResponse({
        coords: [
          { lat: 49.12346, lon: 37.23457 },
          { lat: 49.12356, lon: 37.23467 },
        ],
      }),
    );

    expect(snapshot.lists.coords).toHaveLength(2);
    expect(
      parseCoordinateBlock(snapshot.lists.coords.map(({ value }) => value).join('\n')),
    ).toHaveLength(2);
  });
});
