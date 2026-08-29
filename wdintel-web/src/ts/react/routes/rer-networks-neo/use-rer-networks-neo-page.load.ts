import { type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { MRT_ColumnFiltersState, MRT_SortingState } from 'material-react-table';

import type { AreaOfResponsibility, EncryptionRec, Network, Unit } from '../../../../Bindings';
import { isUnauthorizedError } from '../../services/api/client';
import { listAors } from '../../services/api/aor';
import { listPosts } from '../../services/api/posts';
import { getEncryptions } from '../../services/api/encryptions';
import { getUnitsByIds, getUnitsList, mergeUnitsById } from '../../services/api/units';
import {
  getNetworkUnitStats,
  getNetworksGroupsActivity,
  listNetworks,
} from '../../services/api/networks';
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
import type {
  ActivityLoadStateByNetworkId,
  ActivityByNetworkId,
  NetworksQuerySnapshot,
  UiMessage,
} from './use-rer-networks-neo-page.types';
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
  activityQueryGenerationRef: MutableRefObject<number>;
  activityAbortControllersRef: MutableRefObject<Set<AbortController>>;
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
  setEncryptions: Dispatch<SetStateAction<EncryptionRec[]>>;
  setStatus: Dispatch<SetStateAction<UiMessage>>;
  setStatusCounts: Dispatch<
    SetStateAction<{ active: number; inactive: number; archived: number } | null>
  >;
  setNoMoreToLoad: Dispatch<SetStateAction<boolean>>;
  setNetworks: Dispatch<SetStateAction<Network[]>>;
  setActivityByNetworkId: Dispatch<SetStateAction<ActivityByNetworkId>>;
  setActivityLoadStateByNetworkId: Dispatch<SetStateAction<ActivityLoadStateByNetworkId>>;
  setBootstrapLoaded: Dispatch<SetStateAction<boolean>>;
};

