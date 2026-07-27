import { useAnalysisDataMessageActions } from './use-analysis-data.message-actions';
import { useAnalysisDataStateUtils } from './use-analysis-data.state-utils';
import { emptyNewCallsigns, emptyOptions, toErrorMessage } from './use-analysis-data.shared';
import type { AnalysisQueryState, AnalysisCountItem } from './types';
import type {
  InboxMessage,
  SummaryTableFreqRow,
  NewCallsignsRes,
  CallsignInfoRes,
  SignalGroupEntry,
  SignalProfileEntry,
  Tag,
  Unit,
} from '../../../../Bindings';

type Setter<T> = React.Dispatch<React.SetStateAction<T>>;

type Params = {
  authUserName: string | null;
  currentUser: import('../../../../Bindings').User | null;
  messages: Array<[number, InboxMessage]>;
  mapOpenMessages: Array<[number, InboxMessage]>;
  optionsFreqValues: string[];
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  queryState: AnalysisQueryState;
  completeLocalInboxChangeOrigin: (origin: string) => void;
  failLocalInboxChangeOrigin: (origin: string) => boolean;
  reconcileTagMutation: (messageId: number) => Promise<void>;
  registerLocalInboxChangeOrigin: () => string;
  refreshTagFacet: () => Promise<void>;
  reload: () => Promise<void>;
  setMapOpenMessages: Setter<Array<[number, InboxMessage]>>;
  setMessages: Setter<Array<[number, InboxMessage]>>;
  setSummaryRows: Setter<SummaryTableFreqRow[]>;
  emptyNewCallsigns: NewCallsignsRes;
  emptyOptions: import('./types').AnalysisFilterOptions;
  invalidateCallsignGraph: () => void;
  optionsFreqsRef: React.MutableRefObject<string[]>;
  setAorEntries: Setter<import('./types').AnalysisAorEntry[]>;
  setCounts: Setter<import('../../../../Bindings').CountStatsRsp | null>;
  setCorrelatedFreqs: Setter<import('../../../../Bindings').CorrelatedFreq[]>;
  setGroupInfos: Setter<Record<string, SignalGroupEntry>>;
  setGroupsActivity: Setter<import('../../../../Bindings').FreqDailyActivityCount | null>;
  setGroupsActivityLoadedFreq: Setter<string | null>;
  setGroupsActivityLoadedPeriod: Setter<import('./types').AnalysisGroupsActivityPeriod | null>;
  setMapDateRange: Setter<{ startDate: number; endDate: number }>;
  setMapNetworkUnits: Setter<import('../../../../Bindings').NetworkUnit[]>;
  setMapPoints: Setter<import('../../../../Bindings').FreqDetailedPoint[]>;
  setMessageComments: Setter<Record<number, import('../../../../Bindings').MessageComment[]>>;
  setNetworkDisplayMap: Setter<Record<number, string>>;
  setNetworks: Setter<import('../../../../Bindings').Network[]>;
  setNewCallsigns: Setter<NewCallsignsRes>;
  setNoMoreToLoad: Setter<boolean>;
  setNolimitShown: Setter<boolean>;
  setOptions: Setter<import('./types').AnalysisFilterOptions>;
  setProfiles: Setter<Record<string, SignalProfileEntry | null>>;
  setSummaryCallsignsInfo: Setter<Record<string, CallsignInfoRes>>;
  setSummaryHasLoadedOnce: Setter<boolean>;
  setSummaryLoaded: Setter<boolean>;
  setSummaryLoading: Setter<boolean>;
  setTagsMap: Setter<Record<number, Tag>>;
  setTagsOrder: Setter<number[]>;
  setTopCallsigns: Setter<AnalysisCountItem[]>;
  setTopFreqs: Setter<AnalysisCountItem[]>;
  setTopLocations: Setter<AnalysisCountItem[]>;
  setRightSidebarLoading: Setter<boolean>;
  setTopUnits: Setter<AnalysisCountItem[]>;
  setUnitsMap: Setter<Record<number, Unit>>;
  setHasLoadedInitialMessages: Setter<boolean>;
  messageCommentsLoadVersionRef: React.MutableRefObject<number>;
};

