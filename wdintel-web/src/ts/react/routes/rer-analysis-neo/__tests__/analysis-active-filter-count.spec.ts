import { describe, expect, it } from 'vitest';

import { getAnalysisActiveFilterCount } from '../analysis-active-filter-count';
import type { AnalysisQueryState } from '../types';

describe('getAnalysisActiveFilterCount', () => {
  it('does not count values hidden by the current group scope or user permissions', () => {
    expect(
      getAnalysisActiveFilterCount(
        {
          groupsSelected: ['group-1'],
          includePelengLocations: false,
          search: 'message query',
        } as AnalysisQueryState,
        {
          hideGroupSelection: true,
          radioFeaturesAllowed: false,
        },
      ),
    ).toBe(0);
  });

  it('counts visible active filters', () => {
    expect(
      getAnalysisActiveFilterCount(
        {
          groupsSelected: ['group-1'],
          includePelengLocations: false,
          onlyWithMedia: true,
          search: 'message query',
        } as AnalysisQueryState,
        {
          hideGroupSelection: false,
          radioFeaturesAllowed: true,
        },
      ),
    ).toBe(3);
  });
});
