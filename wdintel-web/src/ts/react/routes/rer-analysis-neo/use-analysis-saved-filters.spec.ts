import { describe, expect, it } from 'vitest';

import type { AnalysisStatsReq, SavedFilter } from '../../../../Bindings';
import { emptyQueryState } from './helpers';
import { refreshAppliedSavedFilterSnapshot } from './use-analysis-saved-filters';

describe('refreshAppliedSavedFilterSnapshot', () => {
  it('keeps the original base query state while refreshing the saved request', () => {
    const baseQueryState = {
      ...emptyQueryState(),
      search: 'before',
    };
    const currentQueryState = {
      ...emptyQueryState(),
      search: 'after',
    };
    const savedFilter = {
      id: 1,
      name: 'Saved filter',
      req: { marker: 'old' },
    } as unknown as SavedFilter;

    const next = refreshAppliedSavedFilterSnapshot(
      { baseQueryState, savedFilter },
      currentQueryState,
      savedFilter,
      { marker: 'new' } as AnalysisStatsReq,
    );

    expect(next.baseQueryState).toBe(baseQueryState);
    expect(next.savedFilter.req).toEqual({ marker: 'new' });
  });

  it('uses the current query state as the base when there is no existing snapshot', () => {
    const currentQueryState = {
      ...emptyQueryState(),
      search: 'current',
    };
    const savedFilter = {
      id: 1,
      name: 'Saved filter',
      req: { marker: 'old' },
    } as unknown as SavedFilter;

    const next = refreshAppliedSavedFilterSnapshot(null, currentQueryState, savedFilter, { marker: 'new' } as AnalysisStatsReq);

    expect(next.baseQueryState).toBe(currentQueryState);
    expect(next.savedFilter.req).toEqual({ marker: 'new' });
  });
});
