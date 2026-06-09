import { describe, expect, it } from 'vitest';

import { emptyQueryState } from './helpers';
import { buildFilterSectionsToLoad, filterSectionsToInvalidateForPatch } from './use-analysis-data-filter-sections';

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

  it('invalidates only option sections for a filter patch', () => {
    expect(filterSectionsToInvalidateForPatch({ unitsSelected: ['u1'] })).toEqual(
      expect.arrayContaining(['units', 'metadata', 'tags', 'aors', 'groups', 'senders', 'callsigns', 'locations', 'posts', 'networks']),
    );
  });

  it('invalidates all option sections for exact-match mode changes', () => {
    expect(filterSectionsToInvalidateForPatch({ unitsExactMatchOnly: true })).toEqual(
      expect.arrayContaining(['units', 'metadata', 'tags', 'aors', 'groups', 'senders', 'callsigns', 'locations', 'posts', 'networks']),
    );
  });

  it('invalidates loaded option sections for important filter toggles', () => {
    expect(filterSectionsToInvalidateForPatch({ orImportant: true })).toEqual(
      expect.arrayContaining(['tags', 'aors', 'groups', 'senders', 'callsigns', 'units', 'locations', 'posts', 'networks', 'metadata']),
    );
  });
});
