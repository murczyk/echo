import type { InboxMessage, Network, NewCallsignsRes, Unit } from '../../../../Bindings';
import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { isNullOrUndefined } from '../../utils/misc';

import { fetchAnalysisNewCallsigns, fetchNetworksByIds } from '../../services/api/analysis';
import { isAbortError } from '../../services/api/client';
import { unitCatalogRevision } from '../../services/unit-catalog-events';
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

export function shouldSkipNewCallsignsLoad(
  loadedKey: string | null,
  pendingKey: string | null,
  requestKey: string,
): boolean {
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
  newCallsignsAbortControllerRef: MutableRefObject<AbortController | null>;
};

export function invalidateNewCallsignsLoadState({
  setNewCallsigns,
  setNewCallsignsLoading,
  newCallsignsRequestRef,
  newCallsignsLoadedKeyRef,
  newCallsignsPendingKeyRef,
}: Pick<
  UseLoadNewCallsignsParams,
  | 'setNewCallsigns'
  | 'setNewCallsignsLoading'
  | 'newCallsignsRequestRef'
  | 'newCallsignsLoadedKeyRef'
  | 'newCallsignsPendingKeyRef'
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
  newCallsignsAbortControllerRef,
}: UseLoadNewCallsignsParams) {
  return useCallback(async () => {
    const analysisReq = buildAnalysisReq(queryState, optionsFreqValues);
    if (isNullOrUndefined(analysisReq)) {
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
    if (
      shouldSkipNewCallsignsLoad(
        newCallsignsLoadedKeyRef.current,
        newCallsignsPendingKeyRef.current,
        requestKey,
      )
    ) {
      return;
    }

    const requestId = newCallsignsRequestRef.current + 1;
    newCallsignsRequestRef.current = requestId;
    newCallsignsPendingKeyRef.current = requestKey;
    newCallsignsAbortControllerRef.current?.abort();
    const abortController = new AbortController();
    newCallsignsAbortControllerRef.current = abortController;
    setNewCallsignsLoading(true);
    setNewCallsigns(emptyNewCallsigns);
    onError('');

    try {
      const newCallsignsRsp = await fetchAnalysisNewCallsigns(analysisReq, {
        signal: abortController.signal,
      });
      if (requestId !== newCallsignsRequestRef.current || abortController.signal.aborted) return;
      setNewCallsigns(newCallsignsRsp);
      newCallsignsLoadedKeyRef.current = requestKey;
    } catch (loadError) {
      if (
        requestId !== newCallsignsRequestRef.current ||
        abortController.signal.aborted ||
        isAbortError(loadError)
      )
        return;
      if (!onUnauthorized(loadError)) {
        onError(toErrorMessage(loadError));
      }
    } finally {
      if (requestId === newCallsignsRequestRef.current && !abortController.signal.aborted) {
        newCallsignsPendingKeyRef.current = null;
        setNewCallsignsLoading(false);
      }
      if (newCallsignsAbortControllerRef.current === abortController) {
        newCallsignsAbortControllerRef.current = null;
      }
    }
  }, [
    newCallsignsAbortControllerRef,
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
  scopeKey: string;
  loadUnitsByIds: typeof import('../../services/api/units').getUnitsByIds;
  setUnitsMap: Dispatch<SetStateAction<Record<number, Unit>>>;
  hideNetworks: boolean;
  networksRef: MutableRefObject<Network[]>;
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  setNetworkDisplayMap: (value: Record<number, string>) => void;
  setNetworks: Dispatch<SetStateAction<Network[]>>;
  unitsMap: Record<number, Unit>;
};

export function useLoadMissingNetworksForMessages({
  scopeKey,
  loadUnitsByIds,
  setUnitsMap,
  hideNetworks,
  networksRef,
  onError,
  onUnauthorized,
  setNetworkDisplayMap,
  setNetworks,
  unitsMap,
}: UseLoadMissingNetworksParams) {
  const currentScope = useRef({ key: scopeKey });
  if (currentScope.current.key !== scopeKey) currentScope.current = { key: scopeKey };
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      currentScope.current = { key: currentScope.current.key };
    };
  }, []);
  return useCallback(
    async (messageItems: Array<[number, InboxMessage]>) => {
      const revision = unitCatalogRevision();
      const scope = currentScope.current;
      const isStale = () =>
        !mounted.current ||
        currentScope.current !== scope ||
        scope.key !== scopeKey ||
        revision !== unitCatalogRevision();
      const existingNetworkIds = new Set(networksRef.current.map((network) => network.id));
      const missingNetworkIds = hideNetworks
        ? []
        : Array.from(
            new Set(messageItems.flatMap(([, message]) => message.networkIds ?? [])),
          ).filter((networkId) => !existingNetworkIds.has(networkId));
      try {
        const loadedNetworks =
          missingNetworkIds.length > 0 ? await fetchNetworksByIds(missingNetworkIds) : [];
        if (isStale()) return;
        const unitIds = [
          ...new Set([
            ...messageItems.flatMap(([, message]) => message.unitIds ?? []),
            ...loadedNetworks.flatMap((network) => network.unitIds ?? []),
          ]),
        ];
        const loadedUnits = await loadUnitsByIds(unitIds);
        if (isStale()) return;
        const loadedUnitsMap = Object.fromEntries(loadedUnits.map((unit) => [unit.id, unit]));
        const nextUnitsMap = { ...unitsMap, ...loadedUnitsMap };
        if (loadedUnits.some((unit) => unitsMap[unit.id] !== unit)) {
          setUnitsMap((current) => (isStale() ? current : { ...current, ...loadedUnitsMap }));
        }
        if (loadedNetworks.length === 0) return;
        setNetworks((currentNetworks) => {
          if (isStale()) return currentNetworks;
          const mergedNetworks = mergeNetworksById(currentNetworks, loadedNetworks);
          setNetworkDisplayMap(buildNetworkDisplayMap(mergedNetworks, nextUnitsMap));
          return mergedNetworks;
        });
      } catch (loadError) {
        if (isStale() || isAbortError(loadError)) return;
        if (!onUnauthorized(loadError)) {
          onError(toErrorMessage(loadError));
        }
      }
    },
    [
      scopeKey,
      hideNetworks,
      loadUnitsByIds,
      networksRef,
      onError,
      onUnauthorized,
      setNetworkDisplayMap,
      setNetworks,
      setUnitsMap,
      unitsMap,
    ],
  );
}
