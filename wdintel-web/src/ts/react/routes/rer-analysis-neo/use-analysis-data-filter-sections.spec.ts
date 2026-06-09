import { describe, expect, it } from 'vitest';

import { emptyQueryState } from './helpers';
import { buildFilterSectionsToLoad, filterSectionsToInvalidateForPatch } from './use-analysis-data-filter-sections';

const ALL_OPTION_SECTIONS = ['tags', 'aors', 'groups', 'senders', 'callsigns', 'units', 'locations', 'posts', 'networks', 'metadata'] as const;

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

  it.each([
    ['tags', { tags: [1] }],
    ['unitsExactMatchOnly', { unitsExactMatchOnly: true }],
    ['metadataCc', { metadataCc: ['cc-1'] }],
    ['onlyWithMetadata', { onlyWithMetadata: true }],
    ['withoutMetadata', { withoutMetadata: true }],
    ['orWithoutCoords', { orWithoutCoords: true }],
  ] as const)('invalidates all option sections for %s changes', (_name, patch) => {
    expect(filterSectionsToInvalidateForPatch(patch)).toEqual([...ALL_OPTION_SECTIONS]);
  });

  it('keeps tag mode fields local to the tags section', () => {
    expect(filterSectionsToInvalidateForPatch({ filterTagsOption: 'AllTags' })).toEqual(['tags']);
  });

  it('keeps peleng location toggles local to the locations section', () => {
    expect(filterSectionsToInvalidateForPatch({ includePelengLocations: false })).toEqual(['locations']);
  });
});
