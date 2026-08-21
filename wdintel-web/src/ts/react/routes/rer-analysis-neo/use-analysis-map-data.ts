import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  FreqDetailedPoint,
  InboxMessage,
  MapSettlement,
  NetworkUnit,
  PalitraReadV2,
} from '../../../../Bindings';
import {
  fetchAnalysisMapPoints,
  fetchMapSettlementMessages,
  fetchMessagesByIds,
} from '../../services/api/analysis';
import { isAbortError } from '../../services/api/client';
import { listMapPalitrasV2 } from '../../services/api/palitra';
import { isNullOrUndefined } from '../../utils/misc';
import { primeCoordinatePreviewPalitraIds } from '../shared/message-card/message-coordinate-preview';
import {
  missingMapMessageIds,
  normalizeMapMessageIds,
  removeMapPointsForMissingMessages,
} from './analysis-map-message-access';
import { ANALYSIS_SESSION_ACTIVITY_PAGE_ID, buildInboxReq } from './helpers';
import { buildMapAttrs } from './helpers-map';
import { toErrorMessage } from './use-analysis-data.shared';
import type { AnalysisMapAttrs, AnalysisPalitrasLoadState, AnalysisQueryState } from './types';

type Params = {
  loadMissingNetworksForMessages: (messageItems: Array<[number, InboxMessage]>) => Promise<void>;
  newestFirst: boolean;
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  optionsFreqValues: string[];
  queryState: AnalysisQueryState;
  canShowSettlements: boolean;
};

export type UseAnalysisMapDataResult = {
  mapLoading: boolean;
  mapDateRange: { startDate: number; endDate: number };
  mapPoints: FreqDetailedPoint[];
  mapNetworkUnits: NetworkUnit[];
  mapSettlements: MapSettlement[];
  showSettlements: boolean;
  mapOpenMessages: Array<[number, InboxMessage]>;
  settlementMessagesHasMore: boolean;
  mapPalitras: PalitraReadV2[];
  mapPalitrasLoaded: boolean;
  mapPalitrasLoadState: AnalysisPalitrasLoadState;
  mapMessagesLoadVersionRef: React.MutableRefObject<number>;
  mapDateRangeLoadVersionRef: React.MutableRefObject<number>;
  mapAttrs: AnalysisMapAttrs;
  refreshMapDateRange: (range: { startDate: number; endDate: number }) => Promise<void>;
  loadMessagesForMap: (messageIds: number[]) => Promise<boolean>;
  loadSettlementMessagesForMap: (
    settlementId: number,
    beforeIdNoninclusive?: number | null,
  ) => Promise<boolean>;
  loadMapPalitras: () => Promise<void>;
  setMapLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setMapDateRange: React.Dispatch<React.SetStateAction<{ startDate: number; endDate: number }>>;
  setMapPoints: React.Dispatch<React.SetStateAction<FreqDetailedPoint[]>>;
  setMapNetworkUnits: React.Dispatch<React.SetStateAction<NetworkUnit[]>>;
  applyMapSettlements: (settlements: MapSettlement[], requestedShowSettlements: boolean) => void;
  setShowSettlements: (show: boolean) => Promise<void>;
  setMapOpenMessages: React.Dispatch<React.SetStateAction<Array<[number, InboxMessage]>>>;
  setMapPalitras: React.Dispatch<React.SetStateAction<PalitraReadV2[]>>;
  setMapPalitrasLoaded: React.Dispatch<React.SetStateAction<boolean>>;
  setMapPalitrasLoadState: React.Dispatch<React.SetStateAction<AnalysisPalitrasLoadState>>;
};

