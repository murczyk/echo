import { useCallback, useRef } from 'react';
import { isNullOrUndefined } from '../../utils/misc';

import type {
  CallsignInfoRes,
  CorrelatedFreq,
  FreqDailyActivityCount,
  FreqDetailedPoint,
  InboxMessage,
  NetworkCallsignRelationsRsp,
  NetworkUnit,
  PalitraReadV2,
  SummaryTableFreqRow,
} from '../../../../Bindings';
import {
  downloadAnalysisGeojson,
  downloadAnalysisKmz,
  downloadAnalysisSummaryTableXlsx,
  fetchAnalysisActivityDaily,
  fetchAnalysisCallsignInfos,
  fetchAnalysisCallsignRelations,
  fetchAnalysisCorrelatedFreqs,
  fetchAnalysisCallsigns,
  fetchAnalysisLocations,
  fetchAnalysisMapPoints,
  fetchAnalysisSummaryTable,
  fetchFreqActivityDaily,
  fetchMessagesByIds,
  fetchAnalysisUnits,
} from '../../services/api/analysis';
import { listMapPalitrasV2 } from '../../services/api/palitra';
import { downloadBlob } from '../../utils/download-blob';
import { normalizeCallsignLookupValue } from '../../utils/callsign-normalization';
import { ANALYSIS_SESSION_ACTIVITY_PAGE_ID, buildAnalysisReq, buildInboxReq } from './helpers';
import {
  missingMapMessageIds,
  normalizeMapMessageIds,
  removeMapPointsForMissingMessages,
} from './analysis-map-message-access';
import { mergeAnalysisCallsignInfoMap } from './use-analysis-data.callsigns';
import { topItems } from './use-analysis-data.shared';
import { toErrorMessage } from './use-analysis-data.shared';
import type {
  AnalysisCountItem,
  AnalysisGroupsActivityPeriod,
  AnalysisPalitrasLoadState,
  AnalysisQueryState,
} from './types';
import type { InvalidateCallsignGraphOptions } from './use-analysis-graph-data';

type Setter<T> = React.Dispatch<React.SetStateAction<T>>;

export { missingMapMessageIds, normalizeMapMessageIds };

export function shouldClearMapOpenMessages(messageIds: readonly unknown[]): boolean {
  return normalizeMapMessageIds(messageIds).length === 0;
}

type Params = {
  callsignGraphRequestRef: React.MutableRefObject<number>;
  groupsActivityPeriod: AnalysisGroupsActivityPeriod;
  mapDateRangeLoadVersionRef: React.MutableRefObject<number>;
  mapMessagesLoadVersionRef: React.MutableRefObject<number>;
  newestFirst: boolean;
  loadMissingNetworksForMessages: (messageItems: Array<[number, InboxMessage]>) => Promise<void>;
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  optionsFreqs: string[];
  queryState: AnalysisQueryState;
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
  setMapDateRange: Setter<{ startDate: number; endDate: number }>;
  setMapLoading: Setter<boolean>;
  setMapNetworkUnits: Setter<NetworkUnit[]>;
  setMapOpenMessages: Setter<Array<[number, InboxMessage]>>;
  setMapPalitras: Setter<PalitraReadV2[]>;
  setMapPalitrasLoaded: Setter<boolean>;
  setMapPalitrasLoadState: Setter<AnalysisPalitrasLoadState>;
  setMapPoints: Setter<FreqDetailedPoint[]>;
  summaryCallsignsInfoRef: React.MutableRefObject<Record<string, CallsignInfoRes>>;
  setSummaryCallsignsInfo: Setter<Record<string, CallsignInfoRes>>;
  setSummaryHasLoadedOnce: Setter<boolean>;
  setSummaryLoaded: Setter<boolean>;
  setSummaryLoading: Setter<boolean>;
  setSummaryRows: Setter<SummaryTableFreqRow[]>;
  setTopCallsigns: Setter<AnalysisCountItem[]>;
  setTopFreqs: Setter<AnalysisCountItem[]>;
  setTopLocations: Setter<AnalysisCountItem[]>;
  setRightSidebarLoading: Setter<boolean>;
  setTopUnits: Setter<AnalysisCountItem[]>;
};