export function useAnalysisActions(params: Params) {
  const {
    clearAnalysisResults,
    onUpdateLocalMessage,
    patchMessages: patchMessagesInternal,
  } = useAnalysisDataStateUtils({
    emptyNewCallsigns: params.emptyNewCallsigns,
    emptyOptions: params.emptyOptions,
    invalidateCallsignGraph: params.invalidateCallsignGraph,
    optionsFreqsRef: params.optionsFreqsRef,
    setAorEntries: params.setAorEntries,
    setCounts: params.setCounts,
    setCorrelatedFreqs: params.setCorrelatedFreqs,
    setGroupInfos: params.setGroupInfos,
    setGroupsActivity: params.setGroupsActivity,
    setGroupsActivityLoadedFreq: params.setGroupsActivityLoadedFreq,
    setGroupsActivityLoadedPeriod: params.setGroupsActivityLoadedPeriod,
    setMapDateRange: params.setMapDateRange,
    setMapNetworkUnits: params.setMapNetworkUnits,
    setMapOpenMessages: params.setMapOpenMessages,
    setMapPoints: params.setMapPoints,
    setMessages: params.setMessages,
    setMessageComments: params.setMessageComments,
    setNetworkDisplayMap: params.setNetworkDisplayMap,
    setNetworks: params.setNetworks,
    setNewCallsigns: params.setNewCallsigns,
    setNoMoreToLoad: params.setNoMoreToLoad,
    setNolimitShown: params.setNolimitShown,
    setOptions: params.setOptions,
    setProfiles: params.setProfiles,
    setSummaryCallsignsInfo: params.setSummaryCallsignsInfo,
    setSummaryHasLoadedOnce: params.setSummaryHasLoadedOnce,
    setSummaryLoaded: params.setSummaryLoaded,
    setSummaryLoading: params.setSummaryLoading,
    setSummaryRows: params.setSummaryRows,
    setTagsMap: params.setTagsMap,
    setTagsOrder: params.setTagsOrder,
    setTopCallsigns: params.setTopCallsigns,
    setTopFreqs: params.setTopFreqs,
    setTopLocations: params.setTopLocations,
    setRightSidebarLoading: params.setRightSidebarLoading,
    setTopUnits: params.setTopUnits,
    setUnitsMap: params.setUnitsMap,
    setHasLoadedInitialMessages: params.setHasLoadedInitialMessages,
    invalidateMessageCommentsLoads: () => {
      params.messageCommentsLoadVersionRef.current += 1;
      params.setMessageComments({});
    },
  });

  const messageActionState = useAnalysisDataMessageActions({
    authUserName: params.authUserName,
    currentUser: params.currentUser,
    messages: params.messages,
    mapOpenMessages: params.mapOpenMessages,
    optionsFreqs: params.optionsFreqValues,
    onError: params.onError,
    onUnauthorized: params.onUnauthorized,
    patchMessages: patchMessagesInternal,
    queryState: params.queryState,
    completeLocalInboxChangeOrigin: params.completeLocalInboxChangeOrigin,
    failLocalInboxChangeOrigin: params.failLocalInboxChangeOrigin,
    reconcileTagMutation: params.reconcileTagMutation,
    registerLocalInboxChangeOrigin: params.registerLocalInboxChangeOrigin,
    refreshTagFacet: params.refreshTagFacet,
    reload: params.reload,
    setMapOpenMessages: params.setMapOpenMessages,
    setMessages: params.setMessages,
    setSummaryRows: params.setSummaryRows,
    toErrorMessage,
  });

  return {
    clearAnalysisResults,
    onUpdateLocalMessage,
    patchMessages: patchMessagesInternal,
    messageActionState,
  };
}
