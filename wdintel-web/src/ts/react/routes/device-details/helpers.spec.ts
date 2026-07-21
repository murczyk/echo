import { describe, expect, it } from 'vitest';

import { formatUnitLabel } from './helpers';

describe('device details helpers', () => {
  it('formats missing unit labels with id fallback', () => {
    expect(formatUnitLabel(8, '')).toBe('Підрозділ #8 — назва недоступна');
  });
});
