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
};

export function useAnalysisDataStateUtils(params: Params) {
  const patchMessages = useCallback(
    (updater: (messageId: number, message: InboxMessage) => InboxMessage) => {
      const updateItems = (items: Array<[number, InboxMessage]>) =>
        items.map(([messageId, message]) => [messageId, updater(messageId, message)] as [number, InboxMessage]);

      params.setMessages((current) => updateItems(current));
      params.setMapOpenMessages((current) => updateItems(current));
    },
    [params],
  );

  const clearAnalysisResults = useCallback(() => {
    params.setCounts(null);
    params.setMessages([]);
    params.setSummaryRows([]);
    params.setNewCallsigns(params.emptyNewCallsigns);
    params.setOptions(params.emptyOptions);
    params.setTopFreqs([]);
    params.setTopCallsigns([]);
    params.setTopUnits([]);
    params.setTopLocations([]);
    params.setAorEntries([]);
    params.setProfiles({});
    params.setGroupInfos({});
    params.setTagsMap({});
    params.setNetworks([]);
    params.setUnitsMap({});
    params.setNetworkDisplayMap({});
    params.setSummaryCallsignsInfo({});
    params.setMapDateRange({ startDate: 0, endDate: 0 });
    params.setMapPoints([]);
    params.setMapNetworkUnits([]);
    params.setMapOpenMessages([]);
    params.setCorrelatedFreqs([]);
    params.setGroupsActivity(null);
    params.setGroupsActivityLoadedFreq(null);
    params.setGroupsActivityLoadedPeriod(null);
    params.setNoMoreToLoad(false);
    params.setNolimitShown(false);
    params.optionsFreqsRef.current = [];
    params.invalidateCallsignGraph();
  }, [params]);

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
