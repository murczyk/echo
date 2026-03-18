/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';

import { formatDate, formatDateTime24, objectsEqual, strArraysEqual } from './misc';

describe('misc utils', () => {
  it('compares string arrays by value and order', () => {
    expect(strArraysEqual(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(strArraysEqual(['a', 'b'], ['b', 'a'])).toBe(false);
  });

  it('compares shallow objects by keys and primitive values', () => {
    expect(objectsEqual({ a: 1, b: 'x' }, { b: 'x', a: 1 })).toBe(true);
    expect(objectsEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(objectsEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it('formats dates defensively', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate(Number.NaN)).toBe('—');
    expect(formatDate(Date.UTC(2026, 2, 18), { year: 'numeric', month: '2-digit', day: '2-digit' })).toContain('18');
  });

  it('formats date-times in 24-hour mode', () => {
    expect(formatDateTime24(null)).toBe('—');
    expect(formatDateTime24(Number.NaN)).toBe('—');
    expect(formatDateTime24(Date.UTC(2026, 2, 18, 14, 5))).toContain('14:05');
  });
});
