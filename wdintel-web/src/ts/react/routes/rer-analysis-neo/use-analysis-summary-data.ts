import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

import type { CallsignInfoRes, SummaryTableFreqRow } from '../../../../Bindings';
import { downloadAnalysisSummaryTableXlsx, fetchAnalysisCallsignInfos, fetchAnalysisSummaryTable } from '../../services/api/analysis';
import { isAbortError } from '../../services/api/client';
import { downloadBlob } from '../../utils/download-blob';
import { isNullOrUndefined } from '../../utils/misc';
import { buildAnalysisReq } from './helpers';
import { normalizeCallsignLookupValue } from '../../utils/callsign-normalization';
import { mergeAnalysisCallsignInfoMap } from './use-analysis-data.callsigns';
import { toErrorMessage } from './use-analysis-data.shared';
import type { AnalysisQueryState } from './types';
import type { Setter } from './use-analysis-sidebar-data.types';

type Params = {
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  optionsFreqValues: string[];
  queryState: AnalysisQueryState;
  summaryCallsignsInfoRef: MutableRefObject<Record<string, CallsignInfoRes>>;
  setSummaryCallsignsInfo: Setter<Record<string, CallsignInfoRes>>;
};

export function useAnalysisSummaryData({
  onError,
  onUnauthorized,
  optionsFreqValues,
  queryState,
  summaryCallsignsInfoRef,
  setSummaryCallsignsInfo,
}: Params) {
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryLoaded, setSummaryLoaded] = useState(false);
  const [summaryHasLoadedOnce, setSummaryHasLoadedOnce] = useState(false);
  const [summaryRows, setSummaryRows] = useState<SummaryTableFreqRow[]>([]);

  const summaryRequestRef = useRef(0);
  const summaryRequestKeyRef = useRef<string | null>(null);
  const pendingCallsignInfoKeysRef = useRef(new Set<string>());
  const summaryAbortControllerRef = useRef<AbortController | null>(null);

  const loadMissingCallsignInfos = useCallback(
    async (callsigns: string[], signal?: AbortSignal) => {
      const missingCallsigns: string[] = [];
      const seenKeys = new Set<string>();
      const requestOptions = signal ? { signal } : undefined;

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
        const callsignInfos = await fetchAnalysisCallsignInfos(missingCallsigns, requestOptions);
        if (signal?.aborted) return;
        setSummaryCallsignsInfo((current) => mergeAnalysisCallsignInfoMap(current, callsignInfos));
      } finally {
        missingCallsigns.forEach((callsign) => {
          pendingCallsignInfoKeysRef.current.delete(normalizeCallsignLookupValue(callsign));
        });
      }
    },
    [setSummaryCallsignsInfo, summaryCallsignsInfoRef],
  );

  const invalidateSummaryData = useCallback(
    (keepLoading = false) => {
      summaryAbortControllerRef.current?.abort();
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

    summaryAbortControllerRef.current?.abort();
    const abortController = new AbortController();
    summaryAbortControllerRef.current = abortController;
    const requestId = summaryRequestRef.current + 1;
    summaryRequestRef.current = requestId;
    summaryRequestKeyRef.current = requestKey;
    setSummaryLoaded(false);
    setSummaryLoading(true);

    try {
      const rsp = await fetchAnalysisSummaryTable(analysisReq, { signal: abortController.signal });
      if (requestId !== summaryRequestRef.current || abortController.signal.aborted) return;
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
          await loadMissingCallsignInfos(callsignIds, abortController.signal);
        } catch (loadError) {
          if (requestId !== summaryRequestRef.current || abortController.signal.aborted || isAbortError(loadError)) return;
          summaryRequestKeyRef.current = null;
          if (!onUnauthorized(loadError)) onError(toErrorMessage(loadError));
        }
        if (requestId !== summaryRequestRef.current || abortController.signal.aborted) return;
      }
    } catch (loadError) {
      if (requestId !== summaryRequestRef.current || abortController.signal.aborted || isAbortError(loadError)) return;
      summaryRequestKeyRef.current = null;
      setSummaryRows([]);
      if (!onUnauthorized(loadError)) onError(toErrorMessage(loadError));
    } finally {
      if (requestId === summaryRequestRef.current && !abortController.signal.aborted) {
        setSummaryHasLoadedOnce(true);
        setSummaryLoaded(true);
        setSummaryLoading(false);
      }
      if (summaryAbortControllerRef.current === abortController) {
        summaryAbortControllerRef.current = null;
      }
    }
  }, [loadMissingCallsignInfos, onError, onUnauthorized, optionsFreqValues, queryState]);

  useEffect(() => {
    return () => {
      summaryAbortControllerRef.current?.abort();
      summaryAbortControllerRef.current = null;
    };
  }, []);

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

  return {
    summaryLoading,
    summaryLoaded,
    summaryHasLoadedOnce,
    summaryRows,
    summaryRequestRef,
    summaryRequestKeyRef,
    pendingCallsignInfoKeysRef,
    invalidateSummaryData,
    loadSummaryData,
    downloadSummaryXlsx,
    setSummaryLoading,
    setSummaryLoaded,
    setSummaryHasLoadedOnce,
    setSummaryRows,
  };
}
