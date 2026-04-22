import { describe, expect, it } from 'vitest';

import { normalizeMapMessageIds, shouldClearMapOpenMessages } from './use-analysis-data.loaders';

describe('normalizeMapMessageIds', () => {
  it('filters nullish and duplicate ids', () => {
    expect(normalizeMapMessageIds([1, null, 2, undefined, 2, Number.NaN, Number.POSITIVE_INFINITY, 3])).toEqual([1, 2, 3]);
  });
});

describe('shouldClearMapOpenMessages', () => {
  it('returns true when the map selection is empty after normalization', () => {
    expect(shouldClearMapOpenMessages([null, undefined, Number.NaN])).toBe(true);
  });

  it('returns false when there are valid ids to fetch', () => {
    expect(shouldClearMapOpenMessages([1, null, 2])).toBe(false);
  });
});
