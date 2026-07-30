import { useCallback, useEffect, useRef, useState } from 'react';

import type { CorrelatedFreq, NetworkCallsignRelationsRsp } from '../../../../Bindings';
import {
  fetchAnalysisCallsignRelations,
  fetchAnalysisCorrelatedFreqs,
} from '../../services/api/analysis';
import { isAbortError } from '../../services/api/client';
import { isNullOrUndefined } from '../../utils/misc';
import { buildAnalysisReq } from './helpers';
import { toErrorMessage } from './use-analysis-data.shared';
import type { AnalysisQueryState } from './types';

type Params = {
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  optionsFreqValues: string[];
  queryState: AnalysisQueryState;
};

export type InvalidateCallsignGraphOptions = {
  clearGraph?: boolean;
};

export function useAnalysisGraphData({
  onError,
  onUnauthorized,
  optionsFreqValues,
  queryState,
}: Params) {
  const [correlatedFreqs, setCorrelatedFreqs] = useState<CorrelatedFreq[]>([]);
  const [correlatedFreqsLoaded, setCorrelatedFreqsLoaded] = useState(false);
  const [correlatedFreqsLoading, setCorrelatedFreqsLoading] = useState(false);
  const [callsignGraph, setCallsignGraph] = useState<NetworkCallsignRelationsRsp | null>(null);
  const [callsignGraphLoading, setCallsignGraphLoading] = useState(false);
  const [callsignGraphLoadVersion, setCallsignGraphLoadVersion] = useState(0);
  const [callsignGraphLoadError, setCallsignGraphLoadError] = useState<string | null>(null);

  const correlatedFreqsRequestRef = useRef(0);
  const correlatedFreqsRequestKeyRef = useRef<string | null>(null);
  const callsignGraphRequestRef = useRef(0);
  const correlatedFreqsAbortControllerRef = useRef<AbortController | null>(null);
  const callsignGraphAbortControllerRef = useRef<AbortController | null>(null);

  const invalidateCorrelatedFreqsCache = useCallback(() => {
    correlatedFreqsAbortControllerRef.current?.abort();
    correlatedFreqsAbortControllerRef.current = null;
    correlatedFreqsRequestRef.current += 1;
    correlatedFreqsRequestKeyRef.current = null;
    setCorrelatedFreqsLoaded(false);
    setCorrelatedFreqsLoading(false);
  }, []);

  const invalidateCallsignGraph = useCallback((options?: InvalidateCallsignGraphOptions) => {
    callsignGraphAbortControllerRef.current?.abort();
    callsignGraphRequestRef.current += 1;
    if (options?.clearGraph) {
      setCallsignGraph(null);
    }
    setCallsignGraphLoading(false);
    setCallsignGraphLoadError(null);
    setCallsignGraphLoadVersion((current) => current + 1);
  }, []);

  const loadCorrelatedFreqs = useCallback(async () => {
    const analysisReq = buildAnalysisReq(queryState, optionsFreqValues);
    if (isNullOrUndefined(analysisReq) || queryState.freqsSelected.length === 0) {
      correlatedFreqsAbortControllerRef.current?.abort();
      correlatedFreqsAbortControllerRef.current = null;
      correlatedFreqsRequestRef.current += 1;
      correlatedFreqsRequestKeyRef.current = null;
      setCorrelatedFreqs([]);
      setCorrelatedFreqsLoaded(false);
      setCorrelatedFreqsLoading(false);
      return;
    }

    const requestKey = JSON.stringify(analysisReq);
    if (correlatedFreqsRequestKeyRef.current === requestKey) return;

    correlatedFreqsAbortControllerRef.current?.abort();
    const abortController = new AbortController();
    correlatedFreqsAbortControllerRef.current = abortController;
    const requestId = correlatedFreqsRequestRef.current + 1;
    correlatedFreqsRequestRef.current = requestId;
    correlatedFreqsRequestKeyRef.current = requestKey;
    setCorrelatedFreqsLoaded(false);
    setCorrelatedFreqsLoading(true);
    try {
      const rsp = await fetchAnalysisCorrelatedFreqs(analysisReq, {
        signal: abortController.signal,
      });
      if (requestId !== correlatedFreqsRequestRef.current || abortController.signal.aborted) return;
      setCorrelatedFreqs(rsp.freqs ?? []);
      setCorrelatedFreqsLoaded(true);
    } catch (loadError) {
      if (
        requestId !== correlatedFreqsRequestRef.current ||
        abortController.signal.aborted ||
        isAbortError(loadError)
      )
        return;
      correlatedFreqsRequestKeyRef.current = null;
      if (!onUnauthorized(loadError)) onError(toErrorMessage(loadError));
    } finally {
      if (requestId !== correlatedFreqsRequestRef.current || abortController.signal.aborted) return;
      setCorrelatedFreqsLoading(false);
      if (correlatedFreqsAbortControllerRef.current === abortController) {
        correlatedFreqsAbortControllerRef.current = null;
      }
    }
  }, [onError, onUnauthorized, optionsFreqValues, queryState]);

  const loadCallsignGraph = useCallback(async () => {
    const analysisReq = buildAnalysisReq(queryState, optionsFreqValues);
    if (isNullOrUndefined(analysisReq)) return;

    callsignGraphAbortControllerRef.current?.abort();
    const abortController = new AbortController();
    callsignGraphAbortControllerRef.current = abortController;
    const requestId = callsignGraphRequestRef.current + 1;
    callsignGraphRequestRef.current = requestId;
    setCallsignGraphLoading(true);
    setCallsignGraphLoadError(null);
    try {
      const rsp = await fetchAnalysisCallsignRelations(analysisReq, {
        signal: abortController.signal,
      });
      if (requestId !== callsignGraphRequestRef.current || abortController.signal.aborted) return;
      setCallsignGraph(rsp);
      setCallsignGraphLoadError(null);
    } catch (loadError) {
      if (
        requestId !== callsignGraphRequestRef.current ||
        abortController.signal.aborted ||
        isAbortError(loadError)
      )
        return;
      const errorMessage = toErrorMessage(loadError);
      setCallsignGraphLoadError(errorMessage);
      if (!onUnauthorized(loadError)) onError(errorMessage);
    } finally {
      if (requestId !== callsignGraphRequestRef.current || abortController.signal.aborted) return;
      setCallsignGraphLoading(false);
      if (callsignGraphAbortControllerRef.current === abortController) {
        callsignGraphAbortControllerRef.current = null;
      }
    }
  }, [onError, onUnauthorized, optionsFreqValues, queryState]);

  useEffect(() => {
    return () => {
      correlatedFreqsAbortControllerRef.current?.abort();
      correlatedFreqsAbortControllerRef.current = null;
      callsignGraphAbortControllerRef.current?.abort();
      callsignGraphAbortControllerRef.current = null;
    };
  }, []);

  return {
    correlatedFreqs,
    correlatedFreqsLoaded,
    correlatedFreqsLoading,
    callsignGraph,
    callsignGraphLoading,
    callsignGraphLoadVersion,
    callsignGraphLoadError,
    correlatedFreqsRequestRef,
    correlatedFreqsRequestKeyRef,
    callsignGraphRequestRef,
    invalidateCorrelatedFreqsCache,
    invalidateCallsignGraph,
    loadCorrelatedFreqs,
    loadCallsignGraph,
    setCallsignGraph,
    setCallsignGraphLoading,
    setCallsignGraphLoadVersion,
    setCorrelatedFreqs,
    setCorrelatedFreqsLoading,
  };
}
