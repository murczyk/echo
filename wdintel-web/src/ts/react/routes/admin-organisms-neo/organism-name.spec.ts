/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';

import { formatOrganismName } from './index';

describe('formatOrganismName', () => {
  it('renders null-like and placeholder names as missing data', () => {
    expect(formatOrganismName(null)).toBe('—');
    expect(formatOrganismName('')).toBe('—');
    expect(formatOrganismName('  ')).toBe('—');
    expect(formatOrganismName('-')).toBe('—');
  });

  it('trims actual organism names', () => {
    expect(formatOrganismName('  РЕР група  ')).toBe('РЕР група');
  });
});
