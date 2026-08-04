import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { MRT_SortingState } from 'material-react-table';

import type { DeviceListItem, DeviceStatusCounts } from '../../../../Bindings';
import { redirectToLogin } from '../../auth-redirect';
import { isAbortError, isUnauthorizedError } from '../../services/api/client';
import { listDevices } from '../../services/api/devices';
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
  mainAbortRef: MutableRefObject<AbortController | null>;
  loadMoreAbortRef: MutableRefObject<AbortController | null>;
  devicesLengthRef: MutableRefObject<number>;
  lastExecutedFullQueryKeyRef: MutableRefObject<string | null>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setRefreshing: Dispatch<SetStateAction<boolean>>;
  setLoadingMore: Dispatch<SetStateAction<boolean>>;
  setDevices: Dispatch<SetStateAction<DeviceListItem[]>>;
  setTotal: Dispatch<SetStateAction<number>>;
  setHasMore: Dispatch<SetStateAction<boolean>>;
  setStatusCounts: Dispatch<SetStateAction<DeviceStatusCounts | null>>;
  setStatus: Dispatch<SetStateAction<DevicesUiMessage>>;
};

export function createDevicesLoadActions(args: LoadArgs) {
  const loadDevices = async (
    snapshot: DevicesQuerySnapshot,
    options?: { append?: boolean; force?: boolean },
  ) => {
    const append = options?.append ?? false;
    const force = options?.force ?? false;

    if (args.lastExecutedFullQueryKeyRef.current === snapshot.fullQueryKey && !append && !force) {
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
    const initialLoad = !append && args.lastExecutedFullQueryKeyRef.current === null;

    if (initialLoad) {
      args.setLoading(true);
    } else if (append) {
      args.setLoadingMore(true);
    } else {
      args.setRefreshing(true);
    }
    args.setStatus(null);

    try {
      const rsp = await listDevices(req, { signal: controller.signal });
      if (args.requestSeqRef.current !== seq) return;

      args.setTotal(rsp.total);
      args.setHasMore(rsp.hasMore);
      args.setStatusCounts(rsp.statusCounts);
      args.setDevices((current) => (append ? [...current, ...rsp.list] : rsp.list));
      if (!append) args.lastExecutedFullQueryKeyRef.current = snapshot.fullQueryKey;
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

  const reloadDevices = async () => {
    const snapshot = args.latestQuerySnapshotRef.current;
    if (snapshot === null) return;
    await loadDevices(snapshot, { force: true });
  };

  const dispose = () => {
    args.mainAbortRef.current?.abort();
    args.loadMoreAbortRef.current?.abort();
  };

  return { loadDevices, loadMoreDevices, reloadDevices, dispose };
}
