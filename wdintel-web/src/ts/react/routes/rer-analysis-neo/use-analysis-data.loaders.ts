import { useCallback } from 'react';

import type {
  CorrelatedFreq,
  FreqDailyActivityCount,
  FreqDetailedPoint,
  InboxMessage,
  NetJsonGraphAndMeta,
  NetworkUnit,
  PalitraReadV2,
} from '../../../../Bindings';
import {
  downloadAnalysisGeojson,
  downloadAnalysisKmz,
  downloadAnalysisSummaryTableXlsx,
  fetchAnalysisCallsignGraph,
  fetchAnalysisCorrelatedFreqs,
  fetchAnalysisMapPoints,
  fetchFreqActivityDaily,
  fetchMessagesByIds,
} from '../../services/api/analysis';
import { listPalitrasV2 } from '../../services/api/palitra';
import { downloadBlob } from '../../utils/download-blob';
import { ANALYSIS_SESSION_ACTIVITY_PAGE_ID, buildAnalysisReq, buildInboxReq } from './helpers';
import { toErrorMessage } from './use-analysis-data.shared';
import type { AnalysisGroupsActivityPeriod, AnalysisPalitrasLoadState, AnalysisQueryState } from './types';

type Setter<T> = React.Dispatch<React.SetStateAction<T>>;

type Params = {
  callsignGraphNolimit: boolean;
  callsignGraphRequestRef: React.MutableRefObject<number>;
  groupsActivityPeriod: AnalysisGroupsActivityPeriod;
  mapDateRangeLoadVersionRef: React.MutableRefObject<number>;
  mapMessagesLoadVersionRef: React.MutableRefObject<number>;
  newestFirst: boolean;
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  optionsFreqs: string[];
  queryState: AnalysisQueryState;
  setCallsignGraph: Setter<NetJsonGraphAndMeta | null>;
  setCallsignGraphLoading: Setter<boolean>;
  setCallsignGraphLoadVersion: Setter<number>;
  setCallsignGraphNolimit: Setter<boolean>;
  setCorrelatedFreqs: Setter<CorrelatedFreq[]>;
  setCorrelatedFreqsLoading: Setter<boolean>;
  setGroupsActivity: Setter<FreqDailyActivityCount | null>;
  setGroupsActivityLoadedFreq: Setter<string | null>;
  setGroupsActivityLoadedPeriod: Setter<AnalysisGroupsActivityPeriod | null>;
  setGroupsActivityLoading: Setter<boolean>;
  setGroupsActivityPeriod: Setter<AnalysisGroupsActivityPeriod>;
  setMapDateRange: Setter<{ startDate: number; endDate: number }>;
  setMapLoading: Setter<boolean>;
  setMapNetworkUnits: Setter<NetworkUnit[]>;
  setMapOpenMessages: Setter<Array<[number, InboxMessage]>>;
  setMapPalitras: Setter<PalitraReadV2[]>;
  setMapPalitrasLoaded: Setter<boolean>;
  setMapPalitrasLoadState: Setter<AnalysisPalitrasLoadState>;
  setMapPoints: Setter<FreqDetailedPoint[]>;
};

