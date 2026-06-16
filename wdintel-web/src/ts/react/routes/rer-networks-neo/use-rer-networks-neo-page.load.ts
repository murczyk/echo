import { type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { MRT_ColumnFiltersState, MRT_SortingState } from 'material-react-table';

import type { AreaOfResponsibility, ModulationRec, Network, Unit } from '../../../../Bindings';
import { isUnauthorizedError } from '../../services/api/client';
import { listAors } from '../../services/api/aor';
import { listPosts } from '../../services/api/posts';
import { getModulations } from '../../services/api/modulations';
import { getUnitsList } from '../../services/api/units';
import { getNetworkUnitStats, getNetworksGroupsActivity, listNetworks } from '../../services/api/networks';
import {
  buildNetworksListReq,
  buildNetworksStatusCountsReq,
  NETWORK_LIST_PAGE_SIZE,
  type NetworksFilterState,
} from './helpers';
import {
  formatErrorMessage,
  getActivityRequestUpperBoundMs,
  isAbortError,
  normalizeActivityMap,
} from './use-rer-networks-neo-page.shared';
import type { ActivityByNetworkId, NetworksQuerySnapshot, UiMessage } from './use-rer-networks-neo-page.types';
import { redirectToLogin } from '../../auth-redirect';
import type { SelectedSidebarUnitFilter } from '../rer-callsigns-neo/types';

type LoadArgs = {
  tableStateContext: {
    globalFilter: string;
    columnFilters: MRT_ColumnFiltersState;
    sorting: MRT_SortingState;
  };
  filtersRef: MutableRefObject<NetworksFilterState>;
  selectedSidebarUnitFilterRef: MutableRefObject<SelectedSidebarUnitFilter | null>;
  tableStateContextRef: MutableRefObject<{
    globalFilter: string;
    columnFilters: MRT_ColumnFiltersState;
    sorting: MRT_SortingState;
  }>;
  columnFiltersRef: MutableRefObject<MRT_ColumnFiltersState>;
  latestQuerySnapshotRef: MutableRefObject<NetworksQuerySnapshot | null>;
  requestSeqRef: MutableRefObject<number>;
  bootstrapLoadedRef: MutableRefObject<boolean>;
  mainAbortRef: MutableRefObject<AbortController | null>;
  loadMoreAbortRef: MutableRefObject<AbortController | null>;
  networksLengthRef: MutableRefObject<number>;
  lastExecutedFullQueryKeyRef: MutableRefObject<string | null>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setRefreshing: Dispatch<SetStateAction<boolean>>;
  setLoadingMore: Dispatch<SetStateAction<boolean>>;
  setUnits: Dispatch<SetStateAction<Unit[]>>;
  setAors: Dispatch<SetStateAction<AreaOfResponsibility[]>>;
  setUnitStats: Dispatch<SetStateAction<Array<{ unitId: number; count: number }>>>;
  setPosts: Dispatch<SetStateAction<Array<{ id: number; name: string }>>>;
  setModulations: Dispatch<SetStateAction<ModulationRec[]>>;
  setStatus: Dispatch<SetStateAction<UiMessage>>;
  setStatusCounts: Dispatch<SetStateAction<{ active: number; inactive: number; archived: number } | null>>;
  setNoMoreToLoad: Dispatch<SetStateAction<boolean>>;
  setNetworks: Dispatch<SetStateAction<Network[]>>;
  setActivityByNetworkId: Dispatch<SetStateAction<ActivityByNetworkId>>;
  setBootstrapLoaded: Dispatch<SetStateAction<boolean>>;
};

export function createRerNetworksNeoLoadActions(args: LoadArgs) {
  const loadNetworks = async (snapshot: NetworksQuerySnapshot, options?: { includeLookups?: boolean; append?: boolean; force?: boolean }) => {
    const seq = ++args.requestSeqRef.current;
    const includeLookups = options?.includeLookups ?? false;
    const append = options?.append ?? false;
    const force = options?.force ?? false;
    const controller = new AbortController();
    if (args.lastExecutedFullQueryKeyRef.current === snapshot.fullQueryKey && !append && !includeLookups && !force) {
      return;
    }
    if (!append) {
      args.mainAbortRef.current?.abort();
      args.mainAbortRef.current = controller;
    }
    const req = buildNetworksListReq({
      searchText: snapshot.globalFilter,
      selectedSidebarUnitFilter: snapshot.selectedSidebarUnitFilter,
      selectedUnitLabel: snapshot.filters.unitText.trim() === '' ? null : snapshot.filters.unitText.trim(),
      showOnlyInvestigating: snapshot.filters.showOnlyInvestigating,
      status: snapshot.filters.status,
      columnFilters: snapshot.columnFilters,
      sorting: snapshot.sorting,
      limit: NETWORK_LIST_PAGE_SIZE,
      offset: append ? args.networksLengthRef.current : 0,
    });
    if (includeLookups) {
      args.setLoading(true);
    } else if (append) {
      args.setLoadingMore(true);
    } else {
      args.setRefreshing(true);
    }
    args.setStatus(null);

    try {
      const lookupsPromise = includeLookups
        ? Promise.all([getUnitsList(), listAors({ sortBy: null }), getNetworkUnitStats(), listPosts(), getModulations()])
        : null;
      const networksPromise = listNetworks(req, { signal: controller.signal });

      const nextLookups = lookupsPromise === null ? null : await lookupsPromise;
      const { list: networksList, statusCounts } = await networksPromise;

      if (args.requestSeqRef.current !== seq) return;

      if (nextLookups !== null) {
        const [unitsList, aorList, unitStatsList, postsList, modulationList] = nextLookups;
        args.setUnits(unitsList);
        args.setAors(aorList);
        args.setUnitStats(unitStatsList);
        args.setPosts(postsList);
        args.setModulations(modulationList);
        args.bootstrapLoadedRef.current = true;
        args.setBootstrapLoaded(true);
      }
      args.setStatusCounts(statusCounts);
      args.setNoMoreToLoad(networksList.length < NETWORK_LIST_PAGE_SIZE);
      args.setNetworks((current) => (append ? [...current, ...networksList] : networksList));
      if (networksList.length === 0) {
        args.setActivityByNetworkId((current) => (append ? new Map(current) : new Map()));
      } else {
        (async () => {
          try {
            const activityRsp = await getNetworksGroupsActivity(
              {
                networkIds: networksList.map((network) => network.id),
                tillDateNoninclusiveMs: getActivityRequestUpperBoundMs(),
              },
              { signal: controller.signal },
            );
            if (args.requestSeqRef.current !== seq) return;
            args.setActivityByNetworkId((current) => {
              const nextActivity = append ? new Map(current) : new Map();
              const normalized = normalizeActivityMap(activityRsp);
              for (const [networkId, activity] of normalized.entries()) {
                nextActivity.set(networkId, activity);
              }
              return nextActivity;
            });
          } catch (e) {}
        })();
      }
      if (!append) {
        args.lastExecutedFullQueryKeyRef.current = snapshot.fullQueryKey;
      }
    } catch (error) {
      if (args.requestSeqRef.current !== seq) return;
      if (controller.signal.aborted || isAbortError(error)) return;
      if (isUnauthorizedError(error)) {
        redirectToLogin();
        return;
      }
      args.setStatus({
        kind: 'error',
        text: `Помилка завантаження мереж: ${formatErrorMessage(error)}`,
      });
    } finally {
      if (args.requestSeqRef.current === seq) {
        args.setLoading(false);
        args.setRefreshing(false);
        args.setLoadingMore(false);
      }
      if (!append && args.mainAbortRef.current === controller) {
        args.mainAbortRef.current = null;
      }
    }
  };

  const refreshStatusCounts = async () => {
    const seq = args.requestSeqRef.current;
    try {
      const countsReq = buildNetworksStatusCountsReq({
        searchText: args.latestQuerySnapshotRef.current?.globalFilter ?? args.tableStateContextRef.current.globalFilter,
        selectedSidebarUnitFilter:
          args.latestQuerySnapshotRef.current?.selectedSidebarUnitFilter ?? args.selectedSidebarUnitFilterRef.current,
        selectedUnitLabel:
          (args.latestQuerySnapshotRef.current?.filters.unitText ?? args.filtersRef.current.unitText).trim() === ''
            ? null
            : (args.latestQuerySnapshotRef.current?.filters.unitText ?? args.filtersRef.current.unitText).trim(),
        showOnlyInvestigating: args.latestQuerySnapshotRef.current?.filters.showOnlyInvestigating ?? args.filtersRef.current.showOnlyInvestigating,
        columnFilters: args.latestQuerySnapshotRef.current?.columnFilters ?? args.columnFiltersRef.current,
      });
      const { statusCounts } = await listNetworks({
        ...countsReq,
        limit: 0,
        offset: 0,
      });
      if (args.requestSeqRef.current !== seq) return;
      args.setStatusCounts(statusCounts);
    } catch (error) {
      if (isUnauthorizedError(error)) {
        redirectToLogin();
        return;
      }
      args.setStatus({
        kind: 'error',
        text: `Помилка оновлення лічильників мереж: ${formatErrorMessage(error)}`,
      });
    }
  };

  const loadMoreNetworks = async () => {
    if (args.latestQuerySnapshotRef.current === null) return;

    if (args.loadMoreAbortRef.current !== null) {
      args.loadMoreAbortRef.current.abort();
    }
    args.loadMoreAbortRef.current = new AbortController();
    const seq = ++args.requestSeqRef.current;
    args.setLoadingMore(true);
    args.setStatus(null);

    try {
      const snapshot = args.latestQuerySnapshotRef.current ?? {
        globalFilter: args.tableStateContextRef.current.globalFilter,
        columnFilters: args.columnFiltersRef.current,
        sorting: args.tableStateContextRef.current.sorting,
        selectedSidebarUnitFilter: args.selectedSidebarUnitFilterRef.current,
        filters: {
          ...args.filtersRef.current,
          searchText: args.tableStateContextRef.current.globalFilter,
        },
        fullQueryKey: '',
      };
      const req = buildNetworksListReq({
        searchText: snapshot.globalFilter,
        selectedSidebarUnitFilter: snapshot.selectedSidebarUnitFilter ?? args.selectedSidebarUnitFilterRef.current,
        selectedUnitLabel: snapshot.filters.unitText.trim() === '' ? null : snapshot.filters.unitText.trim(),
        showOnlyInvestigating: snapshot.filters.showOnlyInvestigating,
        status: snapshot.filters.status,
        columnFilters: snapshot.columnFilters,
        sorting: snapshot.sorting,
        limit: NETWORK_LIST_PAGE_SIZE,
        offset: args.networksLengthRef.current,
      });
      const { list: networksList, statusCounts } = await listNetworks(req, { signal: args.loadMoreAbortRef.current.signal });
      const activityRsp =
        networksList.length === 0
          ? {}
          : await getNetworksGroupsActivity(
              {
                networkIds: networksList.map((network) => network.id),
                tillDateNoninclusiveMs: getActivityRequestUpperBoundMs(),
              },
              { signal: args.loadMoreAbortRef.current.signal },
            );

      if (args.requestSeqRef.current !== seq) return;

      args.setNoMoreToLoad(networksList.length < NETWORK_LIST_PAGE_SIZE);
      args.setStatusCounts(statusCounts);
      args.setNetworks((current) => [...current, ...networksList]);
      args.setActivityByNetworkId((current) => {
        const nextActivity = new Map(current);
        const normalized = normalizeActivityMap(activityRsp);
        for (const [networkId, activity] of normalized.entries()) {
          nextActivity.set(networkId, activity);
        }
        return nextActivity;
      });
    } catch (error) {
      if (args.requestSeqRef.current !== seq) return;
      if (isUnauthorizedError(error)) {
        redirectToLogin();
        return;
      }
      args.setStatus({ kind: 'error', text: `Помилка завантаження мереж: ${formatErrorMessage(error)}` });
    } finally {
      if (args.requestSeqRef.current === seq) {
        args.setLoadingMore(false);
      }
    }
  };

  return {
    loadNetworks,
    refreshStatusCounts,
    loadMoreNetworks,
  };
}
