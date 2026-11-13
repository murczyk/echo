import { useCallback, useEffect, useRef, useState } from 'react';
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
  const [readVersion, setReadVersion] = useState(0);
  const reportError = useSessionErrorReporter();
  const selected = useSelectedSession({
    deviceId,
    syncId,
    enabled,
    refreshVersion: readVersion,
    reportError,
  });
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
    refreshVersion: readVersion,
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
    setReadVersion((value) => value + 1);
    void list.reload();
  }, [list.reload]);
  const pending = [...list.rows, ...(selected.session ? [selected.session] : [])].some((row) => {
    const summary = stats[`${deviceId}:${row.syncId}`];
    return row.status === 'open' || (summary && summary.analyzedFileCount < summary.totalFileCount);
  });
  useEffect(() => {
    if (!enabled || !open || !pending) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) {
        setReadVersion((value) => value + 1);
        void list.reload();
      }
    }, SESSION_POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, open, pending, list.reload]);

  const observed = useRef<{
    scope: string;
    firstId?: string;
    rows: Map<string, { metadata: string; content: string | null }>;
  }>({ scope: '', rows: new Map() });
  useEffect(() => {
    const scope = `${deviceId}:${syncId ?? 'all'}:${list.date}`;
    const previous = observed.current.scope === scope ? observed.current : null;
    const rows = syncId === null ? list.rows : selected.session ? [selected.session] : [];
    const next = new Map<string, { metadata: string; content: string | null }>();
    let changed = Boolean(
      previous?.firstId && rows[0]?.syncId && previous.firstId !== rows[0].syncId,
    );
    for (const row of rows) {
      const summary = stats[`${deviceId}:${row.syncId}`];
      const value = {
        metadata: JSON.stringify([row.counts, row.status]),
        content: summary
          ? JSON.stringify([summary.totalFileCount, summary.filesWithContentCount, summary.items])
          : null,
      };
      const old = previous?.rows.get(row.syncId);
      if (
        old &&
        (old.metadata !== value.metadata ||
          (old.content !== null && value.content !== null && old.content !== value.content))
      )
        changed = true;
      next.set(row.syncId, value);
    }
    observed.current = { scope, firstId: rows[0]?.syncId, rows: next };
    if (changed) setRefreshVersion((value) => value + 1);
  }, [deviceId, syncId, list.date, list.rows, selected.session, stats]);
  return { ...list, ...selected, stats, total, refresh, refreshVersion, setVisibleIds };
}

export type DeviceSyncSessionsState = ReturnType<typeof useDeviceSyncSessions>;
