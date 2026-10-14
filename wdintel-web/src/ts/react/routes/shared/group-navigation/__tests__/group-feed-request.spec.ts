import { describe, expect, it } from 'vitest';
import type {
  InboxMessagesReq,
  RerAnalysisQueryState,
  RerDutyQueryStateWf,
} from '../../../../../../Bindings';

import {
  applyGroupScopeToInboxRequest,
  isAnalysisGroupViewAcknowledgeable,
  isDutyGroupViewAcknowledgeable,
} from '../group-feed-request';

const emptyDutyFilter: RerDutyQueryStateWf = {
  groupsSelected: null,
  groupsDenied: null,
  sendersSelected: null,
  deniedSenders: null,
  freqsSelected: null,
  freqsDenied: null,
  postsSelected: null,
  postsDenied: null,
  unitsSelected: null,
  unitsDenied: null,
  selectedUnitIds: null,
  deniedUnitIds: null,
  selectedDeviceNames: null,
  deniedDeviceNames: null,
  unitsExactMatchOnly: false,
  lastViewedMessageId: null,
  highlightKeywordsEnabled: false,
  highlightKeywordSetId: null,
};

const defaultAnalysisQuery: RerAnalysisQueryState & {
  includeOnlyNewFreqs: boolean;
  onlyWithMedia: boolean;
  onlyWithNetwork: boolean;
  deviceNamesSelected: string[];
} = {
  dateFromStr: '2026-10-14',
  timeFromStr: '00:00',
  dateToStr: '2026-10-14',
  timeToStr: '23:59',
  aorsSelected: [],
  groupsSelected: [],
  sendersSelected: [],
  freqsSelected: [],
  callsignsSelected: [],
  unitsSelected: [],
  locationsSelected: [],
  postsSelected: [],
  networksSelected: [],
  withoutNetwork: false,
  orWithExtendedForm: false,
  orBookmarked: false,
  orImportant: false,
  orWithCoords: false,
  orWithoutCoords: false,
  search: '',
  metadataCc: [],
  metadataSender: [],
  metadataReceiver: [],
  metadataHash: [],
  onlyWithMetadata: false,
  withoutMetadata: false,
  tags: [],
  includePelengLocations: false,
  unitsExactMatchOnly: false,
  adjacentFreqsRange: 0,
  withoutModelTags: false,
  filterTagsOption: null,
  reportTagsOnlyThisUnit: false,
  includeOnlyNewFreqs: false,
  onlyWithMedia: false,
  onlyWithNetwork: false,
  deviceNamesSelected: [],
};

describe('group feed requests', () => {
  it('keeps an all-groups request unchanged', () => {
    const request = { selectedGroups: ['g-1'], deniedGroups: ['g-2'] } as InboxMessagesReq;

    expect(applyGroupScopeToInboxRequest(request, { kind: 'all' })).toBe(request);
  });

  it('overrides only the group fields for a dedicated group', () => {
    const request = {
      selectedGroups: ['g-1'],
      deniedGroups: ['g-2'],
      selectedSenders: ['sender'],
      search: 'query',
    } as InboxMessagesReq;

    expect(applyGroupScopeToInboxRequest(request, { kind: 'group', masterKey: 'g-3' })).toEqual({
      ...request,
      selectedGroups: ['g-3'],
      deniedGroups: null,
    });
  });

  it('recognizes every Duty content filter as acknowledgement-unsafe', () => {
    expect(isDutyGroupViewAcknowledgeable(emptyDutyFilter)).toBe(true);

    const restrictedFields: Array<keyof RerDutyQueryStateWf> = [
      'sendersSelected',
      'deniedSenders',
      'freqsSelected',
      'freqsDenied',
      'postsSelected',
      'postsDenied',
      'unitsSelected',
      'unitsDenied',
      'selectedUnitIds',
      'deniedUnitIds',
      'selectedDeviceNames',
      'deniedDeviceNames',
    ];
    restrictedFields.forEach((field) => {
      expect(
        isDutyGroupViewAcknowledgeable({ ...emptyDutyFilter, [field]: ['selected'] }),
        field,
      ).toBe(false);
    });
    expect(
      isDutyGroupViewAcknowledgeable({
        ...emptyDutyFilter,
        highlightKeywordsEnabled: true,
        highlightKeywordSetId: 7,
      }),
    ).toBe(false);
  });

  it('recognizes Analysis content filters as acknowledgement-unsafe', () => {
    expect(isAnalysisGroupViewAcknowledgeable(defaultAnalysisQuery)).toBe(true);
    expect(isAnalysisGroupViewAcknowledgeable({ ...defaultAnalysisQuery, search: 'ворог' })).toBe(
      false,
    );
    expect(
      isAnalysisGroupViewAcknowledgeable({ ...defaultAnalysisQuery, onlyWithMedia: true }),
    ).toBe(false);
    expect(isAnalysisGroupViewAcknowledgeable({ ...defaultAnalysisQuery, tags: [7] })).toBe(false);
  });
});
