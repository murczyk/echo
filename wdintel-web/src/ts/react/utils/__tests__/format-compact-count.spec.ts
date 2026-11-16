import { describe, expect, it } from 'vitest';

import { formatCompactCount } from '../format-compact-count';

describe('formatCompactCount', () => {
  it('keeps up to 999 as is', () => {
    expect([0, 7, 999].map(formatCompactCount)).toEqual(['0', '7', '999']);
  });

  it('shortens thousands with one decimal and drops a zero decimal', () => {
    expect([1000, 1049, 1234, 9999, 12000, 12345].map(formatCompactCount)).toEqual([
      '1k',
      '1k',
      '1.2k',
      '10k',
      '12k',
      '12.3k',
    ]);
  });
});
