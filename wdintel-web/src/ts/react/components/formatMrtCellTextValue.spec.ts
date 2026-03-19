/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';

import { formatMrtCellTextValue } from './formatMrtCellTextValue';

describe('formatMrtCellTextValue', () => {
  it('returns an em dash for empty-like values', () => {
    expect(formatMrtCellTextValue(null)).toBe('—');
    expect(formatMrtCellTextValue(undefined)).toBe('—');
    expect(formatMrtCellTextValue('')).toBe('—');
    expect(formatMrtCellTextValue('   ')).toBe('—');
  });

  it('trims non-empty values', () => {
    expect(formatMrtCellTextValue('  Alpha  ')).toBe('Alpha');
  });
});
