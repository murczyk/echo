import { useCallback, useRef, useState } from 'react';

import type {
  CallsignInfoRes,
  CorrelatedFreq,
  FreqDailyActivityCount,
  NetJsonGraphAndMeta,
  NewCallsignsRes,
  SummaryTableFreqRow,
} from '../../../../Bindings';
import {
  downloadAnalysisGeojson,
  downloadAnalysisKmz,
  downloadAnalysisSummaryTableXlsx,
  fetchAnalysisCallsignInfos,
  fetchAnalysisCallsignGraph,
  fetchAnalysisCallsigns,
  fetchAnalysisCorrelatedFreqs,
  fetchAnalysisLocations,
  fetchAnalysisSummaryTable,
  fetchAnalysisUnits,
  fetchFreqActivityDaily,
} from '../../services/api/analysis';
import { downloadBlob } from '../../utils/download-blob';
import { isNullOrUndefined } from '../../utils/misc';
import { buildAnalysisReq } from './helpers';
import { normalizeCallsignLookupValue } from '../../utils/callsign-normalization';
import { mergeAnalysisCallsignInfoMap } from './use-analysis-data.callsigns';
import { emptyNewCallsigns, toErrorMessage, topItems } from './use-analysis-data.shared';
import { useLoadNewCallsigns } from './use-analysis-data.support';
import type { AnalysisCountItem, AnalysisGroupsActivityPeriod, AnalysisQueryState } from './types';

type Setter<T> = React.Dispatch<React.SetStateAction<T>>;

type Params = {
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  optionsFreqValues: string[];
  queryState: AnalysisQueryState;
  summaryCallsignsInfoRef: React.MutableRefObject<Record<string, CallsignInfoRes>>;
  setSummaryCallsignsInfo: Setter<Record<string, CallsignInfoRes>>;
};