export function useAnalysisDataLoaders(params: Params) {
  const invalidateCallsignGraph = useCallback(() => {
    params.callsignGraphRequestRef.current += 1;
    params.setCallsignGraph(null);
    params.setCallsignGraphLoading(false);
    params.setCallsignGraphLoadVersion((current) => current + 1);
  }, [params]);

  const refreshMapDateRange = useCallback(
    async (range: { startDate: number; endDate: number }) => {
      const inboxReq = buildInboxReq(params.queryState, params.optionsFreqs);
      if (inboxReq == null) return;

      const loadVersion = params.mapDateRangeLoadVersionRef.current + 1;
      params.mapDateRangeLoadVersionRef.current = loadVersion;
      params.setMapLoading(true);
      params.setMapDateRange(range);

      try {
        const rsp = await fetchAnalysisMapPoints({
          inboxItemsFilter: {
            ...inboxReq,
            sinceDateInclusiveMs: range.startDate,
            tillDateInclusiveMs: range.endDate,
            newestFirst: params.newestFirst,
          },
          mapFilter: null,
          pageId: ANALYSIS_SESSION_ACTIVITY_PAGE_ID,
        });
        if (params.mapDateRangeLoadVersionRef.current !== loadVersion) return;
        params.setMapPoints(rsp.points ?? []);
        params.setMapNetworkUnits(rsp.networkUnits ?? []);
      } catch (loadError) {
        if (params.mapDateRangeLoadVersionRef.current !== loadVersion) return;
        if (!params.onUnauthorized(loadError)) params.onError(toErrorMessage(loadError));
      } finally {
        if (params.mapDateRangeLoadVersionRef.current === loadVersion) params.setMapLoading(false);
      }
    },
    [params],
  );

  const loadMessagesForMap = useCallback(
    async (messageIds: number[]) => {
      const loadVersion = params.mapMessagesLoadVersionRef.current + 1;
      params.mapMessagesLoadVersionRef.current = loadVersion;

      try {
        const nextMessages = await fetchMessagesByIds(messageIds);
        if (params.mapMessagesLoadVersionRef.current !== loadVersion) return;
        params.setMapOpenMessages(nextMessages);
      } catch (loadError) {
        if (params.mapMessagesLoadVersionRef.current !== loadVersion) return;
        if (!params.onUnauthorized(loadError)) params.onError(toErrorMessage(loadError));
      }
    },
    [params],
  );

  const loadMapPalitras = useCallback(async () => {
    params.setMapPalitrasLoadState('loading');
    params.setMapPalitrasLoaded(false);

    try {
      const palitras = await listPalitrasV2();
      params.setMapPalitras(
        palitras.map((palitraRead) => ({
          ...palitraRead,
          geometries: palitraRead.geometries.map((geometry) => ({ ...geometry, points: [] })),
        })),
      );
      params.setMapPalitrasLoaded(true);
      params.setMapPalitrasLoadState('success');
    } catch (loadError) {
      if (!params.onUnauthorized(loadError)) {
        params.onError(`Не вдалося завантажити палітри: ${toErrorMessage(loadError)}`);
      }
      params.setMapPalitras([]);
      params.setMapPalitrasLoaded(false);
      params.setMapPalitrasLoadState('error');
    }
  }, [params]);

  const loadCorrelatedFreqs = useCallback(async () => {
    const analysisReq = buildAnalysisReq(params.queryState, params.optionsFreqs);
    if (analysisReq == null || params.queryState.freqsSelected.length === 0) {
      params.setCorrelatedFreqs([]);
      return;
    }

    params.setCorrelatedFreqsLoading(true);
    try {
      const rsp = await fetchAnalysisCorrelatedFreqs(analysisReq);
      params.setCorrelatedFreqs(rsp.freqs ?? []);
    } catch (loadError) {
      if (!params.onUnauthorized(loadError)) params.onError(toErrorMessage(loadError));
    } finally {
      params.setCorrelatedFreqsLoading(false);
    }
  }, [params]);

  const loadCallsignGraph = useCallback(async () => {
    const analysisReq = buildAnalysisReq(params.queryState, params.optionsFreqs);
    if (analysisReq == null) return;

    const requestId = params.callsignGraphRequestRef.current + 1;
    params.callsignGraphRequestRef.current = requestId;
    params.setCallsignGraphLoading(true);
    try {
      const rsp = await fetchAnalysisCallsignGraph({ ...analysisReq, nolimit: params.callsignGraphNolimit });
      if (requestId !== params.callsignGraphRequestRef.current) return;
      params.setCallsignGraph(rsp);
    } catch (loadError) {
      if (requestId !== params.callsignGraphRequestRef.current) return;
      if (!params.onUnauthorized(loadError)) params.onError(toErrorMessage(loadError));
    } finally {
      if (requestId !== params.callsignGraphRequestRef.current) return;
      params.setCallsignGraphLoading(false);
    }
  }, [params]);

  const toggleCallsignGraphNolimit = useCallback(() => {
    invalidateCallsignGraph();
    params.setCallsignGraphNolimit((current) => !current);
  }, [invalidateCallsignGraph, params]);

  const loadGroupsActivity = useCallback(
    async (period?: AnalysisGroupsActivityPeriod) => {
      const analysisReq = buildAnalysisReq(params.queryState, params.optionsFreqs);
      const firstFreq = params.queryState.freqsSelected[0];
      if (analysisReq == null || !firstFreq) {
        params.setGroupsActivity(null);
        params.setGroupsActivityLoadedFreq(null);
        params.setGroupsActivityLoadedPeriod(null);
        return;
      }

      const nextPeriod = period ?? params.groupsActivityPeriod;
      const tillDateInclusiveMs = analysisReq.tillDateNoninclusiveMs;
      const dayMs = 24 * 60 * 60 * 1000;
      const sinceDateInclusiveMs =
        nextPeriod === 'month'
          ? tillDateInclusiveMs - 30 * dayMs
          : nextPeriod === 'quarter'
            ? tillDateInclusiveMs - 90 * dayMs
            : nextPeriod === 'year'
              ? tillDateInclusiveMs - 365 * dayMs
              : analysisReq.sinceDateInclusiveMs;

      params.setGroupsActivityLoading(true);
      params.setGroupsActivityPeriod(nextPeriod);
      try {
        const rsp = await fetchFreqActivityDaily({ freq: firstFreq, sinceDateInclusiveMs, tillDateInclusiveMs });
        params.setGroupsActivity(rsp);
        params.setGroupsActivityLoadedFreq(firstFreq);
        params.setGroupsActivityLoadedPeriod(nextPeriod);
      } catch (loadError) {
        if (!params.onUnauthorized(loadError)) params.onError(toErrorMessage(loadError));
      } finally {
        params.setGroupsActivityLoading(false);
      }
    },
    [params],
  );

  const downloadSummaryXlsx = useCallback(async () => {
    const analysisReq = buildAnalysisReq(params.queryState, params.optionsFreqs);
    if (analysisReq == null) {
      params.onError('Перевірте дату та час перед експортом.');
      return;
    }
    try {
      const blob = await downloadAnalysisSummaryTableXlsx(analysisReq);
      downloadBlob(blob, 'rer-analysis-summary.xlsx');
    } catch (loadError) {
      if (!params.onUnauthorized(loadError)) params.onError(toErrorMessage(loadError));
    }
  }, [params]);

  const downloadKmz = useCallback(async () => {
    const analysisReq = buildAnalysisReq(params.queryState, params.optionsFreqs);
    if (analysisReq == null) {
      params.onError('Перевірте дату та час перед експортом.');
      return;
    }
    try {
      const blob = await downloadAnalysisKmz(analysisReq);
      downloadBlob(blob, 'rer-analysis.kmz');
    } catch (loadError) {
      if (!params.onUnauthorized(loadError)) params.onError(toErrorMessage(loadError));
    }
  }, [params]);

  const downloadGeojson = useCallback(async () => {
    const analysisReq = buildAnalysisReq(params.queryState, params.optionsFreqs);
    if (analysisReq == null) {
      params.onError('Перевірте дату та час перед експортом.');
      return;
    }
    try {
      const blob = await downloadAnalysisGeojson(analysisReq);
      downloadBlob(blob, 'rer-analysis.geojson');
    } catch (loadError) {
      if (!params.onUnauthorized(loadError)) params.onError(toErrorMessage(loadError));
    }
  }, [params]);

  return {
    downloadGeojson,
    downloadKmz,
    downloadSummaryXlsx,
    invalidateCallsignGraph,
    loadCallsignGraph,
    loadCorrelatedFreqs,
    loadGroupsActivity,
    loadMapPalitras,
    loadMessagesForMap,
    refreshMapDateRange,
    toggleCallsignGraphNolimit,
  };
}
