import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { MRT_SortingState } from 'material-react-table';

import type { DeviceListItem, DeviceStatusCounts, ListDevicesRsp } from '../../../../Bindings';
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
  retry?: 'append' | 'reload';
} | null;

type LoadArgs = {
  latestQuerySnapshotRef: MutableRefObject<DevicesQuerySnapshot | null>;
  requestSeqRef: MutableRefObject<number>;
  mainAbortRef: MutableRefObject<AbortController | null>;
  loadMoreAbortRef: MutableRefObject<AbortController | null>;
  devicesLengthRef: MutableRefObject<number>;
  startOffsetRef: MutableRefObject<number>;
  hasMoreRef: MutableRefObject<boolean>;
  setStartOffset: Dispatch<SetStateAction<number>>;
  setPageRevision: Dispatch<SetStateAction<number>>;
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
    options?: { append?: boolean; force?: boolean; offset?: number },
  ) => {
    const append = options?.append ?? false;
    const force = options?.force ?? false;
    const offset = append
      ? args.startOffsetRef.current + args.devicesLengthRef.current
      : (options?.offset ?? 0);
    if (
      append &&
      (!args.hasMoreRef.current ||
        args.mainAbortRef.current ||
        args.loadMoreAbortRef.current ||
        args.lastExecutedFullQueryKeyRef.current !== snapshot.fullQueryKey)
    )
      return;

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
      offset,
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
      if (!isCurrentQuery(args, snapshot, seq) || controller.signal.aborted) return;
      if (!append && offset > 0 && offset >= rsp.total) {
        await loadDevices(snapshot, {
          force: true,
          offset:
            Math.max(0, Math.ceil(rsp.total / DEVICES_LIST_PAGE_SIZE) - 1) * DEVICES_LIST_PAGE_SIZE,
        });
        return;
      }
      applyLoadedDevices(args, snapshot, rsp, offset, append);
    } catch (error) {
      if (!isCurrentQuery(args, snapshot, seq)) return;
      if (controller.signal.aborted || isAbortError(error)) return;
      if (isUnauthorizedError(error)) {
        redirectToLogin();
        return;
      }
      args.setStatus({
        kind: 'error',
        retry: append ? 'append' : 'reload',
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
    await loadDevices(snapshot, {
      force: true,
      offset:
        args.lastExecutedFullQueryKeyRef.current === snapshot.fullQueryKey
          ? args.startOffsetRef.current
          : 0,
    });
  };

  const loadPageDevices = async (pageIndex: number) => {
    const snapshot = args.latestQuerySnapshotRef.current;
    if (
      snapshot === null ||
      args.mainAbortRef.current ||
      args.loadMoreAbortRef.current ||
      args.lastExecutedFullQueryKeyRef.current !== snapshot.fullQueryKey
    )
      return;
    await loadDevices(snapshot, {
      force: true,
      offset: Math.max(0, pageIndex) * DEVICES_LIST_PAGE_SIZE,
    });
  };

  const dispose = () => {
    args.mainAbortRef.current?.abort();
    args.loadMoreAbortRef.current?.abort();
  };

  return { loadDevices, loadMoreDevices, reloadDevices, loadPageDevices, dispose };
}

function isCurrentQuery(args: LoadArgs, snapshot: DevicesQuerySnapshot, seq: number): boolean {
  return (
    args.requestSeqRef.current === seq &&
    args.latestQuerySnapshotRef.current?.fullQueryKey === snapshot.fullQueryKey
  );
}

function applyLoadedDevices(
  args: LoadArgs,
  snapshot: DevicesQuerySnapshot,
  rsp: ListDevicesRsp,
  offset: number,
  append: boolean,
) {
  args.devicesLengthRef.current = append
    ? args.devicesLengthRef.current + rsp.list.length
    : rsp.list.length;
  args.hasMoreRef.current = rsp.hasMore;
  args.setTotal(rsp.total);
  args.setHasMore(rsp.hasMore);
  args.setStatusCounts(rsp.statusCounts);
  args.setDevices((current) => (append ? [...current, ...rsp.list] : rsp.list));
  if (!append) {
    args.startOffsetRef.current = offset;
    args.setStartOffset(offset);
    args.setPageRevision((revision) => revision + 1);
    args.lastExecutedFullQueryKeyRef.current = snapshot.fullQueryKey;
  }
}