export type UseAnalysisSidebarDataResult = {
  correlatedFreqs: CorrelatedFreq[];
  correlatedFreqsLoading: boolean;
  callsignGraph: NetJsonGraphAndMeta | null;
  callsignGraphLoading: boolean;
  callsignGraphLoadVersion: number;
  callsignGraphNolimit: boolean;
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
  correlatedFreqsRequestRef: React.MutableRefObject<number>;
  callsignGraphRequestRef: React.MutableRefObject<number>;
  newCallsignsRequestRef: React.MutableRefObject<number>;
  newCallsignsLoadedKeyRef: React.MutableRefObject<string | null>;
  newCallsignsPendingKeyRef: React.MutableRefObject<string | null>;
  invalidateCorrelatedFreqsCache: () => void;
  invalidateCallsignGraph: () => void;
  invalidateSummaryData: (keepLoading?: boolean) => void;
  invalidateRightSidebarData: () => void;
  loadCorrelatedFreqs: () => Promise<void>;
  loadCallsignGraph: () => Promise<void>;
  toggleCallsignGraphNolimit: () => void;
  loadGroupsActivity: (period?: AnalysisGroupsActivityPeriod) => Promise<void>;
  loadSummaryData: () => Promise<void>;
  loadTopSidebarData: () => Promise<void>;
  loadNewCallsigns: () => Promise<void>;
  downloadGeojson: () => Promise<void>;
  downloadKmz: () => Promise<void>;
  downloadSummaryXlsx: () => Promise<void>;
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
  const [correlatedFreqs, setCorrelatedFreqs] = useState<CorrelatedFreq[]>([]);
  const [correlatedFreqsLoading, setCorrelatedFreqsLoading] = useState(false);
  const [callsignGraph, setCallsignGraph] = useState<NetJsonGraphAndMeta | null>(null);
  const [callsignGraphLoading, setCallsignGraphLoading] = useState(false);
  const [callsignGraphLoadVersion, setCallsignGraphLoadVersion] = useState(0);
  const [callsignGraphNolimit, setCallsignGraphNolimit] = useState(false);
  const [groupsActivity, setGroupsActivity] = useState<FreqDailyActivityCount | null>(null);
  const [groupsActivityLoadedFreq, setGroupsActivityLoadedFreq] = useState<string | null>(null);
  const [groupsActivityLoadedPeriod, setGroupsActivityLoadedPeriod] = useState<AnalysisGroupsActivityPeriod | null>(null);
  const [groupsActivityLoading, setGroupsActivityLoading] = useState(false);
  const [groupsActivityPeriod, setGroupsActivityPeriod] = useState<AnalysisGroupsActivityPeriod>('selected');
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryLoaded, setSummaryLoaded] = useState(false);
  const [summaryHasLoadedOnce, setSummaryHasLoadedOnce] = useState(false);
  const [summaryRows, setSummaryRows] = useState<SummaryTableFreqRow[]>([]);
  const [rightSidebarLoading, setRightSidebarLoading] = useState(false);
  const [topFreqs, setTopFreqs] = useState<AnalysisCountItem[]>([]);
  const [topCallsigns, setTopCallsigns] = useState<AnalysisCountItem[]>([]);
  const [topUnits, setTopUnits] = useState<AnalysisCountItem[]>([]);
  const [topLocations, setTopLocations] = useState<AnalysisCountItem[]>([]);
  const [newCallsigns, setNewCallsigns] = useState<NewCallsignsRes>(emptyNewCallsigns);
  const [newCallsignsLoading, setNewCallsignsLoading] = useState(false);

  const correlatedFreqsRequestRef = useRef(0);
  const correlatedFreqsRequestKeyRef = useRef<string | null>(null);
  const summaryRequestRef = useRef(0);
  const summaryRequestKeyRef = useRef<string | null>(null);
  const rightSidebarRequestRef = useRef(0);
  const rightSidebarRequestKeyRef = useRef<string | null>(null);
  const pendingCallsignInfoKeysRef = useRef(new Set<string>());
  const callsignGraphRequestRef = useRef(0);
  const newCallsignsRequestRef = useRef(0);
  const newCallsignsLoadedKeyRef = useRef<string | null>(null);
  const newCallsignsPendingKeyRef = useRef<string | null>(null);

  const loadMissingCallsignInfos = useCallback(
    async (callsigns: string[]) => {
      const missingCallsigns: string[] = [];
      const seenKeys = new Set<string>();

      callsigns.forEach((callsign) => {
        const key = normalizeCallsignLookupValue(callsign);
        if (key === '' || seenKeys.has(key)) return;
        seenKeys.add(key);
        if (summaryCallsignsInfoRef.current[key] || pendingCallsignInfoKeysRef.current.has(key)) return;
        pendingCallsignInfoKeysRef.current.add(key);
        missingCallsigns.push(callsign.trim());
      });

      if (missingCallsigns.length === 0) return;

      try {
        const callsignInfos = await fetchAnalysisCallsignInfos(missingCallsigns);
        setSummaryCallsignsInfo((current) => mergeAnalysisCallsignInfoMap(current, callsignInfos));
      } finally {
        missingCallsigns.forEach((callsign) => {
          pendingCallsignInfoKeysRef.current.delete(normalizeCallsignLookupValue(callsign));
        });
      }
    },
    [setSummaryCallsignsInfo, summaryCallsignsInfoRef],
  );

  const invalidateCorrelatedFreqsCache = useCallback(() => {
    correlatedFreqsRequestRef.current += 1;
    correlatedFreqsRequestKeyRef.current = null;
  }, []);

  const invalidateCallsignGraph = useCallback(() => {
    callsignGraphRequestRef.current += 1;
    setCallsignGraph(null);
    setCallsignGraphLoading(false);
    setCallsignGraphLoadVersion((current) => current + 1);
  }, []);

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
    [setSummaryHasLoadedOnce],
  );

  const invalidateRightSidebarData = useCallback(() => {
    rightSidebarRequestRef.current += 1;
    rightSidebarRequestKeyRef.current = null;
    setRightSidebarLoading(false);
    setTopCallsigns([]);
    setTopLocations([]);
    setTopUnits([]);
  }, []);

  const loadCorrelatedFreqs = useCallback(async () => {
    const analysisReq = buildAnalysisReq(queryState, optionsFreqValues);
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
  }, [onError, onUnauthorized, optionsFreqValues, queryState]);

  const loadCallsignGraph = useCallback(async () => {
    const analysisReq = buildAnalysisReq(queryState, optionsFreqValues);
    if (isNullOrUndefined(analysisReq)) return;

    const requestId = callsignGraphRequestRef.current + 1;
    callsignGraphRequestRef.current = requestId;
    setCallsignGraphLoading(true);
    try {
      const rsp = await fetchAnalysisCallsignGraph({ ...analysisReq, nolimit: callsignGraphNolimit });
      if (requestId !== callsignGraphRequestRef.current) return;
      setCallsignGraph(rsp);
    } catch (loadError) {
      if (requestId !== callsignGraphRequestRef.current) return;
      if (!onUnauthorized(loadError)) onError(toErrorMessage(loadError));
    } finally {
      if (requestId !== callsignGraphRequestRef.current) return;
      setCallsignGraphLoading(false);
    }
  }, [callsignGraphNolimit, onError, onUnauthorized, optionsFreqValues, queryState]);

  const toggleCallsignGraphNolimit = useCallback(() => {
    invalidateCallsignGraph();
    setCallsignGraphNolimit((current) => !current);
  }, [invalidateCallsignGraph]);

  const loadGroupsActivity = useCallback(
    async (period?: AnalysisGroupsActivityPeriod) => {
      const analysisReq = buildAnalysisReq(queryState, optionsFreqValues);
      const firstFreq = queryState.freqsSelected[0];
      if (isNullOrUndefined(analysisReq) || !firstFreq) {
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
        const rsp = await fetchFreqActivityDaily({ freq: firstFreq, sinceDateInclusiveMs, tillDateInclusiveMs });
        setGroupsActivity(rsp);
        setGroupsActivityLoadedFreq(firstFreq);
        setGroupsActivityLoadedPeriod(nextPeriod);
      } catch (loadError) {
        if (!onUnauthorized(loadError)) onError(toErrorMessage(loadError));
      } finally {
        setGroupsActivityLoading(false);
      }
    },
    [groupsActivityPeriod, onError, onUnauthorized, optionsFreqValues, queryState],
  );

  const loadSummaryData = useCallback(async () => {
    const analysisReq = buildAnalysisReq(queryState, optionsFreqValues);
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
          await loadMissingCallsignInfos(callsignIds);
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
  }, [loadMissingCallsignInfos, onError, onUnauthorized, optionsFreqValues, queryState]);

  const loadTopSidebarData = useCallback(async () => {
    const analysisReq = buildAnalysisReq(queryState, optionsFreqValues);
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
      setTopCallsigns(topItems(callsignsRsp.callsigns, (item) => item.callsign, (item) => item.count));
      setTopUnits(topItems(unitsRsp.units, (item) => item.unit, (item) => item.count));
      setTopLocations(topItems(locationsRsp.locations, (item) => item.location, (item) => item.count));

      const callsignIds = callsignsRsp.callsigns.map((item) => item.callsign);
      if (callsignIds.length > 0) {
        await loadMissingCallsignInfos(callsignIds);
        if (requestId !== rightSidebarRequestRef.current) return;
      }
    } catch (loadError) {
      if (requestId !== rightSidebarRequestRef.current) return;
      rightSidebarRequestKeyRef.current = null;
      if (!onUnauthorized(loadError)) onError(toErrorMessage(loadError));
    } finally {
      if (requestId === rightSidebarRequestRef.current) setRightSidebarLoading(false);
    }
  }, [loadMissingCallsignInfos, onError, onUnauthorized, optionsFreqValues, queryState]);

  const downloadSummaryXlsx = useCallback(async () => {
    const analysisReq = buildAnalysisReq(queryState, optionsFreqValues);
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
  }, [onError, onUnauthorized, optionsFreqValues, queryState]);

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

  const loadNewCallsigns = useLoadNewCallsigns({
    onError,
    onUnauthorized,
    optionsFreqValues,
    queryState,
    setNewCallsigns,
    setNewCallsignsLoading,
    newCallsignsRequestRef,
    newCallsignsLoadedKeyRef,
    newCallsignsPendingKeyRef,
  });

  const setNewCallsignsLoadedKey = useCallback((key: string | null) => {
    newCallsignsLoadedKeyRef.current = key;
  }, []);

  return {
    correlatedFreqs,
    correlatedFreqsLoading,
    callsignGraph,
    callsignGraphLoading,
    callsignGraphLoadVersion,
    callsignGraphNolimit,
    groupsActivity,
    groupsActivityLoadedFreq,
    groupsActivityLoadedPeriod,
    groupsActivityLoading,
    groupsActivityPeriod,
    summaryLoading,
    summaryLoaded,
    summaryHasLoadedOnce,
    summaryRows,
    rightSidebarLoading,
    topCallsigns,
    topFreqs,
    topLocations,
    topUnits,
    newCallsigns,
    newCallsignsLoading,
    correlatedFreqsRequestRef,
    callsignGraphRequestRef,
    newCallsignsRequestRef,
    newCallsignsLoadedKeyRef,
    newCallsignsPendingKeyRef,
    invalidateCorrelatedFreqsCache,
    invalidateCallsignGraph,
    invalidateSummaryData,
    invalidateRightSidebarData,
    loadCorrelatedFreqs,
    loadCallsignGraph,
    toggleCallsignGraphNolimit,
    loadGroupsActivity,
    loadSummaryData,
    loadTopSidebarData,
    loadNewCallsigns,
    downloadGeojson,
    downloadKmz,
    downloadSummaryXlsx,
    setCallsignGraph,
    setCallsignGraphLoading,
    setCallsignGraphLoadVersion,
    setCallsignGraphNolimit,
    setCorrelatedFreqs,
    setCorrelatedFreqsLoading,
    setGroupsActivity,
    setGroupsActivityLoadedFreq,
    setGroupsActivityLoadedPeriod,
    setGroupsActivityLoading,
    setGroupsActivityPeriod,
    setSummaryLoading,
    setSummaryLoaded,
    setSummaryHasLoadedOnce,
    setSummaryRows,
    setRightSidebarLoading,
    setTopCallsigns,
    setTopFreqs,
    setTopLocations,
    setTopUnits,
    setNewCallsigns,
    setNewCallsignsLoading,
    setNewCallsignsLoadedKey,
  };
}
