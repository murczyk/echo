import type { InboxMessage, InboxWindowRsp } from '../../../../Bindings';
import { useAnalysisReferenceState } from './use-analysis-reference-state';
import { useAnalysisMessageList } from './use-analysis-message-list';
import { useAnalysisMapData } from './use-analysis-map-data';
import { useAnalysisSidebarData } from './use-analysis-sidebar-data';
import type { AnalysisQueryState, AnalysisFilterSectionId, AnalysisReloadOptions } from './types';
import type { FilterSectionLoadPlan } from './use-analysis-data-filter-sections';
import { emptyNewCallsigns, emptyOptions } from './use-analysis-data.shared';
import type { UseAnalysisDataProps } from './use-analysis-data.types';

type FetchAnalysisNetworks = typeof import('../../services/api/analysis').fetchAnalysisNetworks;

type ReferenceState = ReturnType<typeof useAnalysisReferenceState>;
type MessageList = ReturnType<typeof useAnalysisMessageList>;
type MapData = ReturnType<typeof useAnalysisMapData>;
type SidebarData = ReturnType<typeof useAnalysisSidebarData>;

type Setter<T> = React.Dispatch<React.SetStateAction<T>>;

type BuildActionParamsInput = {
  authUserName: string | null;
  currentUser: UseAnalysisDataProps['currentUser'];
  optionsFreqValues: string[];
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  queryState: AnalysisQueryState;
  completeLocalInboxChangeOrigin: (origin: string) => void;
  failLocalInboxChangeOrigin: (origin: string) => boolean;
  reconcileTagMutation: (messageId: number) => Promise<void>;
  registerLocalInboxChangeOrigin: () => string;
  refreshTagFacet: () => Promise<void>;
  reloadRef: React.MutableRefObject<(options?: AnalysisReloadOptions) => Promise<void>>;
  referenceState: ReferenceState;
  messageList: MessageList;
  mapData: MapData;
  sidebarData: SidebarData;
};

export function buildAnalysisActionsParams({
  authUserName,
  currentUser,
  optionsFreqValues,
  onError,
  onUnauthorized,
  queryState,
  completeLocalInboxChangeOrigin,
  failLocalInboxChangeOrigin,
  reconcileTagMutation,
  registerLocalInboxChangeOrigin,
  refreshTagFacet,
  reloadRef,
  referenceState,
  messageList,
  mapData,
  sidebarData,
}: BuildActionParamsInput) {
  return {
    authUserName,
    currentUser,
    messages: messageList.messages,
    mapOpenMessages: mapData.mapOpenMessages,
    optionsFreqValues,
    onError,
    onUnauthorized,
    queryState,
    completeLocalInboxChangeOrigin,
    failLocalInboxChangeOrigin,
    reconcileTagMutation,
    registerLocalInboxChangeOrigin,
    refreshTagFacet,
    reload: (options?: AnalysisReloadOptions) => reloadRef.current(options),
    setMapOpenMessages: mapData.setMapOpenMessages,
    setMessages: messageList.setMessages,
    setSummaryRows: sidebarData.setSummaryRows,
    emptyNewCallsigns,
    emptyOptions,
    invalidateCallsignGraph: sidebarData.invalidateCallsignGraph,
    optionsFreqsRef: referenceState.optionsFreqsRef,
    setAorEntries: messageList.setAorEntries,
    setCounts: messageList.setCounts,
    setCorrelatedFreqs: sidebarData.setCorrelatedFreqs,
    setGroupInfos: referenceState.setGroupInfos,
    setGroupsActivity: sidebarData.setGroupsActivity,
    setGroupsActivityLoadedFreq: sidebarData.setGroupsActivityLoadedFreq,
    setGroupsActivityLoadedPeriod: sidebarData.setGroupsActivityLoadedPeriod,
    setMapDateRange: mapData.setMapDateRange,
    setMapNetworkUnits: mapData.setMapNetworkUnits,
    setMapPoints: mapData.setMapPoints,
    setMessageComments: messageList.setMessageComments,
    setNetworkDisplayMap: referenceState.setNetworkDisplayMap,
    setNetworks: referenceState.setNetworks,
    setNewCallsigns: sidebarData.setNewCallsigns,
    setNoMoreToLoad: messageList.setNoMoreToLoad,
    setNolimitShown: messageList.setNolimitShown,
    setOptions: referenceState.setOptions,
    setProfiles: referenceState.setProfiles,
    setSummaryCallsignsInfo: referenceState.setSummaryCallsignsInfo,
    setSummaryHasLoadedOnce: sidebarData.setSummaryHasLoadedOnce,
    setSummaryLoaded: sidebarData.setSummaryLoaded,
    setSummaryLoading: sidebarData.setSummaryLoading,
    setTagsMap: referenceState.setTagsMap,
    setTagsOrder: referenceState.setTagsOrder,
    setTopCallsigns: sidebarData.setTopCallsigns,
    setTopFreqs: sidebarData.setTopFreqs,
    setTopLocations: sidebarData.setTopLocations,
    setRightSidebarLoading: sidebarData.setRightSidebarLoading,
    setTopUnits: sidebarData.setTopUnits,
    setUnitsMap: referenceState.setUnitsMap,
    setHasLoadedInitialMessages: messageList.setHasLoadedInitialMessages,
    messageCommentsLoadVersionRef: messageList.messageCommentsLoadVersionRef,
  };
}

