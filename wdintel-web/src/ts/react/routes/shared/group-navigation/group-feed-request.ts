import type {
  InboxMessagesReq,
  RerAnalysisQueryState,
  RerDutyQueryStateWf,
} from '../../../../../Bindings';
import type { GroupScope } from './group-navigation.types';

type AnalysisAcknowledgeFilter = RerAnalysisQueryState & {
  includeOnlyNewFreqs?: boolean;
  onlyWithMedia?: boolean;
  onlyWithNetwork?: boolean;
  deviceNamesSelected?: string[];
};

function hasValues(value: readonly unknown[] | null | undefined): boolean {
  return (value?.length ?? 0) > 0;
}

export function applyGroupScopeToInboxRequest(
  request: InboxMessagesReq,
  scope: GroupScope,
): InboxMessagesReq {
  if (scope.kind === 'all') return request;
  return {
    ...request,
    selectedGroups: [scope.masterKey],
    deniedGroups: null,
  };
}

export function isDutyGroupViewAcknowledgeable(filter: RerDutyQueryStateWf): boolean {
  return (
    ![
      filter.sendersSelected,
      filter.deniedSenders,
      filter.freqsSelected,
      filter.freqsDenied,
      filter.postsSelected,
      filter.postsDenied,
      filter.unitsSelected,
      filter.unitsDenied,
      filter.selectedUnitIds,
      filter.deniedUnitIds,
      filter.selectedDeviceNames,
      filter.deniedDeviceNames,
    ].some(hasValues) &&
    filter.highlightKeywordsEnabled !== true &&
    filter.highlightKeywordSetId == null
  );
}

export function isAnalysisGroupViewAcknowledgeable(filter: AnalysisAcknowledgeFilter): boolean {
  const restrictedLists = [
    filter.aorsSelected,
    filter.sendersSelected,
    filter.freqsSelected,
    filter.callsignsSelected,
    filter.unitsSelected,
    filter.locationsSelected,
    filter.postsSelected,
    filter.networksSelected,
    filter.metadataCc,
    filter.metadataSender,
    filter.metadataReceiver,
    filter.metadataHash,
    filter.tags,
    filter.deviceNamesSelected,
  ];
  return (
    !restrictedLists.some(hasValues) &&
    filter.search.trim() === '' &&
    !filter.withoutNetwork &&
    !filter.orWithExtendedForm &&
    !filter.orBookmarked &&
    !filter.orImportant &&
    !filter.orWithCoords &&
    !filter.orWithoutCoords &&
    !filter.onlyWithMetadata &&
    !filter.withoutMetadata &&
    !filter.withoutModelTags &&
    filter.includeOnlyNewFreqs !== true &&
    filter.onlyWithMedia !== true &&
    filter.onlyWithNetwork !== true
  );
}
