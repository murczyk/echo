import { describe, expect, it } from 'vitest';

import { addUnitSelection, toggleExclusiveUnitSelection } from './analysis-unit-filter';

describe('analysis unit selection', () => {
  it('replaces another selected unit on a regular click', () => {
    expect(toggleExclusiveUnitSelection(['Unit A'], 'Unit B')).toEqual(['Unit B']);
  });

  it('removes a selected unit on a regular click', () => {
    expect(toggleExclusiveUnitSelection(['Unit A', 'Unit B'], 'Unit A')).toEqual(['Unit B']);
  });

  it('adds another unit without clearing the current selection', () => {
    expect(addUnitSelection(['Unit A'], 'Unit B')).toEqual(['Unit A', 'Unit B']);
  });
});
