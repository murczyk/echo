import { useCallback } from 'react';
import type { MutableRefObject } from 'react';

import type {
  CallsignInfoRes,
  CorrelatedFreq,
  FreqDailyActivityCount,
  NetworkCallsignRelationsRsp,
  NewCallsignsRes,
  SummaryTableFreqRow,
} from '../../../../Bindings';
import type { AnalysisCountItem, AnalysisGroupsActivityPeriod, AnalysisQueryState } from './types';
import type { Setter } from './use-analysis-sidebar-data.types';
import { useAnalysisGraphData } from './use-analysis-graph-data';
import { useAnalysisGroupsActivityData } from './use-analysis-groups-activity-data';
import { useAnalysisSummaryData } from './use-analysis-summary-data';
import { useAnalysisTopSidebarData } from './use-analysis-top-sidebar-data';
import type { InvalidateCallsignGraphOptions } from './use-analysis-graph-data';
import { downloadAnalysisGeojson, downloadAnalysisKmz } from '../../services/api/analysis';
import { downloadBlob } from '../../utils/download-blob';
import { buildAnalysisReq } from './helpers';
import { isNullOrUndefined } from '../../utils/misc';
import { toErrorMessage } from './use-analysis-data.shared';

type Params = {
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  optionsFreqValues: string[];
  queryState: AnalysisQueryState;
  summaryCallsignsInfoRef: MutableRefObject<Record<string, CallsignInfoRes>>;
  setSummaryCallsignsInfo: Setter<Record<string, CallsignInfoRes>>;
};

export type UseAnalysisSidebarDataResult = {
  correlatedFreqs: CorrelatedFreq[];
  correlatedFreqsLoaded: boolean;
  correlatedFreqsLoading: boolean;
  callsignGraph: NetworkCallsignRelationsRsp | null;
  callsignGraphLoading: boolean;
  callsignGraphLoadVersion: number;
  callsignGraphLoadError?: string | null;
  groupsActivity: FreqDailyActivityCount | null;
  groupsActivityLoadedFreq: string | null;
  groupsActivityLoadedPeriod: AnalysisGroupsActivityPeriod | null;
  groupsActivityLoading: boolean;
  groupsActivityPeriod: AnalysisGroupsActivityPeriod;
  summaryLoading: boolean;
  summaryLoaded: boolean;
  summaryHasLoadedOnce: boolean;
  summaryRows: SummaryTableFreqRow[];
  rightSidebarLoading: boolean;
  topCallsigns: AnalysisCountItem[];
  topFreqs: AnalysisCountItem[];
  topLocations: AnalysisCountItem[];
  topUnits: AnalysisCountItem[];
  newCallsigns: NewCallsignsRes;
  newCallsignsLoading: boolean;
  correlatedFreqsRequestRef: MutableRefObject<number>;
  callsignGraphRequestRef: MutableRefObject<number>;
  newCallsignsRequestRef: MutableRefObject<number>;
  newCallsignsLoadedKeyRef: MutableRefObject<string | null>;
  newCallsignsPendingKeyRef: MutableRefObject<string | null>;
  invalidateCorrelatedFreqsCache: () => void;
  invalidateCallsignGraph: (options?: InvalidateCallsignGraphOptions) => void;
  invalidateSummaryData: (keepLoading?: boolean) => void;
  invalidateRightSidebarData: () => void;
  loadCorrelatedFreqs: () => Promise<void>;
  loadCallsignGraph: () => Promise<void>;
  loadGroupsActivity: (period?: AnalysisGroupsActivityPeriod) => Promise<void>;
  loadSummaryData: () => Promise<void>;
  loadTopSidebarData: () => Promise<void>;
  loadNewCallsigns: () => Promise<void>;
  downloadGeojson: () => Promise<void>;
  downloadKmz: () => Promise<void>;
  downloadSummaryXlsx: () => Promise<void>;
  setCallsignGraph: Setter<NetworkCallsignRelationsRsp | null>;
  setCallsignGraphLoading: Setter<boolean>;
  setCallsignGraphLoadVersion: Setter<number>;
  setCorrelatedFreqs: Setter<CorrelatedFreq[]>;
  setCorrelatedFreqsLoading: Setter<boolean>;
  setGroupsActivity: Setter<FreqDailyActivityCount | null>;
  setGroupsActivityLoadedFreq: Setter<string | null>;
  setGroupsActivityLoadedPeriod: Setter<AnalysisGroupsActivityPeriod | null>;
  setGroupsActivityLoading: Setter<boolean>;
  setGroupsActivityPeriod: Setter<AnalysisGroupsActivityPeriod>;
  setSummaryLoading: Setter<boolean>;
  setSummaryLoaded: Setter<boolean>;
  setSummaryHasLoadedOnce: Setter<boolean>;
  setSummaryRows: Setter<SummaryTableFreqRow[]>;
  setRightSidebarLoading: Setter<boolean>;
  setTopCallsigns: Setter<AnalysisCountItem[]>;
  setTopFreqs: Setter<AnalysisCountItem[]>;
  setTopLocations: Setter<AnalysisCountItem[]>;
  setTopUnits: Setter<AnalysisCountItem[]>;
  setNewCallsigns: Setter<NewCallsignsRes>;
  setNewCallsignsLoading: Setter<boolean>;
  setNewCallsignsLoadedKey: (key: string | null) => void;
};

export function useAnalysisSidebarData({
  onError,
  onUnauthorized,
  optionsFreqValues,
  queryState,
  summaryCallsignsInfoRef,
  setSummaryCallsignsInfo,
}: Params): UseAnalysisSidebarDataResult {
  const summaryData = useAnalysisSummaryData({
    onError,
    onUnauthorized,
    optionsFreqValues,
    queryState,
    summaryCallsignsInfoRef,
    setSummaryCallsignsInfo,
  });
  const graphData = useAnalysisGraphData({
    onError,
    onUnauthorized,
    optionsFreqValues,
    queryState,
  });
  const groupsActivityData = useAnalysisGroupsActivityData({
    onError,
    onUnauthorized,
    optionsFreqValues,
    queryState,
  });
  const topSidebarData = useAnalysisTopSidebarData({
    onError,
    onUnauthorized,
    optionsFreqValues,
    queryState,
  });

  const downloadKmz = useCallback(async () => {
    const analysisReq = buildAnalysisReq(queryState, optionsFreqValues);
    if (isNullOrUndefined(analysisReq)) {
      onError('Перевірте дату та час перед експортом.');
      return;
    }
    try {
      const blob = await downloadAnalysisKmz(analysisReq);
      downloadBlob(blob, 'rer-analysis.kmz');
    } catch (loadError) {
      if (!onUnauthorized(loadError)) onError(toErrorMessage(loadError));
    }
  }, [onError, onUnauthorized, optionsFreqValues, queryState]);

  const downloadGeojson = useCallback(async () => {
    const analysisReq = buildAnalysisReq(queryState, optionsFreqValues);
    if (isNullOrUndefined(analysisReq)) {
      onError('Перевірте дату та час перед експортом.');
      return;
    }
    try {
      const blob = await downloadAnalysisGeojson(analysisReq);
      downloadBlob(blob, 'rer-analysis.geojson');
    } catch (loadError) {
      if (!onUnauthorized(loadError)) onError(toErrorMessage(loadError));
    }
  }, [onError, onUnauthorized, optionsFreqValues, queryState]);

  return {
    ...graphData,
    ...groupsActivityData,
    ...summaryData,
    ...topSidebarData,
    downloadGeojson,
    downloadKmz,
  };
}
