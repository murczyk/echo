import { useCallback, useEffect, useRef, useState } from 'react';

import type { AnalysisCountItem } from './types';
import type { NewCallsignsRes } from '../../../../Bindings';
import {
  fetchAnalysisCallsigns,
  fetchAnalysisLocations,
  fetchAnalysisUnits,
} from '../../services/api/analysis';
import { isAbortError } from '../../services/api/client';
import { isNullOrUndefined } from '../../utils/misc';
import { buildAnalysisReq } from './helpers';
import { emptyNewCallsigns, toErrorMessage, topItems } from './use-analysis-data.shared';
import { useLoadNewCallsigns } from './use-analysis-data.support';
import type { AnalysisQueryState } from './types';

type Params = {
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  optionsFreqValues: string[];
  queryState: AnalysisQueryState;
};

export function useAnalysisTopSidebarData({
  onError,
  onUnauthorized,
  optionsFreqValues,
  queryState,
}: Params) {
  const [rightSidebarLoading, setRightSidebarLoading] = useState(false);
  const [topFreqs, setTopFreqs] = useState<AnalysisCountItem[]>([]);
  const [topCallsigns, setTopCallsigns] = useState<AnalysisCountItem[]>([]);
  const [topUnits, setTopUnits] = useState<AnalysisCountItem[]>([]);
  const [topLocations, setTopLocations] = useState<AnalysisCountItem[]>([]);
  const [newCallsigns, setNewCallsigns] = useState<NewCallsignsRes>(emptyNewCallsigns);
  const [newCallsignsLoading, setNewCallsignsLoading] = useState(false);

  const rightSidebarRequestRef = useRef(0);
  const rightSidebarRequestKeyRef = useRef<string | null>(null);
  const rightSidebarAbortControllerRef = useRef<AbortController | null>(null);
  const newCallsignsRequestRef = useRef(0);
  const newCallsignsLoadedKeyRef = useRef<string | null>(null);
  const newCallsignsPendingKeyRef = useRef<string | null>(null);
  const newCallsignsAbortControllerRef = useRef<AbortController | null>(null);

  const invalidateRightSidebarData = useCallback(() => {
    rightSidebarAbortControllerRef.current?.abort();
    rightSidebarRequestRef.current += 1;
    rightSidebarRequestKeyRef.current = null;
    setRightSidebarLoading(false);
    setTopCallsigns([]);
    setTopLocations([]);
    setTopUnits([]);
  }, [setRightSidebarLoading, setTopCallsigns, setTopLocations, setTopUnits]);

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

    rightSidebarAbortControllerRef.current?.abort();
    const abortController = new AbortController();
    rightSidebarAbortControllerRef.current = abortController;
    const requestId = rightSidebarRequestRef.current + 1;
    rightSidebarRequestRef.current = requestId;
    rightSidebarRequestKeyRef.current = requestKey;
    setRightSidebarLoading(true);

    try {
      const [callsignsRsp, unitsRsp, locationsRsp] = await Promise.all([
        fetchAnalysisCallsigns(analysisReq, { signal: abortController.signal }),
        fetchAnalysisUnits(analysisReq, { signal: abortController.signal }),
        fetchAnalysisLocations(analysisReq, { signal: abortController.signal }),
      ]);
      if (requestId !== rightSidebarRequestRef.current || abortController.signal.aborted) return;
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
          (item) => item.unit,
          (item) => item.count,
        ),
      );
      setTopLocations(
        topItems(
          locationsRsp.locations,
          (item) => item.location,
          (item) => item.count,
        ),
      );
    } catch (loadError) {
      if (
        requestId !== rightSidebarRequestRef.current ||
        abortController.signal.aborted ||
        isAbortError(loadError)
      )
        return;
      rightSidebarRequestKeyRef.current = null;
      if (!onUnauthorized(loadError)) onError(toErrorMessage(loadError));
    } finally {
      if (requestId === rightSidebarRequestRef.current && !abortController.signal.aborted)
        setRightSidebarLoading(false);
      if (rightSidebarAbortControllerRef.current === abortController) {
        rightSidebarAbortControllerRef.current = null;
      }
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
    newCallsignsAbortControllerRef,
  });

  const setNewCallsignsLoadedKey = useCallback((key: string | null) => {
    newCallsignsLoadedKeyRef.current = key;
  }, []);

  useEffect(() => {
    return () => {
      rightSidebarAbortControllerRef.current?.abort();
      rightSidebarAbortControllerRef.current = null;
      newCallsignsAbortControllerRef.current?.abort();
      newCallsignsAbortControllerRef.current = null;
    };
  }, []);

  return {
    rightSidebarLoading,
    topFreqs,
    topCallsigns,
    topUnits,
    topLocations,
    rightSidebarRequestRef,
    rightSidebarRequestKeyRef,
    newCallsigns,
    newCallsignsLoading,
    newCallsignsRequestRef,
    newCallsignsLoadedKeyRef,
    newCallsignsPendingKeyRef,
    invalidateRightSidebarData,
    loadTopSidebarData,
    loadNewCallsigns,
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