export function useAnalysisDataLoaders(params: Params) {
  const {
    callsignGraphRequestRef,
    groupsActivityPeriod,
    mapDateRangeLoadVersionRef,
    mapMessagesLoadVersionRef,
    newestFirst,
    loadMissingNetworksForMessages,
    onError,
    onUnauthorized,
    optionsFreqs,
    queryState,
    setCallsignGraph,
    setCallsignGraphLoading,
    setCallsignGraphLoadVersion,
    setCorrelatedFreqs,
    setCorrelatedFreqsLoading,
    setGroupsActivity,
    setGroupsActivityLoadedFreq,
    setGroupsActivityLoadedPeriod,
    setGroupsActivityLoading,
    setGroupsActivityPeriod,
    setMapDateRange,
    setMapLoading,
    setMapNetworkUnits,
    setMapOpenMessages,
    setMapPalitras,
    setMapPalitrasLoaded,
    setMapPalitrasLoadState,
    setMapPoints,
    summaryCallsignsInfoRef,
    setSummaryCallsignsInfo,
    setSummaryHasLoadedOnce,
    setSummaryLoaded,
    setSummaryLoading,
    setSummaryRows,
    setTopCallsigns,
    setTopFreqs,
    setTopLocations,
    setRightSidebarLoading,
    setTopUnits,
  } = params;
  const correlatedFreqsRequestRef = useRef(0);
  const correlatedFreqsRequestKeyRef = useRef<string | null>(null);
  const summaryRequestRef = useRef(0);
  const summaryRequestKeyRef = useRef<string | null>(null);
  const rightSidebarRequestRef = useRef(0);
  const rightSidebarRequestKeyRef = useRef<string | null>(null);
  const pendingCallsignInfoOwnersRef = useRef(new Map<string, number>());

  const invalidateCorrelatedFreqsCache = useCallback(() => {
    correlatedFreqsRequestRef.current += 1;
    correlatedFreqsRequestKeyRef.current = null;
  }, []);

  const invalidateCallsignGraph = useCallback(
    (options?: InvalidateCallsignGraphOptions) => {
      callsignGraphRequestRef.current += 1;
      if (options?.clearGraph) {
        setCallsignGraph(null);
      }
      setCallsignGraphLoading(false);
      setCallsignGraphLoadVersion((current) => current + 1);
    },
    [
      callsignGraphRequestRef,
      setCallsignGraph,
      setCallsignGraphLoading,
      setCallsignGraphLoadVersion,
    ],
  );

  const invalidateSummaryData = useCallback(
    (keepLoading = false) => {
      summaryRequestRef.current += 1;
      summaryRequestKeyRef.current = null;
      if (!keepLoading) {
        setSummaryRows([]);
        setSummaryHasLoadedOnce(false);
      }
      setSummaryLoaded(false);
      setSummaryLoading(keepLoading);
    },
    [setSummaryHasLoadedOnce, setSummaryLoaded, setSummaryLoading, setSummaryRows],
  );

  const invalidateRightSidebarData = useCallback(() => {
    rightSidebarRequestRef.current += 1;
    rightSidebarRequestKeyRef.current = null;
    setRightSidebarLoading(false);
  }, [setRightSidebarLoading]);

  const loadMissingCallsignInfos = useCallback(
    async (callsigns: string[], requestId: number) => {
      const missingCallsigns: string[] = [];
      const seenKeys = new Set<string>();

      callsigns.forEach((callsign) => {
        const key = normalizeCallsignLookupValue(callsign);
        if (key === '' || seenKeys.has(key)) return;
        seenKeys.add(key);
        if (summaryCallsignsInfoRef.current[key]) return;
        const pendingOwner = pendingCallsignInfoOwnersRef.current.get(key);
        if (pendingOwner === requestId) return;
        pendingCallsignInfoOwnersRef.current.set(key, requestId);
        missingCallsigns.push(callsign.trim());
      });

      if (missingCallsigns.length === 0) return;

      try {
        const callsignInfos = await fetchAnalysisCallsignInfos(missingCallsigns);
        setSummaryCallsignsInfo((current) => mergeAnalysisCallsignInfoMap(current, callsignInfos));
      } finally {
        missingCallsigns.forEach((callsign) => {
          const key = normalizeCallsignLookupValue(callsign);
          if (pendingCallsignInfoOwnersRef.current.get(key) === requestId) {
            pendingCallsignInfoOwnersRef.current.delete(key);
          }
        });
      }
    },
    [setSummaryCallsignsInfo, summaryCallsignsInfoRef],
  );

  const refreshMapDateRange = useCallback(
    async (range: { startDate: number; endDate: number }) => {
      const inboxReq = buildInboxReq(queryState, optionsFreqs);
      if (isNullOrUndefined(inboxReq)) return;

      const loadVersion = mapDateRangeLoadVersionRef.current + 1;
      mapDateRangeLoadVersionRef.current = loadVersion;
      setMapLoading(true);
      setMapDateRange(range);

      try {
        const rsp = await fetchAnalysisMapPoints({
          inboxItemsFilter: {
            ...inboxReq,
            sinceDateInclusiveMs: range.startDate,
            tillDateInclusiveMs: range.endDate,
            newestFirst,
          },
          mapFilter: null,
          pageId: ANALYSIS_SESSION_ACTIVITY_PAGE_ID,
        });
        if (mapDateRangeLoadVersionRef.current !== loadVersion) return;
        setMapPoints(rsp.points ?? []);
        setMapNetworkUnits(rsp.networkUnits ?? []);
      } catch (loadError) {
        if (mapDateRangeLoadVersionRef.current !== loadVersion) return;
        if (!onUnauthorized(loadError)) onError(toErrorMessage(loadError));
      } finally {
        if (mapDateRangeLoadVersionRef.current === loadVersion) setMapLoading(false);
      }
    },
    [
      mapDateRangeLoadVersionRef,
      newestFirst,
      onError,
      onUnauthorized,
      optionsFreqs,
      queryState,
      setMapDateRange,
      setMapLoading,
      setMapNetworkUnits,
      setMapPoints,
    ],
  );

  const loadMessagesForMap = useCallback(
    async (messageIds: number[]) => {
      const cleanMessageIds = normalizeMapMessageIds(messageIds);
      if (cleanMessageIds.length === 0) {
        mapMessagesLoadVersionRef.current += 1;
        setMapOpenMessages([]);
        return false;
      }

      const loadVersion = mapMessagesLoadVersionRef.current + 1;
      mapMessagesLoadVersionRef.current = loadVersion;

      try {
        const nextMessages = await fetchMessagesByIds(cleanMessageIds);
        if (mapMessagesLoadVersionRef.current !== loadVersion) return false;
        const missingMessageIds = missingMapMessageIds(cleanMessageIds, nextMessages);
        if (missingMessageIds.length > 0) {
          setMapPoints((current) => removeMapPointsForMissingMessages(current, missingMessageIds));
        }
        setMapOpenMessages(nextMessages);
        void loadMissingNetworksForMessages(nextMessages);
        return nextMessages.length > 0;
      } catch (loadError) {
        if (mapMessagesLoadVersionRef.current !== loadVersion) return false;
        if (!onUnauthorized(loadError)) onError(toErrorMessage(loadError));
        return false;
      }
    },
    [
      loadMissingNetworksForMessages,
      mapMessagesLoadVersionRef,
      onError,
      onUnauthorized,
      setMapOpenMessages,
      setMapPoints,
    ],
  );

  const loadMapPalitras = useCallback(async () => {
    setMapPalitrasLoadState('loading');
    setMapPalitrasLoaded(false);

    try {
      const palitras = await listMapPalitrasV2();
      setMapPalitras(
        palitras.map((palitraRead) => ({
          ...palitraRead,
          geometries: palitraRead.geometries.map((geometry) => ({ ...geometry, points: [] })),
        })),
      );
      setMapPalitrasLoaded(true);
      setMapPalitrasLoadState('success');
    } catch (loadError) {
      if (!onUnauthorized(loadError)) {
        onError(`Не вдалося завантажити палітри: ${toErrorMessage(loadError)}`);
      }
      setMapPalitras([]);
      setMapPalitrasLoaded(false);
      setMapPalitrasLoadState('error');
    }
  }, [onError, onUnauthorized, setMapPalitras, setMapPalitrasLoaded, setMapPalitrasLoadState]);

  const loadCorrelatedFreqs = useCallback(async () => {
    const analysisReq = buildAnalysisReq(queryState, optionsFreqs);
    if (isNullOrUndefined(analysisReq) || queryState.freqsSelected.length === 0) {
      correlatedFreqsRequestRef.current += 1;
      correlatedFreqsRequestKeyRef.current = null;
      setCorrelatedFreqs([]);
      return;
    }

    const requestKey = JSON.stringify(analysisReq);
    if (correlatedFreqsRequestKeyRef.current === requestKey) return;

    const requestId = correlatedFreqsRequestRef.current + 1;
    correlatedFreqsRequestRef.current = requestId;
    correlatedFreqsRequestKeyRef.current = requestKey;
    setCorrelatedFreqsLoading(true);
    try {
      const rsp = await fetchAnalysisCorrelatedFreqs(analysisReq);
      if (requestId !== correlatedFreqsRequestRef.current) return;
      setCorrelatedFreqs(rsp.freqs ?? []);
    } catch (loadError) {
      if (requestId !== correlatedFreqsRequestRef.current) return;
      correlatedFreqsRequestKeyRef.current = null;
      if (!onUnauthorized(loadError)) onError(toErrorMessage(loadError));
    } finally {
      if (requestId !== correlatedFreqsRequestRef.current) return;
      setCorrelatedFreqsLoading(false);
    }
  }, [
    onError,
    onUnauthorized,
    optionsFreqs,
    queryState,
    setCorrelatedFreqs,
    setCorrelatedFreqsLoading,
  ]);

  const loadCallsignGraph = useCallback(async () => {
    const analysisReq = buildAnalysisReq(queryState, optionsFreqs);
    if (isNullOrUndefined(analysisReq)) return;

    const requestId = callsignGraphRequestRef.current + 1;
    callsignGraphRequestRef.current = requestId;
    setCallsignGraphLoading(true);
    try {
      const rsp = await fetchAnalysisCallsignRelations(analysisReq);
      if (requestId !== callsignGraphRequestRef.current) return;
      setCallsignGraph(rsp);
    } catch (loadError) {
      if (requestId !== callsignGraphRequestRef.current) return;
      if (!onUnauthorized(loadError)) onError(toErrorMessage(loadError));
    } finally {
      if (requestId !== callsignGraphRequestRef.current) return;
      setCallsignGraphLoading(false);
    }
  }, [
    callsignGraphRequestRef,
    onError,
    onUnauthorized,
    optionsFreqs,
    queryState,
    setCallsignGraph,
    setCallsignGraphLoading,
  ]);

  const loadGroupsActivity = useCallback(
    async (period?: AnalysisGroupsActivityPeriod) => {
      const analysisReq = buildAnalysisReq(queryState, optionsFreqs);
      const firstFreq = queryState.freqsSelected[0];
      if (isNullOrUndefined(analysisReq)) {
        setGroupsActivity(null);
        setGroupsActivityLoadedFreq(null);
        setGroupsActivityLoadedPeriod(null);
        return;
      }

      const nextPeriod = period ?? groupsActivityPeriod;
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

      setGroupsActivityLoading(true);
      setGroupsActivityPeriod(nextPeriod);
      try {
        const rsp = firstFreq
          ? await fetchFreqActivityDaily({
              freq: firstFreq,
              sinceDateInclusiveMs,
              tillDateInclusiveMs,
            })
          : await fetchAnalysisActivityDaily({
              ...analysisReq,
              sinceDateInclusiveMs,
              tillDateNoninclusiveMs: tillDateInclusiveMs,
            });
        setGroupsActivity(rsp);
        setGroupsActivityLoadedFreq(firstFreq ?? null);
        setGroupsActivityLoadedPeriod(nextPeriod);
      } catch (loadError) {
        if (!onUnauthorized(loadError)) onError(toErrorMessage(loadError));
      } finally {
        setGroupsActivityLoading(false);
      }
    },
    [
      groupsActivityPeriod,
      onError,
      onUnauthorized,
      optionsFreqs,
      queryState,
      setGroupsActivity,
      setGroupsActivityLoadedFreq,
      setGroupsActivityLoadedPeriod,
      setGroupsActivityLoading,
      setGroupsActivityPeriod,
    ],
  );

  const loadSummaryData = useCallback(async () => {
    const analysisReq = buildAnalysisReq(queryState, optionsFreqs);
    if (isNullOrUndefined(analysisReq)) {
      summaryRequestRef.current += 1;
      summaryRequestKeyRef.current = null;
      setSummaryRows([]);
      setSummaryHasLoadedOnce(true);
      setSummaryLoaded(true);
      setSummaryLoading(false);
      return;
    }

    const requestKey = JSON.stringify(analysisReq);
    if (summaryRequestKeyRef.current === requestKey) return;

    const requestId = summaryRequestRef.current + 1;
    summaryRequestRef.current = requestId;
    summaryRequestKeyRef.current = requestKey;
    setSummaryLoaded(false);
    setSummaryLoading(true);

    try {
      const rsp = await fetchAnalysisSummaryTable(analysisReq);
      if (requestId !== summaryRequestRef.current) return;
      const nextRows = rsp.rows ?? [];
      setSummaryRows(nextRows);
      const callsignIds = Array.from(
        new Set(
          nextRows
            .flatMap((row) => row.callsigns ?? [])
            .map((callsign) => callsign.trim())
            .filter((callsign) => callsign !== ''),
        ),
      );
      if (callsignIds.length > 0) {
        try {
          await loadMissingCallsignInfos(callsignIds, requestId);
        } catch (loadError) {
          if (requestId !== summaryRequestRef.current) return;
          summaryRequestKeyRef.current = null;
          if (!onUnauthorized(loadError)) onError(toErrorMessage(loadError));
        }
        if (requestId !== summaryRequestRef.current) return;
      }
    } catch (loadError) {
      if (requestId !== summaryRequestRef.current) return;
      summaryRequestKeyRef.current = null;
      setSummaryRows([]);
      if (!onUnauthorized(loadError)) onError(toErrorMessage(loadError));
    } finally {
      if (requestId === summaryRequestRef.current) {
        setSummaryHasLoadedOnce(true);
        setSummaryLoaded(true);
        setSummaryLoading(false);
      }
    }
  }, [
    loadMissingCallsignInfos,
    onError,
    onUnauthorized,
    optionsFreqs,
    queryState,
    setSummaryHasLoadedOnce,
    setSummaryLoaded,
    setSummaryLoading,
    setSummaryRows,
  ]);

  const loadTopSidebarData = useCallback(async () => {
    const analysisReq = buildAnalysisReq(queryState, optionsFreqs);
    if (isNullOrUndefined(analysisReq)) {
      rightSidebarRequestRef.current += 1;
      rightSidebarRequestKeyRef.current = null;
      setTopCallsigns([]);
      setTopFreqs([]);
      setTopLocations([]);
      setTopUnits([]);
      setRightSidebarLoading(false);
      return;
    }

    const requestKey = JSON.stringify(analysisReq);
    if (rightSidebarRequestKeyRef.current === requestKey) return;

    const requestId = rightSidebarRequestRef.current + 1;
    rightSidebarRequestRef.current = requestId;
    rightSidebarRequestKeyRef.current = requestKey;
    setRightSidebarLoading(true);

    try {
      const [callsignsRsp, unitsRsp, locationsRsp] = await Promise.all([
        fetchAnalysisCallsigns(analysisReq),
        fetchAnalysisUnits(analysisReq),
        fetchAnalysisLocations(analysisReq),
      ]);
      if (requestId !== rightSidebarRequestRef.current) return;
      setTopCallsigns(
        topItems(
          callsignsRsp.callsigns,
          (item) => item.callsign,
          (item) => item.count,
        ),
      );
      setTopUnits(
        topItems(
          unitsRsp.units,
          (item) => item.name,
          (item) => item.count,
          (item) => String(item.unitId),
        ),
      );
      setTopLocations(
        topItems(
          locationsRsp.locations,
          (item) => item.location,
          (item) => item.count,
        ),
      );

      const callsignIds = callsignsRsp.callsigns.map((item) => item.callsign);
      if (callsignIds.length > 0) {
        await loadMissingCallsignInfos(callsignIds, requestId);
        if (requestId !== rightSidebarRequestRef.current) return;
      }
    } catch (loadError) {
      if (requestId !== rightSidebarRequestRef.current) return;
      rightSidebarRequestKeyRef.current = null;
      if (!onUnauthorized(loadError)) onError(toErrorMessage(loadError));
    } finally {
      if (requestId === rightSidebarRequestRef.current) setRightSidebarLoading(false);
    }
  }, [
    onError,
    onUnauthorized,
    loadMissingCallsignInfos,
    optionsFreqs,
    queryState,
    setTopCallsigns,
    setTopFreqs,
    setTopLocations,
    setRightSidebarLoading,
    setTopUnits,
  ]);

  const downloadSummaryXlsx = useCallback(async () => {
    const analysisReq = buildAnalysisReq(queryState, optionsFreqs);
    if (isNullOrUndefined(analysisReq)) {
      onError('Перевірте дату та час перед експортом.');
      return;
    }
    try {
      const blob = await downloadAnalysisSummaryTableXlsx(analysisReq);
      downloadBlob(blob, 'rer-analysis-summary.xlsx');
    } catch (loadError) {
      if (!onUnauthorized(loadError)) onError(toErrorMessage(loadError));
    }
  }, [onError, onUnauthorized, optionsFreqs, queryState]);

  const downloadKmz = useCallback(async () => {
    const analysisReq = buildAnalysisReq(queryState, optionsFreqs);
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
  }, [onError, onUnauthorized, optionsFreqs, queryState]);

  const downloadGeojson = useCallback(async () => {
    const analysisReq = buildAnalysisReq(queryState, optionsFreqs);
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
  }, [onError, onUnauthorized, optionsFreqs, queryState]);

  return {
    downloadGeojson,
    downloadKmz,
    downloadSummaryXlsx,
    invalidateCorrelatedFreqsCache,
    invalidateCallsignGraph,
    loadCallsignGraph,
    loadCorrelatedFreqs,
    loadGroupsActivity,
    loadSummaryData,
    loadTopSidebarData,
    loadMapPalitras,
    loadMessagesForMap,
    refreshMapDateRange,
    invalidateSummaryData,
    invalidateRightSidebarData,
  };
}