export function useAnalysisMapData({
  loadMissingNetworksForMessages,
  newestFirst,
  onError,
  onUnauthorized,
  optionsFreqValues,
  queryState,
  canShowSettlements,
}: Params): UseAnalysisMapDataResult {
  const [mapLoading, setMapLoading] = useState(false);
  const [mapDateRange, setMapDateRange] = useState({ startDate: 0, endDate: 0 });
  const [mapPoints, setMapPoints] = useState<FreqDetailedPoint[]>([]);
  const [mapNetworkUnits, setMapNetworkUnits] = useState<NetworkUnit[]>([]);
  const [mapSettlementsState, setMapSettlementsState] = useState<MapSettlement[]>([]);
  const [showSettlements, setShowSettlementsState] = useState(false);
  const [mapOpenMessages, setMapOpenMessages] = useState<Array<[number, InboxMessage]>>([]);
  const [settlementMessagesHasMore, setSettlementMessagesHasMore] = useState(false);
  const [mapPalitras, setMapPalitras] = useState<PalitraReadV2[]>([]);
  const [mapPalitrasLoaded, setMapPalitrasLoaded] = useState(false);
  const [mapPalitrasLoadState, setMapPalitrasLoadState] =
    useState<AnalysisPalitrasLoadState>('idle');
  const mapMessagesLoadVersionRef = useRef(0);
  const mapDateRangeLoadVersionRef = useRef(0);
  const showSettlementsRef = useRef(false);
  const settlementToggleAbortRef = useRef<AbortController | null>(null);
  const settlementToggleLoadVersionRef = useRef<number | null>(null);
  const resetMapMessageScope = useCallback(() => {
    mapMessagesLoadVersionRef.current += 1;
    setMapOpenMessages([]);
    setSettlementMessagesHasMore(false);
  }, []);
  const settlementQueryKey = JSON.stringify([queryState, optionsFreqValues]);
  const settlementQueryKeyRef = useRef(settlementQueryKey);
  settlementQueryKeyRef.current = settlementQueryKey;
  const applyMapSettlements = useCallback(
    (settlements: MapSettlement[], requestedShowSettlements: boolean) => {
      if (showSettlementsRef.current !== requestedShowSettlements) return;
      setMapSettlementsState(requestedShowSettlements ? settlements : []);
    },
    [],
  );

  const refreshMapDateRange = useCallback(
    async (range: { startDate: number; endDate: number }) => {
      const inboxReq = buildInboxReq(queryState, optionsFreqValues);
      if (isNullOrUndefined(inboxReq)) return;

      const loadVersion = mapDateRangeLoadVersionRef.current + 1;
      mapDateRangeLoadVersionRef.current = loadVersion;
      setMapLoading(true);
      setMapDateRange(range);
      resetMapMessageScope();
      const requestedShowSettlements = canShowSettlements && showSettlementsRef.current;
      if (requestedShowSettlements) setMapSettlementsState([]);

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
          showSettlements: requestedShowSettlements,
        });
        if (mapDateRangeLoadVersionRef.current !== loadVersion) return;
        setMapPoints(rsp.points ?? []);
        setMapNetworkUnits(rsp.networkUnits ?? []);
        applyMapSettlements(rsp.settlements ?? [], requestedShowSettlements);
      } catch (loadError) {
        if (mapDateRangeLoadVersionRef.current !== loadVersion) return;
        if (!onUnauthorized(loadError)) onError(toErrorMessage(loadError));
      } finally {
        if (mapDateRangeLoadVersionRef.current === loadVersion) setMapLoading(false);
      }
    },
    [
      canShowSettlements,
      newestFirst,
      onError,
      onUnauthorized,
      optionsFreqValues,
      queryState,
      applyMapSettlements,
      resetMapMessageScope,
    ],
  );

  const setShowSettlements = useCallback(
    async (show: boolean) => {
      const enabled = canShowSettlements && show;
      showSettlementsRef.current = enabled;
      setShowSettlementsState(enabled);
      resetMapMessageScope();
      if (!enabled) {
        const toggleLoadVersion = settlementToggleLoadVersionRef.current;
        settlementToggleAbortRef.current?.abort();
        settlementToggleAbortRef.current = null;
        settlementToggleLoadVersionRef.current = null;
        setMapSettlementsState([]);
        setSettlementMessagesHasMore(false);
        if (mapDateRangeLoadVersionRef.current === toggleLoadVersion) setMapLoading(false);
        return;
      }
      const inboxReq = buildInboxReq(queryState, optionsFreqValues);
      if (isNullOrUndefined(inboxReq)) return;
      const range = mapDateRange;
      const loadVersion = mapDateRangeLoadVersionRef.current + 1;
      mapDateRangeLoadVersionRef.current = loadVersion;
      const queryKey = settlementQueryKey;
      settlementToggleAbortRef.current?.abort();
      const abortController = new AbortController();
      settlementToggleAbortRef.current = abortController;
      settlementToggleLoadVersionRef.current = loadVersion;
      setMapLoading(true);
      try {
        const rsp = await fetchAnalysisMapPoints(
          {
            inboxItemsFilter:
              range.startDate > 0 && range.endDate > 0
                ? {
                    ...inboxReq,
                    sinceDateInclusiveMs: range.startDate,
                    tillDateInclusiveMs: range.endDate,
                    newestFirst,
                  }
                : inboxReq,
            mapFilter: null,
            pageId: ANALYSIS_SESSION_ACTIVITY_PAGE_ID,
            showSettlements: true,
          },
          { signal: abortController.signal },
        );
        if (
          mapDateRangeLoadVersionRef.current !== loadVersion ||
          !showSettlementsRef.current ||
          settlementQueryKeyRef.current !== queryKey
        )
          return;
        setMapPoints(rsp.points ?? []);
        setMapNetworkUnits(rsp.networkUnits ?? []);
        setMapSettlementsState(rsp.settlements ?? []);
      } catch (loadError) {
        if (mapDateRangeLoadVersionRef.current !== loadVersion || isAbortError(loadError)) return;
        setMapSettlementsState([]);
        if (!onUnauthorized(loadError)) onError(toErrorMessage(loadError));
      } finally {
        if (settlementToggleAbortRef.current === abortController) {
          settlementToggleAbortRef.current = null;
        }
        if (settlementToggleLoadVersionRef.current === loadVersion) {
          settlementToggleLoadVersionRef.current = null;
        }
        if (mapDateRangeLoadVersionRef.current === loadVersion) setMapLoading(false);
      }
    },
    [
      canShowSettlements,
      mapDateRange,
      newestFirst,
      onError,
      onUnauthorized,
      optionsFreqValues,
      queryState,
      resetMapMessageScope,
      settlementQueryKey,
    ],
  );

  useEffect(() => {
    settlementToggleAbortRef.current?.abort();
    mapDateRangeLoadVersionRef.current += 1;
    setMapSettlementsState([]);
    resetMapMessageScope();
  }, [resetMapMessageScope, settlementQueryKey]);

  useEffect(() => {
    return () => settlementToggleAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (canShowSettlements) return;
    showSettlementsRef.current = false;
    settlementToggleAbortRef.current?.abort();
    settlementToggleAbortRef.current = null;
    setShowSettlementsState(false);
    setMapSettlementsState([]);
    resetMapMessageScope();
  }, [canShowSettlements, resetMapMessageScope]);

  const loadMessagesForMap = useCallback(
    async (messageIds: number[]) => {
      const cleanMessageIds = normalizeMapMessageIds(messageIds);
      if (cleanMessageIds.length === 0) {
        mapMessagesLoadVersionRef.current += 1;
        setMapOpenMessages([]);
        setSettlementMessagesHasMore(false);
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
        setSettlementMessagesHasMore(false);
        void loadMissingNetworksForMessages(nextMessages);
        return nextMessages.length > 0;
      } catch (loadError) {
        if (mapMessagesLoadVersionRef.current !== loadVersion) return false;
        if (!onUnauthorized(loadError)) onError(toErrorMessage(loadError));
        return false;
      }
    },
    [loadMissingNetworksForMessages, onError, onUnauthorized],
  );

  const loadSettlementMessagesForMap = useCallback(
    async (settlementId: number, beforeIdNoninclusive: number | null = null) => {
      if (!Number.isSafeInteger(settlementId) || settlementId <= 0) return false;
      const inboxReq = buildInboxReq(queryState, optionsFreqValues);
      if (isNullOrUndefined(inboxReq)) return false;
      const loadVersion = mapMessagesLoadVersionRef.current + 1;
      mapMessagesLoadVersionRef.current = loadVersion;
      const queryKey = settlementQueryKey;
      if (beforeIdNoninclusive === null) setSettlementMessagesHasMore(false);
      const filter =
        mapDateRange.startDate > 0 && mapDateRange.endDate > 0
          ? {
              ...inboxReq,
              sinceDateInclusiveMs: mapDateRange.startDate,
              tillDateInclusiveMs: mapDateRange.endDate,
              newestFirst,
            }
          : inboxReq;

      try {
        const nextMessages = await fetchMapSettlementMessages({
          settlementId,
          inboxItemsFilter: filter,
          beforeIdNoninclusive,
        });
        if (
          mapMessagesLoadVersionRef.current !== loadVersion ||
          settlementQueryKeyRef.current !== queryKey
        )
          return false;
        const currentMessages = beforeIdNoninclusive === null ? [] : mapOpenMessages;
        const currentMessageIds = new Set(currentMessages.map(([messageId]) => messageId));
        const combinedMessages = [
          ...currentMessages,
          ...nextMessages.filter(([messageId]) => !currentMessageIds.has(messageId)),
        ];
        const totalCount =
          mapSettlementsState.find((settlement) => settlement.settlementId === settlementId)
            ?.inboxItemCount ?? combinedMessages.length;
        setMapOpenMessages(combinedMessages);
        setSettlementMessagesHasMore(
          nextMessages.length > 0 && combinedMessages.length < totalCount,
        );
        void loadMissingNetworksForMessages(nextMessages);
        return combinedMessages.length > 0;
      } catch (loadError) {
        if (
          mapMessagesLoadVersionRef.current !== loadVersion ||
          settlementQueryKeyRef.current !== queryKey
        )
          return false;
        if (!onUnauthorized(loadError)) onError(toErrorMessage(loadError));
        return false;
      }
    },
    [
      loadMissingNetworksForMessages,
      mapDateRange,
      mapOpenMessages,
      mapSettlementsState,
      newestFirst,
      onError,
      onUnauthorized,
      optionsFreqValues,
      queryState,
      settlementQueryKey,
    ],
  );

  const loadMapPalitras = useCallback(async () => {
    setMapPalitrasLoadState('loading');
    setMapPalitrasLoaded(false);

    try {
      const palitras = await listMapPalitrasV2();
      primeCoordinatePreviewPalitraIds(palitras);
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
  }, [onError, onUnauthorized]);

  const mapAttrs = useMemo(
    () =>
      buildMapAttrs({
        dateRange: mapDateRange,
        isLoading: mapLoading,
        points: mapPoints,
        settlements: mapSettlementsState,
        canShowSettlements,
        showSettlements,
        messages: mapOpenMessages,
        settlementMessagesHasMore,
        networkUnits: mapNetworkUnits,
        selectedUnits: queryState.unitsSelected,
        palitras: mapPalitras,
        palitrasLoaded: mapPalitrasLoaded,
        palitrasLoadState: mapPalitrasLoadState,
      }),
    [
      mapDateRange,
      mapLoading,
      mapNetworkUnits,
      mapOpenMessages,
      settlementMessagesHasMore,
      mapPalitras,
      mapPalitrasLoaded,
      mapPalitrasLoadState,
      mapPoints,
      mapSettlementsState,
      canShowSettlements,
      showSettlements,
      queryState.unitsSelected,
    ],
  );

  return {
    mapLoading,
    mapDateRange,
    mapPoints,
    mapNetworkUnits,
    mapSettlements: mapSettlementsState,
    showSettlements,
    mapOpenMessages,
    settlementMessagesHasMore,
    mapPalitras,
    mapPalitrasLoaded,
    mapPalitrasLoadState,
    mapMessagesLoadVersionRef,
    mapDateRangeLoadVersionRef,
    mapAttrs,
    refreshMapDateRange,
    loadMessagesForMap,
    loadSettlementMessagesForMap,
    loadMapPalitras,
    setMapLoading,
    setMapDateRange,
    setMapPoints,
    setMapNetworkUnits,
    applyMapSettlements,
    setShowSettlements,
    setMapOpenMessages,
    setMapPalitras,
    setMapPalitrasLoaded,
    setMapPalitrasLoadState,
  };
}