type BuildReloadParamsInput = {
  centerTab: UseAnalysisDataProps['centerTab'];
  deferInitialLoad: boolean;
  focusedWindow: InboxWindowRsp | null;
  focusedMessageActive: boolean;
  leftPanelOpen: boolean;
  newestFirst: boolean;
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  queryState: AnalysisQueryState;
  rightSidebarTab: UseAnalysisDataProps['rightSidebarTab'];
  rightSidebarVisible: boolean;
  reloadTriggerKey: string;
  shouldLoadNewCallsigns: boolean;
  optionsFreqValuesRef: React.MutableRefObject<string[]>;
  getLoadedFilterSections: () => AnalysisFilterSectionId[];
  getReloadFilterSections: () => AnalysisFilterSectionId[] | null;
  invalidateFilterSectionLoads: () => void;
  invalidateFilterSectionLoadsForPatch: (
    patch?: Partial<import('./types').AnalysisQueryState>,
  ) => void;
  loadInitialFilterSections: (
    analysisReq: NonNullable<ReturnType<typeof import('./helpers').buildAnalysisReq>>,
    plan: FilterSectionLoadPlan | { mode: 'initial'; selectedSections: AnalysisFilterSectionId[] },
    networkStatsCache?: Map<string, ReturnType<FetchAnalysisNetworks>>,
    signal?: AbortSignal,
  ) => Promise<void>;
  invalidateCallsignGraph: (options?: { clearGraph?: boolean }) => void;
  invalidateCorrelatedFreqsCache: () => void;
  invalidateRightSidebarData: () => void;
  invalidateSummaryData: (keepLoading?: boolean) => void;
  loadMapPalitras: () => Promise<void>;
  loadSummaryData: () => Promise<void>;
  loadTopSidebarData: () => Promise<void>;
  clearAnalysisResults: () => void;
  loadMessageComments: (
    messages: Array<[number, InboxMessage]>,
    forceReload?: boolean,
  ) => Promise<void>;
  invalidateMessagePaging: () => void;
  invalidateMessagePageRequests: () => void;
  getCurrentMessagePageCursor: MessageList['getCurrentMessagePageCursor'];
  refreshMessageCounts: MessageList['refreshMessageCounts'];
  setAorEntries: MessageList['setAorEntries'];
  setCounts: MessageList['setCounts'];
  setCountsLoading: Setter<boolean>;
  setFiltersLoading: Setter<boolean>;
  setGroupInfos: ReferenceState['setGroupInfos'];
  setMapLoading: MapData['setMapLoading'];
  setMapDateRange: MapData['setMapDateRange'];
  setMapNetworkUnits: MapData['setMapNetworkUnits'];
  applyMapSettlements: MapData['applyMapSettlements'];
  setMapOpenMessages: MapData['setMapOpenMessages'];
  setMapPoints: MapData['setMapPoints'];
  showSettlements: MapData['showSettlements'];
  setMessages: MessageList['setMessages'];
  setMessagesLoading: MessageList['setMessagesLoading'];
  setNetworks: ReferenceState['setNetworks'];
  setNewCallsigns: SidebarData['setNewCallsigns'];
  setNewCallsignsLoading: SidebarData['setNewCallsignsLoading'];
  setNewCallsignsLoadedKey: SidebarData['setNewCallsignsLoadedKey'];
  newCallsignsRequestRef: SidebarData['newCallsignsRequestRef'];
  newCallsignsLoadedKeyRef: SidebarData['newCallsignsLoadedKeyRef'];
  newCallsignsPendingKeyRef: SidebarData['newCallsignsPendingKeyRef'];
  setNoMoreToLoad: MessageList['setNoMoreToLoad'];
  setNolimitShown: MessageList['setNolimitShown'];
  setOptions: ReferenceState['setOptions'];
  setProfiles: ReferenceState['setProfiles'];
  setSummaryCallsignsInfo: ReferenceState['setSummaryCallsignsInfo'];
  setTagsMap: ReferenceState['setTagsMap'];
  setTagsOrder: ReferenceState['setTagsOrder'];
  setTopCallsigns: SidebarData['setTopCallsigns'];
  setTopFreqs: SidebarData['setTopFreqs'];
  setTopLocations: SidebarData['setTopLocations'];
  setTopUnits: SidebarData['setTopUnits'];
  setUnitsMap: ReferenceState['setUnitsMap'];
  setHasLoadedInitialMessages: MessageList['setHasLoadedInitialMessages'];
};

