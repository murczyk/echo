import { describe, expect, it } from 'vitest';

import { emptyQueryState } from './helpers';
import { buildFilterSectionsToLoad } from './use-analysis-data-filter-sections';
import { emptyOptions, resetFilterOptionsForForcedReload } from './use-analysis-data.shared';

describe('use-analysis-data-filter-sections helpers', () => {
  it('reloads the initial sections together with already-loaded lazy sections on force reload', () => {
    expect(
      buildFilterSectionsToLoad(
        {
          ...emptyQueryState(),
          tags: ['7'],
          unitsSelected: ['Unit A'],
        },
        ['locations', 'posts'],
        true,
      ),
    ).toEqual(expect.arrayContaining(['tags', 'groups', 'senders', 'units', 'locations', 'posts']));
  });

  it('keeps only freqs and newFreqs when resetting filter options for a forced reload', () => {
    const nextOptions = resetFilterOptionsForForcedReload({
      ...emptyOptions,
      freqs: [{ value: '123.4', label: '123.4', count: 5 }],
      newFreqs: [{ value: '123.5', label: '123.5', count: 2 }],
      units: [{ value: 'Unit A', label: 'Unit A', count: 1 }],
      locations: [{ value: 'Loc A', label: 'Loc A', count: 1 }],
      posts: [{ value: 'Post A', label: 'Post A', count: 1 }],
    });

    expect(nextOptions.freqs).toEqual([{ value: '123.4', label: '123.4', count: 5 }]);
    expect(nextOptions.newFreqs).toEqual([{ value: '123.5', label: '123.5', count: 2 }]);
    expect(nextOptions.units).toEqual([]);
    expect(nextOptions.locations).toEqual([]);
    expect(nextOptions.posts).toEqual([]);
  });
});
