import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  DeviceAnalyticsSummaryRsp,
  ListDeviceSyncSessionsReq,
  ListDeviceSyncSessionsRsp,
  SyncSummary,
} from '../../../../Bindings';
import { redirectToLogin } from '../../auth-redirect';
import { useOptionalPowerSnackbar } from '../../components/PowerSnackbar';
import { isAbortError, isUnauthorizedError } from '../../services/api/client';
import {
  getDeviceAnalyticsSummary,
  getDeviceSyncSession,
  getDeviceSyncSessionSummaries,
  listDeviceSyncSessions,
} from '../../services/api/devices';
import { toDeviceFileLoadError } from '../device-files/helpers';
import { isValidSyncId } from './url-state';

const SESSION_PAGE_SIZE = 20;
const SESSION_SUMMARY_BATCH_SIZE = 10;
type ReadOptions = {
  deviceId: string;
  enabled: boolean;
  refreshVersion: number;
  reportError: ReturnType<typeof useSessionErrorReporter>;
};

async function loadSessionWindow(
  request: ListDeviceSyncSessionsReq,
  oldestLoadedId: string | undefined,
  signal: AbortSignal,
): Promise<ListDeviceSyncSessionsRsp> {
  const sessions: SyncSummary[] = [];
  let cursor = request.cursor;
  do {
    const page = await listDeviceSyncSessions({ ...request, cursor }, { signal });
    signal.throwIfAborted();
    sessions.push(...page.sessions);
    cursor = page.nextCursor;
  } while (
    cursor !== null &&
    oldestLoadedId !== undefined &&
    !sessions.some((session) => session.syncId === oldestLoadedId)
  );
  return { sessions, nextCursor: cursor };
}

export function useSessionErrorReporter() {
  const { notify } = useOptionalPowerSnackbar();
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const reportError = useCallback((cause: unknown, prefix: string) => {
    if (isAbortError(cause)) return null;
    if (isUnauthorizedError(cause)) {
      redirectToLogin();
      return null;
    }
    const message = toDeviceFileLoadError(cause, prefix).message;
    notifyRef.current({ severity: 'error', message });
    return message;
  }, []);

  return reportError;
}