export function buildReloadOrchestratorParams(input: BuildReloadParamsInput) {
  return {
    centerTab: input.centerTab,
    deferInitialLoad: input.deferInitialLoad,
    focusedWindow: input.focusedWindow,
    focusedMessageActive: input.focusedMessageActive,
    leftPanelOpen: input.leftPanelOpen,
    newestFirst: input.newestFirst,
    onError: input.onError,
    onUnauthorized: input.onUnauthorized,
    queryState: input.queryState,
    rightSidebarTab: input.rightSidebarTab,
    rightSidebarVisible: input.rightSidebarVisible,
    reloadTriggerKey: input.reloadTriggerKey,
    shouldLoadNewCallsigns: input.shouldLoadNewCallsigns,
    optionsFreqValuesRef: input.optionsFreqValuesRef,
    getLoadedFilterSections: input.getLoadedFilterSections,
    getReloadFilterSections: input.getReloadFilterSections,
    invalidateFilterSectionLoads: input.invalidateFilterSectionLoads,
    invalidateFilterSectionLoadsForPatch: input.invalidateFilterSectionLoadsForPatch,
    loadInitialFilterSections: input.loadInitialFilterSections,
    invalidateCallsignGraph: input.invalidateCallsignGraph,
    invalidateCorrelatedFreqsCache: input.invalidateCorrelatedFreqsCache,
    invalidateRightSidebarData: input.invalidateRightSidebarData,
    invalidateSummaryData: input.invalidateSummaryData,
    loadMapPalitras: input.loadMapPalitras,
    loadSummaryData: input.loadSummaryData,
    loadTopSidebarData: input.loadTopSidebarData,
    clearAnalysisResults: input.clearAnalysisResults,
    loadMessageComments: input.loadMessageComments,
    invalidateMessagePaging: input.invalidateMessagePaging,
    invalidateMessagePageRequests: input.invalidateMessagePageRequests,
    getCurrentMessagePageCursor: input.getCurrentMessagePageCursor,
    refreshMessageCounts: input.refreshMessageCounts,
    setAorEntries: input.setAorEntries,
    setCounts: input.setCounts,
    setCountsLoading: input.setCountsLoading,
    setFiltersLoading: input.setFiltersLoading,
    setGroupInfos: input.setGroupInfos,
    setMapLoading: input.setMapLoading,
    setMapDateRange: input.setMapDateRange,
    setMapNetworkUnits: input.setMapNetworkUnits,
    applyMapSettlements: input.applyMapSettlements,
    setMapOpenMessages: input.setMapOpenMessages,
    setMapPoints: input.setMapPoints,
    showSettlements: input.showSettlements,
    setMessages: input.setMessages,
    setMessagesLoading: input.setMessagesLoading,
    setNetworks: input.setNetworks,
    setNewCallsigns: input.setNewCallsigns,
    setNewCallsignsLoading: input.setNewCallsignsLoading,
    setNewCallsignsLoadedKey: input.setNewCallsignsLoadedKey,
    newCallsignsRequestRef: input.newCallsignsRequestRef,
    newCallsignsLoadedKeyRef: input.newCallsignsLoadedKeyRef,
    newCallsignsPendingKeyRef: input.newCallsignsPendingKeyRef,
    setNoMoreToLoad: input.setNoMoreToLoad,
    setNolimitShown: input.setNolimitShown,
    setOptions: input.setOptions,
    setProfiles: input.setProfiles,
    setSummaryCallsignsInfo: input.setSummaryCallsignsInfo,
    setTagsMap: input.setTagsMap,
    setTagsOrder: input.setTagsOrder,
    setTopCallsigns: input.setTopCallsigns,
    setTopFreqs: input.setTopFreqs,
    setTopLocations: input.setTopLocations,
    setTopUnits: input.setTopUnits,
    setUnitsMap: input.setUnitsMap,
    setHasLoadedInitialMessages: input.setHasLoadedInitialMessages,
  };
}
