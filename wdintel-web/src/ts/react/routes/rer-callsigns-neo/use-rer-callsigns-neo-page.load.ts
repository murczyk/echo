import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { Callsign, CallsignUnitStatRow, Source, Unit, User } from '../../../../Bindings';
import { getCallsignUnitStats, listCallsigns, listSources, fetchCallsignsBootstrapData } from '../../services/api/callsigns';
import { buildListCallsignsReq, formatErrorMessage, getDefaultPageSize, isAbortError } from './helpers-core';
import { getReloadPageSize, normalizeCallsigns } from './use-rer-callsigns-neo-page.shared';
import type { CallsignsFilterState, CallsignsSortState, SelectedSidebarUnitFilter, UiStatus } from './types';

type SetState<T> = Dispatch<SetStateAction<T>>;

type Args = {
  filters: CallsignsFilterState;
  sort: CallsignsSortState;
  selectedSidebarUnitFilter: SelectedSidebarUnitFilter | null;
  callsignsLength: number;
  setUser: SetState<User | null>;
  setUnits: SetState<Unit[]>;
  setSources: SetState<Source[]>;
  setUnitStats: SetState<CallsignUnitStatRow[]>;
  setCallsigns: SetState<Callsign[]>;
  setShowLoadMore: SetState<boolean>;
  setLoading: SetState<boolean>;
  setLoadingMore: SetState<boolean>;
  setRefreshing: SetState<boolean>;
  setStatus: SetState<UiStatus>;
  setAddSourceId: SetState<number | null>;
  initializedRef: MutableRefObject<boolean>;
  listRequestSeqRef: MutableRefObject<number>;
  debounceTimerRef: MutableRefObject<number | null>;
  activeListAbortRef: MutableRefObject<AbortController | null>;
};

export function useRerCallsignsNeoPageLoad({
  filters,
  sort,
  selectedSidebarUnitFilter,
  callsignsLength,
  setUser,
  setUnits,
  setSources,
  setUnitStats,
  setCallsigns,
  setShowLoadMore,
  setLoading,
  setLoadingMore,
  setRefreshing,
  setStatus,
  setAddSourceId,
  initializedRef,
  listRequestSeqRef,
  debounceTimerRef,
  activeListAbortRef,
}: Args) {
  const bootstrapRequestSeqRef = useRef(0);
  const callsignsLengthRef = useRef(callsignsLength);

  callsignsLengthRef.current = callsignsLength;

  const clearListRequest = useCallback(() => {
    activeListAbortRef.current?.abort();
    activeListAbortRef.current = null;
  }, [activeListAbortRef]);

  const runListFetch = useCallback(
    async ({
      append,
      afterId,
      announceLoading,
      preserveLoadedCount = false,
    }: {
      append: boolean;
      afterId: number | null;
      announceLoading: boolean;
      preserveLoadedCount?: boolean;
    }) => {
      const seq = ++listRequestSeqRef.current;
      if (!append) {
        const limit = preserveLoadedCount ? getReloadPageSize(callsignsLengthRef.current) : getDefaultPageSize();
        setLoadingMore(false);
        clearListRequest();
        const controller = new AbortController();
        activeListAbortRef.current = controller;
        if (announceLoading) setLoading(true);

        try {
          const rsp = await listCallsigns(
            buildListCallsignsReq({
              filters,
              sort,
              query: { afterId, limit },
              sidebarUnitHierarchyFilter: selectedSidebarUnitFilter?.kind === 'group' ? selectedSidebarUnitFilter.hierarchy : null,
            }),
            controller.signal,
          );
          if (listRequestSeqRef.current !== seq) return;
          setCallsigns(normalizeCallsigns(rsp.callsigns));
          setShowLoadMore(rsp.showLoadMore);
        } catch (error) {
          if (isAbortError(error)) return;
          setStatus({ kind: 'error', text: `Помилка завантаження позивних: ${formatErrorMessage(error)}` });
        } finally {
          if (listRequestSeqRef.current === seq) {
            setLoading(false);
            setRefreshing(false);
          }
        }
        return;
      }

      if (announceLoading) setLoadingMore(true);

      try {
        const rsp = await listCallsigns(
          buildListCallsignsReq({
            filters,
            sort,
            query: { afterId, limit: getDefaultPageSize() },
            sidebarUnitHierarchyFilter: selectedSidebarUnitFilter?.kind === 'group' ? selectedSidebarUnitFilter.hierarchy : null,
          }),
        );
        if (listRequestSeqRef.current !== seq) return;
        setCallsigns((prev) => {
          const byId = new Map<number, Callsign>();
          for (const item of prev) byId.set(item.id, item);
          for (const item of normalizeCallsigns(rsp.callsigns)) byId.set(item.id, item);
          return Array.from(byId.values());
        });
        setShowLoadMore(rsp.showLoadMore);
      } catch (error) {
        setStatus({ kind: 'error', text: `Помилка завантаження позивних: ${formatErrorMessage(error)}` });
      } finally {
        if (listRequestSeqRef.current === seq) {
          setLoadingMore(false);
        }
      }
    },
    [
      activeListAbortRef,
      clearListRequest,
      filters,
      listRequestSeqRef,
      selectedSidebarUnitFilter,
      setCallsigns,
      setLoading,
      setLoadingMore,
      setRefreshing,
      setShowLoadMore,
      setStatus,
      sort,
    ],
  );

  const refreshLookupsAndStats = useCallback(async () => {
    try {
      const [freshSources, freshStats] = await Promise.all([listSources(), getCallsignUnitStats()]);
      setSources(freshSources);
      setUnitStats(freshStats);
      setAddSourceId((prev) => (prev === null ? freshSources[0]?.id ?? null : prev));
    } catch (error) {
      setStatus({ kind: 'error', text: `Помилка оновлення довідників: ${formatErrorMessage(error)}` });
    }
  }, [setAddSourceId, setSources, setStatus, setUnitStats]);

  useEffect(() => {
    const generation = ++bootstrapRequestSeqRef.current;
    let cancelled = false;

    async function loadBootstrap() {
      setLoading(true);
      setStatus(null);
      try {
        const bootstrap = await fetchCallsignsBootstrapData(
          buildListCallsignsReq({
            filters,
            sort,
            query: { afterId: null, limit: getDefaultPageSize() },
            sidebarUnitHierarchyFilter: selectedSidebarUnitFilter?.kind === 'group' ? selectedSidebarUnitFilter.hierarchy : null,
          }),
        );

        if (cancelled || bootstrapRequestSeqRef.current !== generation) return;

        setUser(bootstrap.user);
        setUnits(bootstrap.units);
        setSources(bootstrap.sources);
        setUnitStats(bootstrap.unitStats);
        setCallsigns(normalizeCallsigns(bootstrap.callsigns.callsigns));
        setShowLoadMore(bootstrap.callsigns.showLoadMore);
        setAddSourceId(bootstrap.sources[0]?.id ?? null);
        initializedRef.current = true;
      } catch (error) {
        if (cancelled || bootstrapRequestSeqRef.current !== generation) return;
        setStatus({ kind: 'error', text: `Помилка завантаження позивних: ${formatErrorMessage(error)}` });
      } finally {
        if (!cancelled && bootstrapRequestSeqRef.current === generation) {
          setLoading(false);
        }
      }
    }

    void loadBootstrap();

    return () => {
      cancelled = true;
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      clearListRequest();
    };
  }, []);

  return {
    runListFetch,
    refreshLookupsAndStats,
    clearListRequest,
  };
}
