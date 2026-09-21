import { useCallback, useEffect, useState } from 'react';
import {
  useSelectedSession,
  useSessionErrorReporter,
  useSessionList,
  useSessionStats,
  useSessionTotal,
} from './use-device-sync-sessions.load';

const SESSION_POLL_MS = 15_000;

export function useDeviceSyncSessions({
  deviceId,
  syncId,
  enabled,
  open,
}: {
  deviceId: string;
  syncId: string | null;
  enabled: boolean;
  open: boolean;
}) {
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const reportError = useSessionErrorReporter();
  const selected = useSelectedSession({ deviceId, syncId, enabled, refreshVersion, reportError });
  const list = useSessionList({ deviceId, enabled: enabled && open, reportError });
  const availableIds = new Set(list.rows.map((row) => row.syncId));
  const idsKey = [
    ...new Set([
      ...visibleIds.filter((id) => availableIds.has(id)),
      ...(selected.session ? [selected.session.syncId] : []),
    ]),
  ]
    .sort()
    .join(',');
  const stats = useSessionStats({
    deviceId,
    idsKey,
    enabled: enabled && open,
    refreshVersion,
    reportError,
  });
  const total = useSessionTotal({
    deviceId,
    enabled: enabled && open,
    refreshVersion,
    reportError,
  });
  const refresh = useCallback(() => {
    setRefreshVersion((value) => value + 1);
    void list.reload();
  }, [list.reload]);
  const pending = [...list.rows, ...(selected.session ? [selected.session] : [])].some((row) => {
    const summary = stats[`${deviceId}:${row.syncId}`];
    return row.status === 'open' || (summary && summary.analyzedFileCount < summary.totalFileCount);
  });
  useEffect(() => {
    if (!enabled || !open || !pending) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) refresh();
    }, SESSION_POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, open, pending, refresh]);
  return { ...list, ...selected, stats, total, refresh, refreshVersion, setVisibleIds };
}

export type DeviceSyncSessionsState = ReturnType<typeof useDeviceSyncSessions>;
