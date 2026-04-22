import type { InboxMessage, Network, NewCallsignsRes, Unit } from '../../../../Bindings';
import { useCallback } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import { fetchAnalysisNewCallsigns, fetchNetworksByIds } from '../../services/api/analysis';
import { buildAnalysisReq } from './helpers';
import { buildNetworkDisplayMap } from './message-utils';
import { emptyNewCallsigns, toErrorMessage } from './use-analysis-data.shared';
import type { AnalysisQueryState } from './types';

export function mergeNetworksById(existing: Network[], loaded: Network[]): Network[] {
  const merged = new Map<number, Network>();
  existing.forEach((network) => {
    merged.set(network.id, network);
  });
  loaded.forEach((network) => {
    merged.set(network.id, network);
  });
  return Array.from(merged.values());
}

export function shouldSkipNewCallsignsLoad(loadedKey: string | null, pendingKey: string | null, requestKey: string): boolean {
  return loadedKey === requestKey || pendingKey === requestKey;
}

type UseLoadNewCallsignsParams = {
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  optionsFreqValues: string[];
  queryState: AnalysisQueryState;
  setNewCallsigns: (value: NewCallsignsRes) => void;
  setNewCallsignsLoading: (value: boolean) => void;
  newCallsignsRequestRef: MutableRefObject<number>;
  newCallsignsLoadedKeyRef: MutableRefObject<string | null>;
  newCallsignsPendingKeyRef: MutableRefObject<string | null>;
};

export function invalidateNewCallsignsLoadState({
  setNewCallsigns,
  setNewCallsignsLoading,
  newCallsignsRequestRef,
  newCallsignsLoadedKeyRef,
  newCallsignsPendingKeyRef,
}: Pick<
  UseLoadNewCallsignsParams,
  'setNewCallsigns' | 'setNewCallsignsLoading' | 'newCallsignsRequestRef' | 'newCallsignsLoadedKeyRef' | 'newCallsignsPendingKeyRef'
>) {
  setNewCallsigns(emptyNewCallsigns);
  setNewCallsignsLoading(false);
  newCallsignsLoadedKeyRef.current = null;
  newCallsignsPendingKeyRef.current = null;
  newCallsignsRequestRef.current += 1;
}

export function useLoadNewCallsigns({
  onError,
  onUnauthorized,
  optionsFreqValues,
  queryState,
  setNewCallsigns,
  setNewCallsignsLoading,
  newCallsignsRequestRef,
  newCallsignsLoadedKeyRef,
  newCallsignsPendingKeyRef,
}: UseLoadNewCallsignsParams) {
  return useCallback(async () => {
    const analysisReq = buildAnalysisReq(queryState, optionsFreqValues);
    if (analysisReq == null) {
      invalidateNewCallsignsLoadState({
        setNewCallsigns,
        setNewCallsignsLoading,
        newCallsignsRequestRef,
        newCallsignsLoadedKeyRef,
        newCallsignsPendingKeyRef,
      });
      return;
    }

    const requestKey = JSON.stringify(analysisReq);
    if (shouldSkipNewCallsignsLoad(newCallsignsLoadedKeyRef.current, newCallsignsPendingKeyRef.current, requestKey)) {
      return;
    }

    const requestId = newCallsignsRequestRef.current + 1;
    newCallsignsRequestRef.current = requestId;
    newCallsignsPendingKeyRef.current = requestKey;
    setNewCallsignsLoading(true);
    setNewCallsigns(emptyNewCallsigns);
    onError('');

    try {
      const newCallsignsRsp = await fetchAnalysisNewCallsigns(analysisReq);
      if (requestId !== newCallsignsRequestRef.current) return;
      setNewCallsigns(newCallsignsRsp);
      newCallsignsLoadedKeyRef.current = requestKey;
    } catch (loadError) {
      if (requestId !== newCallsignsRequestRef.current) return;
      if (!onUnauthorized(loadError)) {
        onError(toErrorMessage(loadError));
      }
    } finally {
      if (requestId === newCallsignsRequestRef.current) {
        newCallsignsPendingKeyRef.current = null;
        setNewCallsignsLoading(false);
      }
    }
  }, [
    newCallsignsLoadedKeyRef,
    newCallsignsPendingKeyRef,
    newCallsignsRequestRef,
    onError,
    onUnauthorized,
    optionsFreqValues,
    queryState,
    setNewCallsigns,
    setNewCallsignsLoading,
  ]);
}

type UseLoadMissingNetworksParams = {
  networksRef: MutableRefObject<Network[]>;
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  setNetworkDisplayMap: (value: Record<number, string>) => void;
  setNetworks: Dispatch<SetStateAction<Network[]>>;
  unitsMap: Record<number, Unit>;
};

export function useLoadMissingNetworksForMessages({
  networksRef,
  onError,
  onUnauthorized,
  setNetworkDisplayMap,
  setNetworks,
  unitsMap,
}: UseLoadMissingNetworksParams) {
  return useCallback(
    async (messageItems: Array<[number, InboxMessage]>) => {
      const existingNetworkIds = new Set(networksRef.current.map((network) => network.id));
      const missingNetworkIds = Array.from(new Set(messageItems.flatMap(([, message]) => message.networkIds ?? []))).filter(
        (networkId) => !existingNetworkIds.has(networkId),
      );
      if (missingNetworkIds.length === 0) return;

      try {
        const loadedNetworks = await fetchNetworksByIds(missingNetworkIds);
        if (loadedNetworks.length === 0) return;
        setNetworks((currentNetworks) => {
          const mergedNetworks = mergeNetworksById(currentNetworks, loadedNetworks);
          setNetworkDisplayMap(buildNetworkDisplayMap(mergedNetworks, unitsMap));
          return mergedNetworks;
        });
      } catch (loadError) {
        if (!onUnauthorized(loadError)) {
          onError(toErrorMessage(loadError));
        }
      }
    },
    [networksRef, onError, onUnauthorized, setNetworkDisplayMap, setNetworks, unitsMap],
  );
}
