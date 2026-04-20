import { useCallback } from 'react';

import type {
  CountStatsRsp,
  FreqDailyActivityCount,
  FreqDetailedPoint,
  InboxMessage,
  Network,
  NetworkUnit,
  NewCallsignsRes,
  PalitraReadV2,
  SignalGroupEntry,
  SignalProfileEntry,
  SummaryTableFreqRow,
  Tag,
  Unit,
} from '../../../../Bindings';
import type { AnalysisAorEntry, AnalysisCountItem } from './types';

type Setter<T> = React.Dispatch<React.SetStateAction<T>>;

type Params = {
  emptyNewCallsigns: NewCallsignsRes;
  emptyOptions: import('./types').AnalysisFilterOptions;
  invalidateCallsignGraph: () => void;
  optionsFreqsRef: React.MutableRefObject<string[]>;
  setAorEntries: Setter<AnalysisAorEntry[]>;
  setCounts: Setter<CountStatsRsp | null>;
  setCorrelatedFreqs: Setter<import('../../../../Bindings').CorrelatedFreq[]>;
  setGroupInfos: Setter<Record<string, SignalGroupEntry>>;
  setGroupsActivity: Setter<FreqDailyActivityCount | null>;
  setGroupsActivityLoadedFreq: Setter<string | null>;
  setGroupsActivityLoadedPeriod: Setter<import('./types').AnalysisGroupsActivityPeriod | null>;
  setMapDateRange: Setter<{ startDate: number; endDate: number }>;
  setMapNetworkUnits: Setter<NetworkUnit[]>;
  setMapOpenMessages: Setter<Array<[number, InboxMessage]>>;
  setMapPoints: Setter<FreqDetailedPoint[]>;
  setMessages: Setter<Array<[number, InboxMessage]>>;
  setNetworkDisplayMap: Setter<Record<number, string>>;
  setNetworks: Setter<Network[]>;
  setNewCallsigns: Setter<NewCallsignsRes>;
  setNoMoreToLoad: Setter<boolean>;
  setNolimitShown: Setter<boolean>;
  setOptions: Setter<import('./types').AnalysisFilterOptions>;
  setProfiles: Setter<Record<string, SignalProfileEntry | null>>;
  setSummaryCallsignsInfo: Setter<Record<string, import('../../../../Bindings').CallsignInfoRes>>;
  setSummaryRows: Setter<SummaryTableFreqRow[]>;
  setTagsMap: Setter<Record<number, Tag>>;
  setTopCallsigns: Setter<AnalysisCountItem[]>;
  setTopFreqs: Setter<AnalysisCountItem[]>;
  setTopLocations: Setter<AnalysisCountItem[]>;
  setTopUnits: Setter<AnalysisCountItem[]>;
  setUnitsMap: Setter<Record<number, Unit>>;
  setHasLoadedInitialMessages: Setter<boolean>;
};

export function useAnalysisDataStateUtils(params: Params) {
  const {
    emptyNewCallsigns,
    emptyOptions,
    invalidateCallsignGraph,
    optionsFreqsRef,
    setAorEntries,
    setCounts,
    setCorrelatedFreqs,
    setGroupInfos,
    setGroupsActivity,
    setGroupsActivityLoadedFreq,
    setGroupsActivityLoadedPeriod,
    setMapDateRange,
    setMapNetworkUnits,
    setMapOpenMessages,
    setMapPoints,
    setMessages,
    setNetworkDisplayMap,
    setNetworks,
    setNewCallsigns,
    setNoMoreToLoad,
    setNolimitShown,
    setOptions,
    setProfiles,
    setSummaryCallsignsInfo,
    setSummaryRows,
    setTagsMap,
    setTopCallsigns,
    setTopFreqs,
    setTopLocations,
    setTopUnits,
    setUnitsMap,
    setHasLoadedInitialMessages,
  } = params;

  const patchMessages = useCallback(
    (updater: (messageId: number, message: InboxMessage) => InboxMessage) => {
      const updateItems = (items: Array<[number, InboxMessage]>) =>
        items.map(([messageId, message]) => [messageId, updater(messageId, message)] as [number, InboxMessage]);

      setMessages((current) => updateItems(current));
      setMapOpenMessages((current) => updateItems(current));
    },
    [setMapOpenMessages, setMessages],
  );

  const clearAnalysisResults = useCallback(() => {
    setCounts(null);
    setMessages([]);
    setSummaryRows([]);
    setNewCallsigns(emptyNewCallsigns);
    setOptions(emptyOptions);
    setTopFreqs([]);
    setTopCallsigns([]);
    setTopUnits([]);
    setTopLocations([]);
    setAorEntries([]);
    setProfiles({});
    setGroupInfos({});
    setTagsMap({});
    setNetworks([]);
    setUnitsMap({});
    setNetworkDisplayMap({});
    setSummaryCallsignsInfo({});
    setMapDateRange({ startDate: 0, endDate: 0 });
    setHasLoadedInitialMessages(false);
    setMapPoints([]);
    setMapNetworkUnits([]);
    setMapOpenMessages([]);
    setCorrelatedFreqs([]);
    setGroupsActivity(null);
    setGroupsActivityLoadedFreq(null);
    setGroupsActivityLoadedPeriod(null);
    setNoMoreToLoad(false);
    setNolimitShown(false);
    optionsFreqsRef.current = [];
    invalidateCallsignGraph();
  }, [
    emptyNewCallsigns,
    emptyOptions,
    invalidateCallsignGraph,
    optionsFreqsRef,
    setAorEntries,
    setCorrelatedFreqs,
    setCounts,
    setGroupInfos,
    setGroupsActivity,
    setGroupsActivityLoadedFreq,
    setGroupsActivityLoadedPeriod,
    setMapDateRange,
    setMapNetworkUnits,
    setMapOpenMessages,
    setMapPoints,
    setMessages,
    setNetworkDisplayMap,
    setNetworks,
    setNewCallsigns,
    setNoMoreToLoad,
    setNolimitShown,
    setOptions,
    setProfiles,
    setSummaryCallsignsInfo,
    setSummaryRows,
    setTagsMap,
    setTopCallsigns,
    setTopFreqs,
    setTopLocations,
    setTopUnits,
    setUnitsMap,
  ]);

  const onUpdateLocalMessage = useCallback(
    (messageId: number, updater: (message: InboxMessage) => InboxMessage) => {
      patchMessages((id, message) => (id === messageId ? updater(message) : message));
    },
    [patchMessages],
  );

  return {
    clearAnalysisResults,
    onUpdateLocalMessage,
    patchMessages,
  };
}
