/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';

import {
  APP_DATE_INPUT_MIN,
  APP_DATE_INPUT_MIN_YEAR,
  APP_DATETIME_INPUT_MIN,
  APP_TIME_ZONE,
  combineDateTimeToMs,
  combineDateTimeInputToMs,
  formatDate,
  formatDateTime24,
  formatDateTimeInputValueInTimeZone,
  formatDateInputValueInTimeZone,
  formatLocalDateInputValue,
  formatTimeInputValueInTimeZone,
  isValidDateInput,
  objectsEqual,
  sortFrequenciesNumerically,
  sortStringsAlphabetically,
  strArraysEqual,
  uppercaseStrings,
} from './misc';

describe('misc utils', () => {
  it('compares string arrays by value and order', () => {
    expect(strArraysEqual(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(strArraysEqual(['a', 'b'], ['b', 'a'])).toBe(false);
  });

  it('sorts strings alphabetically without mutating the input', () => {
    const values = ['9.000', '10.000', '1.000', '2.000'];

    expect(sortStringsAlphabetically(values)).toEqual(['1.000', '10.000', '2.000', '9.000']);
    expect(values).toEqual(['9.000', '10.000', '1.000', '2.000']);
  });

  it('sorts frequencies numerically without mutating the input', () => {
    const values = ['9.000', '10.000', '1.000', '2.000', '1.2', '1.02', 'not-a-freq'];

    expect(sortFrequenciesNumerically(values)).toEqual([
      '1.000',
      '1.02',
      '1.2',
      '2.000',
      '9.000',
      '10.000',
      'not-a-freq',
    ]);
    expect(values).toEqual(['9.000', '10.000', '1.000', '2.000', '1.2', '1.02', 'not-a-freq']);
  });

  it('uppercases strings without mutating the input', () => {
    const values = ['alpha', 'Bravo'];

    expect(uppercaseStrings(values)).toEqual(['ALPHA', 'BRAVO']);
    expect(values).toEqual(['alpha', 'Bravo']);
  });

  it('compares shallow objects by keys and primitive values', () => {
    expect(objectsEqual({ a: 1, b: 'x' }, { b: 'x', a: 1 })).toBe(true);
    expect(objectsEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(objectsEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it('formats dates defensively', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate(Number.NaN)).toBe('—');
    expect(
      formatDate(Date.UTC(2026, 2, 18), { year: 'numeric', month: '2-digit', day: '2-digit' }),
    ).toContain('18');
  });

  it('formats date-times in 24-hour mode', () => {
    expect(formatDateTime24(null)).toBe('—');
    expect(formatDateTime24(Number.NaN)).toBe('—');
    const ms = Date.UTC(2026, 2, 18, 14, 5);
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    expect(formatDateTime24(ms)).toContain(`${hh}:${mm}`);
  });

  it('shares native date input bounds and parsing helpers', () => {
    expect(APP_DATE_INPUT_MIN).toBe('2022-01-01');
    expect(APP_DATETIME_INPUT_MIN).toBe('2022-01-01T00:00');
    expect(APP_DATE_INPUT_MIN_YEAR).toBe(2022);
    expect(formatLocalDateInputValue(new Date(2026, 2, 23))).toBe('2026-03-23');
    expect(isValidDateInput('2021-12-31')).toBe(false);
    expect(isValidDateInput('2022-01-01')).toBe(true);
    expect(combineDateTimeToMs('2021-12-31', '12:00')).toBeNull();
    expect(combineDateTimeToMs('2022-01-01', '12:00')).not.toBeNull();
  });

  // @test-scope parser: application-timezone date-time input and display format
  it('parses and formats analysis date-times in the app timezone', () => {
    const millis = combineDateTimeToMs('2026-01-15', '12:00', APP_TIME_ZONE);

    expect(millis).toBe(Date.UTC(2026, 0, 15, 10, 0, 0));
    expect(
      formatDateInputValueInTimeZone(new Date(Date.UTC(2026, 0, 15, 10, 0, 0)), APP_TIME_ZONE),
    ).toBe('2026-01-15');
    expect(
      formatTimeInputValueInTimeZone(new Date(Date.UTC(2026, 0, 15, 10, 0, 0)), APP_TIME_ZONE),
    ).toBe('12:00');
    expect(
      formatDateTimeInputValueInTimeZone(new Date(Date.UTC(2026, 0, 15, 10, 0, 0)), APP_TIME_ZONE),
    ).toBe('2026-01-15T12:00');
    expect(combineDateTimeInputToMs('2026-01-15T12:00', APP_TIME_ZONE)).toBe(
      Date.UTC(2026, 0, 15, 10, 0, 0),
    );
    expect(combineDateTimeInputToMs('2026-01-15 12:00', APP_TIME_ZONE)).toBeNull();
  });
});
