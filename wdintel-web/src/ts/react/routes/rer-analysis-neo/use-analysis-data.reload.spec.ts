import { describe, expect, it } from 'vitest';

import type { AnalysisFilterSectionId } from './types';
import { buildAnalysisReqForFilterSection } from './use-analysis-data.reload';

function buildBaseReq() {
  return {
    sinceDateInclusiveMs: 1,
    tillDateNoninclusiveMs: 2,
    selectedGroups: ['g1'],
    selectedSenders: ['s1'],
    selectedFreqs: ['f1'],
    selectedPosts: ['p1'],
    selectedCallsigns: ['c1'],
    selectedUnits: ['u1'],
    selectedLocations: ['l1'],
    selectedAors: [7],
    orWithExtendedForm: false,
    orBookmarked: false,
    orImportant: false,
    orWithCoords: false,
    orWithoutCoords: false,
    search: null,
    selectedTags: [11],
    selectedNetworks: [22],
    withoutNetwork: false,
    metadataCc: ['cc'],
    metadataSender: ['sender'],
    metadataReceiver: ['receiver'],
    metadataHash: ['hash'],
    onlyWithMetadata: false,
    withoutMetadata: false,
    includePelengLocations: true,
    unitsExactMatchOnly: null,
    filterTagsOption: 'OneOfTags' as const,
    withoutModelTags: false,
    reportTagsOnlyThisUnit: false,
  };
}

describe('buildAnalysisReqForFilterSection', () => {
  it('removes the section own selection so the option list stays multi-selectable', () => {
    const cases: Array<[AnalysisFilterSectionId, string]> = [
      ['tags', 'selectedTags'],
      ['aors', 'selectedAors'],
      ['groups', 'selectedGroups'],
      ['senders', 'selectedSenders'],
      ['callsigns', 'selectedCallsigns'],
      ['units', 'selectedUnits'],
      ['locations', 'selectedLocations'],
      ['posts', 'selectedPosts'],
      ['networks', 'selectedNetworks'],
      ['metadata', 'metadataCc'],
    ];

    for (const [section, key] of cases) {
      const req = buildAnalysisReqForFilterSection(section, buildBaseReq());
      if (section === 'metadata') {
        expect(req.metadataCc).toBeNull();
        expect(req.metadataSender).toBeNull();
        expect(req.metadataReceiver).toBeNull();
        expect(req.metadataHash).toBeNull();
        continue;
      }

      expect(req[key as keyof typeof req]).toBeNull();
    }
  });
});
