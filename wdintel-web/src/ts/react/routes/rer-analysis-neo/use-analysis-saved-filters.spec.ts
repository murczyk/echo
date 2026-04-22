import { describe, expect, it } from 'vitest';

import { emptyQueryState, queryStateFromSavedFilter } from './helpers';

describe('use-analysis-saved-filters support', () => {
  it('applies a saved filter as a full replacement of the relevant query state', () => {
    const currentQueryState = {
      ...emptyQueryState(),
      groupsSelected: ['A'],
      freqsSelected: ['130.3500'],
    };
    const savedFilter = {
      id: 1,
      name: 'Saved filter',
      req: {
        selectedGroups: ['B'],
        selectedFreqs: ['145.5000'],
      },
    } as never;

    const next = queryStateFromSavedFilter(savedFilter, currentQueryState);

    expect(next.groupsSelected).toEqual(['B']);
    expect(next.freqsSelected).toEqual(['145.5000']);
  });
});
