import { describe, expect, it } from 'vitest';

import type { SignalGroupEntry, Unit } from '../../../../../Bindings';
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
        onlyWithMedia: true,
        orBookmarked: true,
        orImportant: true,
        orWithCoords: true,
        withoutModelTags: true,
        reportTagsOnlyThisUnit: true,
      },
      tagsMap: {},
    });

    expect(derived.importantSelectedCount).toBe(5);
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

    expect(derived.unitsOptions).toEqual([{ value: '', label: '<Не вказано>', count: 7 }]);
  });

  it('groups unit aliases under canonical catalog labels while retaining raw values', () => {
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
        units: [
          { value: '58 а', label: '58 а', count: 2 },
          { value: '58 ЗА', label: '58 ЗА', count: 3 },
          { value: '58 зва', label: '58 зва', count: 5 },
          { value: '136 ОМСБР', label: '136 ОМСБР', count: 7 },
          { value: '136 омсбр', label: '136 омсбр', count: 11 },
        ],
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
      unitsMap: {
        1: { id: 1, name: '58 А' } as Unit,
        2: { id: 2, name: '136 омсбр' } as Unit,
      },
    });

    expect(derived.unitsOptions).toEqual([
      {
        value: '58 А',
        label: '58 А',
        count: 10,
        values: ['58 а', '58 ЗА', '58 зва'],
      },
      {
        value: '136 омсбр',
        label: '136 омсбр',
        count: 18,
        values: ['136 ОМСБР', '136 омсбр'],
      },
    ]);
  });

  it('keeps uppercase callsign labels backed by lowercase filter values', () => {
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
        callsigns: [
          { value: 'НУГУШ', label: 'НУГУШ', count: 2 },
          { value: 'нугуш', label: 'нугуш', count: 3 },
        ],
        units: [],
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

    expect(derived.callsignsOptions).toEqual([
      { value: 'нугуш', label: 'НУГУШ', count: 5, values: ['нугуш'] },
    ]);
  });

  it('merges duplicate group labels into one option with combined values and count', () => {
    const groupInfo = (masterKey: string, name: string): SignalGroupEntry => ({
      masterKey,
      name,
      ignoreOperativny: false,
      interseptionKind: 'rer',
      disableNetworkAssignment: false,
      groupStats: { activityLastDay: 0, activityLastWeek: 0 },
      adminData: null,
      areasOfResponsibility: null,
    });

    const derived = buildAnalysisFiltersPanelDerivedData({
      aorEntries: [],
      counts: null,
      groupInfos: {
        'group-a': groupInfo('group-a', 'Грак Пл'),
        'group-b': groupInfo('group-b', 'Грак Пл'),
      },
      options: {
        tags: [],
        aors: [],
        groups: [
          { value: 'group-a', label: 'group-a', count: 2 },
          { value: 'group-b', label: 'group-b', count: 3 },
        ],
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
      queryState: emptyQueryState(),
      tagsMap: {},
    });

    expect(derived.groupOptions).toEqual([
      { value: 'group-a', label: 'Грак Пл', count: 5, values: ['group-a', 'group-b'] },
    ]);
  });

  it('counts merged group selections once regardless of the selected master key', () => {
    const groupInfo = (masterKey: string, name: string): SignalGroupEntry => ({
      masterKey,
      name,
      ignoreOperativny: false,
      interseptionKind: 'rer',
      disableNetworkAssignment: false,
      groupStats: { activityLastDay: 0, activityLastWeek: 0 },
      adminData: null,
      areasOfResponsibility: null,
    });

    const commonInput = {
      aorEntries: [],
      counts: null,
      groupInfos: {
        'group-a': groupInfo('group-a', 'Грак Пл'),
        'group-b': groupInfo('group-b', 'Грак Пл'),
      },
      options: {
        tags: [],
        aors: [],
        groups: [
          { value: 'group-a', label: 'group-a', count: 2 },
          { value: 'group-b', label: 'group-b', count: 3 },
        ],
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
      tagsMap: {},
    } as const;

    expect(
      buildAnalysisFiltersPanelDerivedData({
        ...commonInput,
        queryState: { ...emptyQueryState(), groupsSelected: ['group-a', 'group-b'] },
      }).groupsSelectedCount,
    ).toBe(1);

    expect(
      buildAnalysisFiltersPanelDerivedData({
        ...commonInput,
        queryState: { ...emptyQueryState(), groupsSelected: ['group-b'] },
      }).groupsSelectedCount,
    ).toBe(1);
  });

  it('keeps a selected tag as an option even when the backend facet drops it', () => {
    const derived = buildAnalysisFiltersPanelDerivedData({
      aorEntries: [],
      counts: null,
      groupInfos: {},
      options: {
        tags: [{ value: '5', label: '5', count: 3 }],
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
      queryState: { ...emptyQueryState(), tags: [9], tagsExcludeMode: true },
      tagsMap: {
        5: { id: 5, label: 'Зв’язок' } as never,
        9: { id: 9, label: 'Оброблено' } as never,
      },
    });

    expect(derived.tagOptions).toEqual([
      { value: '5', label: 'Зв’язок', count: 3 },
      { value: '9', label: 'Оброблено', count: 0 },
    ]);
  });

  it('lists every backend tag with the current organism user tags first and facet counts merged', () => {
    const derived = buildAnalysisFiltersPanelDerivedData({
      aorEntries: [],
      counts: null,
      groupInfos: {},
      options: {
        // Facet only carries counts for the tags on the visible messages.
        tags: [
          { value: '2', label: '2', count: 4 },
          { value: '7', label: '7', count: 9 },
        ],
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
      queryState: emptyQueryState(),
      // Backend order: global 7, user 2, user 5, global 3.
      tagsOrder: [7, 2, 5, 3],
      tagsMap: {
        2: { id: 2, label: 'Оброблено', ownerOrganismId: 1 } as never,
        3: { id: 3, label: 'Глобальний', ownerOrganismId: null } as never,
        5: { id: 5, label: 'Мій тег', ownerOrganismId: 1 } as never,
        7: { id: 7, label: 'Зв’язок', ownerOrganismId: null } as never,
      },
    });

    // User/organism tags (ownerOrganismId != null) come first in backend order,
    // then every other tag. All tags appear; facet counts fill in, 0 otherwise.
    expect(derived.tagOptions).toEqual([
      { value: '2', label: 'Оброблено', count: 4 },
      { value: '5', label: 'Мій тег', count: 0 },
      { value: '7', label: 'Зв’язок', count: 9 },
      { value: '3', label: 'Глобальний', count: 0 },
    ]);
  });

  it('keeps the selected count when a selected group key is missing from the current options', () => {
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
      queryState: { ...emptyQueryState(), groupsSelected: ['group-a'] },
      tagsMap: {},
    });

    expect(derived.groupsSelectedCount).toBe(1);
  });
});
