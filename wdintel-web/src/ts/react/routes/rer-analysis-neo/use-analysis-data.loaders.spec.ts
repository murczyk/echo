import { describe, expect, it } from 'vitest';

import { normalizeMapMessageIds } from './use-analysis-data.loaders';

describe('normalizeMapMessageIds', () => {
  it('filters nullish and duplicate ids', () => {
    expect(normalizeMapMessageIds([1, null, 2, undefined, 2, Number.NaN, Number.POSITIVE_INFINITY, 3])).toEqual([1, 2, 3]);
  });
});
