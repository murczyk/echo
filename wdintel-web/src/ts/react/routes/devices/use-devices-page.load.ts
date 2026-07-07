import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { MRT_SortingState } from 'material-react-table';

import type {
  AreaOfResponsibility,
  DeviceListItem,
  DeviceStatusCountsRsp,
  DeviceUnitStatRow,
  Unit,
} from '../../../../Bindings';
import { redirectToLogin } from '../../auth-redirect';
import { listAors } from '../../services/api/aor';
import { isAbortError, isUnauthorizedError } from '../../services/api/client';
import { getDeviceUnitStats, listDevices } from '../../services/api/devices';
import { getUnitsList } from '../../services/api/units';
import {
  buildDevicesListReq,
  DEVICES_LIST_PAGE_SIZE,
  formatDeviceErrorMessage,
  type DevicesFilterState,
} from './helpers';

export type DevicesQuerySnapshot = {
  globalFilter: string;
  filters: DevicesFilterState;
  sorting: MRT_SortingState;
  fullQueryKey: string;
};

export type DevicesUiMessage = {
  kind: 'success' | 'info' | 'error';
  text: string;
} | null;

type LoadArgs = {
  latestQuerySnapshotRef: MutableRefObject<DevicesQuerySnapshot | null>;
  requestSeqRef: MutableRefObject<number>;
  bootstrapLoadedRef: MutableRefObject<boolean>;
  mainAbortRef: MutableRefObject<AbortController | null>;
  loadMoreAbortRef: MutableRefObject<AbortController | null>;
  devicesLengthRef: MutableRefObject<number>;
  lastExecutedFullQueryKeyRef: MutableRefObject<string | null>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setRefreshing: Dispatch<SetStateAction<boolean>>;
  setLoadingMore: Dispatch<SetStateAction<boolean>>;
  setDevices: Dispatch<SetStateAction<DeviceListItem[]>>;
  setAors: Dispatch<SetStateAction<AreaOfResponsibility[]>>;
  setUnits: Dispatch<SetStateAction<Unit[]>>;
  setUnitStats: Dispatch<SetStateAction<DeviceUnitStatRow[]>>;
  setTotal: Dispatch<SetStateAction<number>>;
  setHasMore: Dispatch<SetStateAction<boolean>>;
  setStatusCounts: Dispatch<SetStateAction<DeviceStatusCountsRsp | null>>;
  setStatus: Dispatch<SetStateAction<DevicesUiMessage>>;
  setBootstrapLoaded: Dispatch<SetStateAction<boolean>>;
};

export function createDevicesLoadActions(args: LoadArgs) {
  const loadDevices = async (
    snapshot: DevicesQuerySnapshot,
    options?: {
      includeLookups?: boolean;
      includeUnitStats?: boolean;
      append?: boolean;
      force?: boolean;
    },
  ) => {
    const includeLookups = options?.includeLookups ?? false;
    const includeUnitStats = options?.includeUnitStats ?? includeLookups;
    const append = options?.append ?? false;
    const force = options?.force ?? false;

    if (
      args.lastExecutedFullQueryKeyRef.current === snapshot.fullQueryKey &&
      !append &&
      !includeLookups &&
      !force
    ) {
      return;
    }

    const seq = ++args.requestSeqRef.current;
    const controller = new AbortController();

    if (append) {
      args.loadMoreAbortRef.current?.abort();
      args.loadMoreAbortRef.current = controller;
    } else {
      args.mainAbortRef.current?.abort();
      args.loadMoreAbortRef.current?.abort();
      args.mainAbortRef.current = controller;
    }

    const req = buildDevicesListReq({
      searchText: snapshot.globalFilter,
      filters: snapshot.filters,
      sorting: snapshot.sorting,
      limit: DEVICES_LIST_PAGE_SIZE,
      offset: append ? args.devicesLengthRef.current : 0,
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
            listAors({ sortBy: null }, controller.signal),
            getUnitsList({ signal: controller.signal }),
            getDeviceUnitStats({ signal: controller.signal }),
          ])
        : null;
      const unitStatsPromise =
        !includeLookups && includeUnitStats
          ? getDeviceUnitStats({ signal: controller.signal })
          : null;
      const rsp = await listDevices(req, { signal: controller.signal });

      if (args.requestSeqRef.current !== seq) return;

      args.setTotal(rsp.total);
      args.setHasMore(rsp.hasMore);
      args.setStatusCounts(rsp.statusCounts);
      args.setDevices((current) => (append ? [...current, ...rsp.list] : rsp.list));

      if (!append) {
        args.lastExecutedFullQueryKeyRef.current = snapshot.fullQueryKey;
      }

      if (lookupsPromise !== null) {
        try {
          const [aors, units, unitStats] = await lookupsPromise;
          if (args.requestSeqRef.current !== seq) return;
          args.setAors(aors);
          args.setUnits(units);
          args.setUnitStats(unitStats);
          args.bootstrapLoadedRef.current = true;
          args.setBootstrapLoaded(true);
        } catch (error) {
          if (controller.signal.aborted || isAbortError(error)) return;
          if (isUnauthorizedError(error)) {
            redirectToLogin();
            return;
          }
          args.setStatus({
            kind: 'error',
            text: `Помилка завантаження довідників пристроїв: ${formatDeviceErrorMessage(error)}`,
          });
        }
      }

      if (unitStatsPromise !== null) {
        try {
          const unitStats = await unitStatsPromise;
          if (args.requestSeqRef.current !== seq) return;
          args.setUnitStats(unitStats);
        } catch (error) {
          if (controller.signal.aborted || isAbortError(error)) return;
          if (isUnauthorizedError(error)) {
            redirectToLogin();
            return;
          }
          args.setStatus({
            kind: 'error',
            text: `Помилка оновлення статистики підрозділів: ${formatDeviceErrorMessage(error)}`,
          });
        }
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
        text: `Помилка завантаження пристроїв: ${formatDeviceErrorMessage(error)}`,
      });
    } finally {
      if (args.requestSeqRef.current === seq) {
        args.setLoading(false);
        args.setRefreshing(false);
        args.setLoadingMore(false);
      }
      if (append && args.loadMoreAbortRef.current === controller) {
        args.loadMoreAbortRef.current = null;
      }
      if (!append && args.mainAbortRef.current === controller) {
        args.mainAbortRef.current = null;
      }
    }
  };

  const loadMoreDevices = async () => {
    const snapshot = args.latestQuerySnapshotRef.current;
    if (snapshot === null) return;
    await loadDevices(snapshot, { append: true });
  };

  const reloadDevices = async (options?: { includeUnitStats?: boolean }) => {
    const snapshot = args.latestQuerySnapshotRef.current;
    if (snapshot === null) return;
    await loadDevices(snapshot, {
      includeLookups: !args.bootstrapLoadedRef.current,
      includeUnitStats: options?.includeUnitStats,
      force: true,
    });
  };

  const dispose = () => {
    args.mainAbortRef.current?.abort();
    args.loadMoreAbortRef.current?.abort();
  };

  return { loadDevices, loadMoreDevices, reloadDevices, dispose };
}