export function createRerNetworksNeoLoadActions(args: LoadArgs) {
  const abortActivityRequests = () => {
    for (const controller of args.activityAbortControllersRef.current) controller.abort();
  };

  const loadActivity = (networkIds: number[], activityGeneration: number) => {
    const controller = new AbortController();
    args.activityAbortControllersRef.current.add(controller);

    void (async () => {
      try {
        const activityRsp = await getNetworksGroupsActivity(
          {
            networkIds,
            tillDateNoninclusiveMs: getActivityRequestUpperBoundMs(),
            period: null,
          },
          { signal: controller.signal },
        );
        if (args.activityQueryGenerationRef.current !== activityGeneration) return;
        const normalized = normalizeActivityMap(activityRsp);
        args.setActivityByNetworkId((current) => {
          const nextActivity = new Map(current);
          for (const networkId of networkIds) {
            nextActivity.set(networkId, normalized.get(networkId) ?? {});
          }
          return nextActivity;
        });
        args.setActivityLoadStateByNetworkId((current) => {
          const next = new Map(current);
          for (const networkId of networkIds) next.set(networkId, 'loaded');
          return next;
        });
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return;
        if (isUnauthorizedError(error)) {
          redirectToLogin();
          return;
        }
        if (args.activityQueryGenerationRef.current !== activityGeneration) return;
        args.setActivityLoadStateByNetworkId((current) => {
          const next = new Map(current);
          for (const networkId of networkIds) next.set(networkId, 'error');
          return next;
        });
      } finally {
        args.activityAbortControllersRef.current.delete(controller);
      }
    })();
  };

  const loadNetworks = async (
    snapshot: NetworksQuerySnapshot,
    options?: { includeLookups?: boolean; append?: boolean; force?: boolean },
  ) => {
    const seq = ++args.requestSeqRef.current;
    const includeLookups = options?.includeLookups ?? false;
    const append = options?.append ?? false;
    const force = options?.force ?? false;
    const controller = new AbortController();
    if (
      args.lastExecutedFullQueryKeyRef.current === snapshot.fullQueryKey &&
      !append &&
      !includeLookups &&
      !force
    ) {
      return;
    }
    if (!append) {
      args.activityQueryGenerationRef.current += 1;
      abortActivityRequests();
      args.mainAbortRef.current?.abort();
      args.mainAbortRef.current = controller;
    }
    const req = buildNetworksListReq({
      searchText: snapshot.globalFilter,
      selectedSidebarUnitFilter: snapshot.selectedSidebarUnitFilter,
      selectedUnitLabel:
        snapshot.filters.unitText.trim() === '' ? null : snapshot.filters.unitText.trim(),
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
        ? Promise.all([
            getUnitsList(),
            listAors({ sortBy: null }),
            getNetworkUnitStats(),
            listPosts(),
            getEncryptions(),
          ])
        : null;
      const networksPromise = listNetworks(req, { signal: controller.signal });

      const { list: networksList, statusCounts } = await networksPromise;

      if (args.requestSeqRef.current !== seq) return;

      const referencedUnitIds = Array.from(
        new Set(networksList.flatMap((network) => network.unitIds ?? [])),
      );
      const referencedUnitsPromise = getUnitsByIds(referencedUnitIds, {
        signal: controller.signal,
      });

      args.setStatusCounts(statusCounts);
      args.setNoMoreToLoad(networksList.length < NETWORK_LIST_PAGE_SIZE);
      args.setNetworks((current) => (append ? [...current, ...networksList] : networksList));
      const requestedNetworkIds = networksList.map((network) => network.id);
      if (append) {
        args.setActivityLoadStateByNetworkId((current) => {
          const next = new Map(current);
          for (const networkId of requestedNetworkIds) next.set(networkId, 'loading');
          return next;
        });
      } else {
        args.setActivityByNetworkId(new Map());
        args.setActivityLoadStateByNetworkId(
          new Map(requestedNetworkIds.map((networkId) => [networkId, 'loading'])),
        );
      }

      if (lookupsPromise !== null) {
        (async () => {
          try {
            const [lookups, referencedUnits] = await Promise.all([
              lookupsPromise,
              referencedUnitsPromise,
            ]);
            const [unitsList, aorList, unitStatsList, postsList, encryptionList] = lookups;
            if (args.requestSeqRef.current !== seq) return;
            args.setUnits(mergeUnitsById(unitsList, referencedUnits));
            args.setAors(aorList);
            args.setUnitStats(unitStatsList);
            args.setPosts(postsList);
            args.setEncryptions(encryptionList);
            args.bootstrapLoadedRef.current = true;
            args.setBootstrapLoaded(true);
          } catch (error) {
            if (isUnauthorizedError(error)) {
              redirectToLogin();
              return;
            }
          }
        })();
      } else {
        (async () => {
          try {
            const referencedUnits = await referencedUnitsPromise;
            if (args.requestSeqRef.current !== seq) return;
            args.setUnits((current) => mergeUnitsById(current, referencedUnits));
          } catch (error) {
            if (controller.signal.aborted || isAbortError(error)) return;
            if (isUnauthorizedError(error)) redirectToLogin();
          }
        })();
      }
      if (networksList.length > 0) {
        loadActivity(requestedNetworkIds, args.activityQueryGenerationRef.current);
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
        searchText:
          args.latestQuerySnapshotRef.current?.globalFilter ??
          args.tableStateContextRef.current.globalFilter,
        selectedSidebarUnitFilter:
          args.latestQuerySnapshotRef.current?.selectedSidebarUnitFilter ??
          args.selectedSidebarUnitFilterRef.current,
        selectedUnitLabel:
          (
            args.latestQuerySnapshotRef.current?.filters.unitText ??
            args.filtersRef.current.unitText
          ).trim() === ''
            ? null
            : (
                args.latestQuerySnapshotRef.current?.filters.unitText ??
                args.filtersRef.current.unitText
              ).trim(),
        showOnlyInvestigating:
          args.latestQuerySnapshotRef.current?.filters.showOnlyInvestigating ??
          args.filtersRef.current.showOnlyInvestigating,
        columnFilters:
          args.latestQuerySnapshotRef.current?.columnFilters ?? args.columnFiltersRef.current,
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
        selectedSidebarUnitFilter:
          snapshot.selectedSidebarUnitFilter ?? args.selectedSidebarUnitFilterRef.current,
        selectedUnitLabel:
          snapshot.filters.unitText.trim() === '' ? null : snapshot.filters.unitText.trim(),
        showOnlyInvestigating: snapshot.filters.showOnlyInvestigating,
        status: snapshot.filters.status,
        columnFilters: snapshot.columnFilters,
        sorting: snapshot.sorting,
        limit: NETWORK_LIST_PAGE_SIZE,
        offset: args.networksLengthRef.current,
      });
      const { list: networksList, statusCounts } = await listNetworks(req, {
        signal: args.loadMoreAbortRef.current.signal,
      });

      if (args.requestSeqRef.current !== seq) return;

      args.setNoMoreToLoad(networksList.length < NETWORK_LIST_PAGE_SIZE);
      args.setStatusCounts(statusCounts);
      args.setNetworks((current) => [...current, ...networksList]);
      if (networksList.length === 0) {
        return;
      } else {
        const requestedNetworkIds = networksList.map((network) => network.id);
        args.setActivityLoadStateByNetworkId((current) => {
          const next = new Map(current);
          for (const networkId of requestedNetworkIds) next.set(networkId, 'loading');
          return next;
        });
        loadActivity(requestedNetworkIds, args.activityQueryGenerationRef.current);
      }
    } catch (error) {
      if (args.requestSeqRef.current !== seq) return;
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
