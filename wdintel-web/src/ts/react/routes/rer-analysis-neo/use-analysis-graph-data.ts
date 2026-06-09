import { useCallback, useRef, useState } from 'react';

import type { CorrelatedFreq, NetJsonGraphAndMeta } from '../../../../Bindings';
import { fetchAnalysisCallsignGraph, fetchAnalysisCorrelatedFreqs } from '../../services/api/analysis';
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

export function useAnalysisGraphData({ onError, onUnauthorized, optionsFreqValues, queryState }: Params) {
  const [correlatedFreqs, setCorrelatedFreqs] = useState<CorrelatedFreq[]>([]);
  const [correlatedFreqsLoading, setCorrelatedFreqsLoading] = useState(false);
  const [callsignGraph, setCallsignGraph] = useState<NetJsonGraphAndMeta | null>(null);
  const [callsignGraphLoading, setCallsignGraphLoading] = useState(false);
  const [callsignGraphLoadVersion, setCallsignGraphLoadVersion] = useState(0);
  const [callsignGraphNolimit, setCallsignGraphNolimit] = useState(false);

  const correlatedFreqsRequestRef = useRef(0);
  const correlatedFreqsRequestKeyRef = useRef<string | null>(null);
  const callsignGraphRequestRef = useRef(0);

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

  return {
    correlatedFreqs,
    correlatedFreqsLoading,
    callsignGraph,
    callsignGraphLoading,
    callsignGraphLoadVersion,
    callsignGraphNolimit,
    correlatedFreqsRequestRef,
    correlatedFreqsRequestKeyRef,
    callsignGraphRequestRef,
    invalidateCorrelatedFreqsCache,
    invalidateCallsignGraph,
    loadCorrelatedFreqs,
    loadCallsignGraph,
    toggleCallsignGraphNolimit,
    setCallsignGraph,
    setCallsignGraphLoading,
    setCallsignGraphLoadVersion,
    setCallsignGraphNolimit,
    setCorrelatedFreqs,
    setCorrelatedFreqsLoading,
  };
}
