import { describe, expect, it } from 'vitest';

import { emptyQueryState } from './helpers';
import { buildFilterSectionsToLoad, resetFilterOptionsForForcedReload } from './use-analysis-data-filter-sections';
import { emptyOptions } from './use-analysis-data.shared';

describe('buildFilterSectionsToLoad', () => {
  it('keeps the initial default sections for a normal load', () => {
    expect(buildFilterSectionsToLoad(emptyQueryState(), [], false)).toEqual(['tags', 'groups', 'senders']);
  });

  it('reloads previously loaded lazy sections on a forced reload', () => {
    const sections = buildFilterSectionsToLoad(
      {
        ...emptyQueryState(),
        unitsSelected: ['u1'],
      },
      ['units', 'locations', 'posts'],
      true,
    );

    expect(sections).toEqual(expect.arrayContaining(['tags', 'groups', 'senders', 'units', 'locations', 'posts']));
  });

  it('preserves only frequency options when resetting for a forced reload', () => {
    const nextOptions = resetFilterOptionsForForcedReload({
      ...emptyOptions,
      freqs: [{ value: '150.100', label: '150.100', count: 12 }],
      newFreqs: [{ value: '150.200', label: '150.200', count: 3 }],
      units: [{ value: 'u1', label: 'Unit 1', count: 1 }],
      locations: [{ value: 'l1', label: 'Location 1', count: 2 }],
      posts: [{ value: 'p1', label: 'Post 1', count: 4 }],
    });

    expect(nextOptions.freqs).toEqual([{ value: '150.100', label: '150.100', count: 12 }]);
    expect(nextOptions.newFreqs).toEqual([{ value: '150.200', label: '150.200', count: 3 }]);
    expect(nextOptions.units).toEqual([]);
    expect(nextOptions.locations).toEqual([]);
    expect(nextOptions.posts).toEqual([]);
  });
});
