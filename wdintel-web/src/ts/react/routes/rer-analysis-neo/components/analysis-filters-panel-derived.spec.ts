import { describe, expect, it } from 'vitest';

import { emptyQueryState } from '../helpers';
import { buildAnalysisFiltersPanelDerivedData } from './analysis-filters-panel-derived';

describe('buildAnalysisFiltersPanelDerivedData', () => {
  it('counts only the active peleng checkbox in the important badge count', () => {
    const derived = buildAnalysisFiltersPanelDerivedData({
      aorEntries: [],
      counts: null,
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
        withoutModelTags: true,
        reportTagsOnlyThisUnit: true,
      },
      tagsMap: {},
    });

    expect(derived.importantSelectedCount).toBe(4);
    expect(derived.tagsSelectedCount).toBe(2);
  });

  it('does not count the peleng checkbox when it is off', () => {
    const derived = buildAnalysisFiltersPanelDerivedData({
      aorEntries: [],
      counts: null,
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
        orWithCoords: false,
      },
      tagsMap: {},
    });

    expect(derived.importantSelectedCount).toBe(3);
  });

  it('normalizes unknown unit stats to the canonical empty filter option', () => {
    const derived = buildAnalysisFiltersPanelDerivedData({
      aorEntries: [],
      counts: null,
      groupInfos: {},
      options: {
        tags: [],
        aors: [],
        groups: [],
        senders: [],
        freqs: [],
        newFreqs: [],
        callsigns: [],
        units: [{ value: 'Не визначено', label: 'Не визначено', count: 7 }],
        locations: [],
        posts: [],
        networks: [],
        metadataCcs: [],
        metadataSenders: [],
        metadataReceivers: [],
        metadataHashes: [],
      },
      queryState: emptyQueryState(),
      tagsMap: {},
    });

    expect(derived.unitsOptions).toEqual([
      { value: '', label: '<Не вказано>', count: 7 },
    ]);
  });
});
