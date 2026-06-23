import { useCallback, useMemo, useRef, useState } from 'react';

import type { FreqDetailedPoint, InboxMessage, NetworkUnit, PalitraReadV2 } from '../../../../Bindings';
import { fetchMessagesByIds, fetchAnalysisMapPoints } from '../../services/api/analysis';
import { listMapPalitrasV2 } from '../../services/api/palitra';
import { isNullOrUndefined } from '../../utils/misc';
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
};

export type UseAnalysisMapDataResult = {
  mapLoading: boolean;
  mapDateRange: { startDate: number; endDate: number };
  mapPoints: FreqDetailedPoint[];
  mapNetworkUnits: NetworkUnit[];
  mapOpenMessages: Array<[number, InboxMessage]>;
  mapPalitras: PalitraReadV2[];
  mapPalitrasLoaded: boolean;
  mapPalitrasLoadState: AnalysisPalitrasLoadState;
  mapMessagesLoadVersionRef: React.MutableRefObject<number>;
  mapDateRangeLoadVersionRef: React.MutableRefObject<number>;
  mapAttrs: AnalysisMapAttrs;
  refreshMapDateRange: (range: { startDate: number; endDate: number }) => Promise<void>;
  loadMessagesForMap: (messageIds: number[]) => Promise<boolean>;
  loadMapPalitras: () => Promise<void>;
  setMapLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setMapDateRange: React.Dispatch<React.SetStateAction<{ startDate: number; endDate: number }>>;
  setMapPoints: React.Dispatch<React.SetStateAction<FreqDetailedPoint[]>>;
  setMapNetworkUnits: React.Dispatch<React.SetStateAction<NetworkUnit[]>>;
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
}: Params): UseAnalysisMapDataResult {
  const [mapLoading, setMapLoading] = useState(false);
  const [mapDateRange, setMapDateRange] = useState({ startDate: 0, endDate: 0 });
  const [mapPoints, setMapPoints] = useState<FreqDetailedPoint[]>([]);
  const [mapNetworkUnits, setMapNetworkUnits] = useState<NetworkUnit[]>([]);
  const [mapOpenMessages, setMapOpenMessages] = useState<Array<[number, InboxMessage]>>([]);
  const [mapPalitras, setMapPalitras] = useState<PalitraReadV2[]>([]);
  const [mapPalitrasLoaded, setMapPalitrasLoaded] = useState(false);
  const [mapPalitrasLoadState, setMapPalitrasLoadState] = useState<AnalysisPalitrasLoadState>('idle');
  const mapMessagesLoadVersionRef = useRef(0);
  const mapDateRangeLoadVersionRef = useRef(0);

  const refreshMapDateRange = useCallback(
    async (range: { startDate: number; endDate: number }) => {
      const inboxReq = buildInboxReq(queryState, optionsFreqValues);
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
    [newestFirst, onError, onUnauthorized, optionsFreqValues, queryState],
  );

  const loadMessagesForMap = useCallback(
    async (messageIds: number[]) => {
      const cleanMessageIds = Array.from(new Set(messageIds.filter((messageId): messageId is number => Number.isInteger(messageId))));
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
        setMapOpenMessages(nextMessages);
        void loadMissingNetworksForMessages(nextMessages);
        return true;
      } catch (loadError) {
        if (mapMessagesLoadVersionRef.current !== loadVersion) return false;
        if (!onUnauthorized(loadError)) onError(toErrorMessage(loadError));
        return false;
      }
    },
    [loadMissingNetworksForMessages, onError, onUnauthorized],
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
  }, [onError, onUnauthorized]);

  const mapAttrs = useMemo(
    () =>
      buildMapAttrs({
        dateRange: mapDateRange,
        isLoading: mapLoading,
        points: mapPoints,
        messages: mapOpenMessages,
        networkUnits: mapNetworkUnits,
        selectedUnits: queryState.unitsSelected,
        palitras: mapPalitras,
        palitrasLoaded: mapPalitrasLoaded,
        palitrasLoadState: mapPalitrasLoadState,
      }),
    [mapDateRange, mapLoading, mapNetworkUnits, mapOpenMessages, mapPalitras, mapPalitrasLoaded, mapPalitrasLoadState, mapPoints, queryState.unitsSelected],
  );

  return {
    mapLoading,
    mapDateRange,
    mapPoints,
    mapNetworkUnits,
    mapOpenMessages,
    mapPalitras,
    mapPalitrasLoaded,
    mapPalitrasLoadState,
    mapMessagesLoadVersionRef,
    mapDateRangeLoadVersionRef,
    mapAttrs,
    refreshMapDateRange,
    loadMessagesForMap,
    loadMapPalitras,
    setMapLoading,
    setMapDateRange,
    setMapPoints,
    setMapNetworkUnits,
    setMapOpenMessages,
    setMapPalitras,
    setMapPalitrasLoaded,
    setMapPalitrasLoadState,
  };
}
