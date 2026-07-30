import { describe, expect, it } from 'vitest';

import {
  addAnalysisSelection,
  toggleExclusiveAnalysisSelection,
} from './analysis-filter-selection';

describe('analysis filter selection', () => {
  it('selects an unselected value exclusively', () => {
    expect(toggleExclusiveAnalysisSelection(['one'], 'two')).toEqual(['two']);
  });

  it('removes only the clicked selected value', () => {
    expect(toggleExclusiveAnalysisSelection(['one', 'two'], 'one')).toEqual(['two']);
  });

  it('adds a value without duplicating an existing selection', () => {
    expect(addAnalysisSelection(['one'], 'two')).toEqual(['one', 'two']);
    expect(addAnalysisSelection(['one'], 'one')).toEqual(['one']);
  });
});
