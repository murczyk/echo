import { describe, expect, it } from 'vitest';

import { emptyQueryState } from '../helpers';
import { buildAnalysisFiltersPanelDerivedData } from './analysis-filters-panel-derived';

describe('buildAnalysisFiltersPanelDerivedData', () => {
  it('keeps tag-only toggles and legacy peleng dual state out of the important badge count', () => {
    const derived = buildAnalysisFiltersPanelDerivedData({
      aorEntries: [],
      groupInfos: {},
      options: {
        tags: [],
        aors: [],
        groups: [],
        senders: [],
        freqs: [],
        newFreqs: [],
        callsigns: [],
        units: [],
        locations: [],
        posts: [],
        networks: [],
        metadataCcs: [],
        metadataSenders: [],
        metadataReceivers: [],
        metadataHashes: [],
      },
      queryState: {
        ...emptyQueryState(),
        orWithExtendedForm: true,
        orBookmarked: true,
        orImportant: true,
        orWithCoords: true,
        orWithoutCoords: true,
        withoutModelTags: true,
        reportTagsOnlyThisUnit: true,
      },
      tagsMap: {},
    });

    expect(derived.importantSelectedCount).toBe(3);
    expect(derived.tagsSelectedCount).toBe(2);
  });
});