export function useSessionList({
  deviceId,
  enabled,
  reportError,
}: Omit<ReadOptions, 'refreshVersion'>) {
  const [date, setDate] = useState('');
  const [list, setList] = useState<{ key: string; rows: SyncSummary[]; cursor: string | null }>({
    key: '',
    rows: [],
    cursor: null,
  });
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listAbort = useRef<AbortController | null>(null);
  const listRef = useRef(list);
  listRef.current = list;
  const listKey = `${deviceId}:${date}`;
  const load = useCallback(
    async (append = false) => {
      if (!enabled) return;
      const cursor = append && listRef.current.key === listKey ? listRef.current.cursor : null;
      if (append && cursor === null) return;
      listAbort.current?.abort();
      const controller = new AbortController();
      listAbort.current = controller;
      setError(null);
      if (append) setLoadingMore(true);
      else {
        setLoading(true);
        setLoadingMore(false);
      }
      try {
        const from = date ? new Date(`${date}T00:00:00`) : null;
        const to = from ? new Date(from) : null;
        if (to) to.setDate(to.getDate() + 1);
        const rsp = await loadSessionWindow(
          {
            deviceId,
            createdFrom: from?.toISOString() ?? null,
            createdTo: to?.toISOString() ?? null,
            cursor,
            limit: SESSION_PAGE_SIZE,
          },
          !append && listRef.current.key === listKey
            ? listRef.current.rows.at(-1)?.syncId
            : undefined,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setList((current) => ({
          key: listKey,
          rows:
            append && current.key === listKey
              ? [
                  ...current.rows,
                  ...rsp.sessions.filter(
                    (row) => !current.rows.some((existing) => existing.syncId === row.syncId),
                  ),
                ]
              : rsp.sessions,
          cursor: rsp.nextCursor,
        }));
      } catch (cause) {
        if (!controller.signal.aborted) setError(reportError(cause, 'Помилка завантаження сесій'));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [date, deviceId, enabled, listKey, reportError],
  );

  useEffect(() => {
    if (enabled) void load();
    return () => listAbort.current?.abort();
  }, [enabled, load]);

  return {
    rows: list.key === listKey ? list.rows : [],
    date,
    setDate,
    loading: loading || (enabled && list.key !== listKey && error === null),
    loadingMore,
    error,
    nextCursor: list.key === listKey ? list.cursor : null,
    loadMore: () => load(true),
    reload: load,
  };
}

export function useSelectedSession({
  deviceId,
  syncId,
  enabled,
  refreshVersion,
  reportError,
}: ReadOptions & { syncId: string | null }) {
  const [selected, setSelected] = useState<{ key: string; session: SyncSummary | null }>({
    key: '',
    session: null,
  });
  const [selectionError, setSelectionError] = useState<{
    key: string;
    message: string | null;
  } | null>(null);
  const selectionKey = `${deviceId}:${syncId ?? 'all'}`;
  const valid = isValidSyncId(syncId);
  useEffect(() => {
    setSelectionError(null);
    if (!enabled || !valid || syncId === null) return;
    const controller = new AbortController();
    void getDeviceSyncSession({ deviceId, syncId }, { signal: controller.signal })
      .then((rsp) => {
        if (!controller.signal.aborted) setSelected({ key: selectionKey, session: rsp.sync });
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setSelectionError({
            key: selectionKey,
            message: reportError(cause, 'Помилка вибраної сесії'),
          });
      });
    return () => controller.abort();
  }, [deviceId, enabled, refreshVersion, reportError, selectionKey, syncId, valid]);

  const session = selected.key === selectionKey ? selected.session : null;
  const currentError = selectionError?.key === selectionKey ? selectionError.message : null;
  return {
    session,
    selectionError: valid ? currentError : 'Некоректний ідентифікатор сесії в URL.',
    ready: enabled && valid && (syncId === null || session !== null) && currentError === null,
  };
}

export function useSessionTotal({ deviceId, enabled, refreshVersion, reportError }: ReadOptions) {
  const [total, setTotal] = useState<{ deviceId: string; count: number } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void getDeviceAnalyticsSummary({ deviceId, syncId: null }, { signal: controller.signal })
      .then((rsp) => {
        if (!controller.signal.aborted) setTotal({ deviceId, count: rsp.totalFileCount });
      })
      .catch((cause) => {
        if (!controller.signal.aborted) reportError(cause, 'Помилка кількості файлів');
      });
    return () => controller.abort();
  }, [deviceId, enabled, refreshVersion, reportError]);

  return total?.deviceId === deviceId ? total.count : null;
}

export function useSessionStats({
  deviceId,
  idsKey,
  enabled,
  refreshVersion,
  reportError,
}: ReadOptions & { idsKey: string }) {
  const [stats, setStats] = useState<Record<string, DeviceAnalyticsSummaryRsp>>({});
  useEffect(() => {
    if (!enabled || idsKey === '') return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        const ids = idsKey.split(',');
        const next: Record<string, DeviceAnalyticsSummaryRsp> = {};
        for (let offset = 0; offset < ids.length; offset += SESSION_SUMMARY_BATCH_SIZE) {
          const rsp = await getDeviceSyncSessionSummaries(
            { deviceId, syncIds: ids.slice(offset, offset + SESSION_SUMMARY_BATCH_SIZE) },
            { signal: controller.signal },
          );
          if (controller.signal.aborted) return;
          for (const item of rsp.summaries) next[`${deviceId}:${item.syncId}`] = item.analysis;
        }
        setStats((current) => ({ ...current, ...next }));
      })().catch((cause) => {
        if (!controller.signal.aborted) reportError(cause, 'Помилка підсумків сесій');
      });
    }, 100);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [deviceId, enabled, idsKey, refreshVersion, reportError]);

  return stats;
}
