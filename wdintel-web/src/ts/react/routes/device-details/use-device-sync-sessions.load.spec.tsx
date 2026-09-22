/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import type { SyncSummary } from '../../../../Bindings';
import { listDeviceSyncSessions } from '../../services/api/devices';
import { useSessionList } from './use-device-sync-sessions.load';

vi.mock('../../services/api/devices', () => ({ listDeviceSyncSessions: vi.fn() }));

it('#3390 preserves loaded older sessions when polling inserts a new first page', async () => {
  const session = (syncId: string) => ({ syncId }) as SyncSummary;
  const list = vi.mocked(listDeviceSyncSessions);
  list
    .mockResolvedValueOnce({ sessions: [session('first')], nextCursor: 'page-2' })
    .mockResolvedValueOnce({ sessions: [session('oldest')], nextCursor: null })
    .mockResolvedValueOnce({ sessions: [session('new')], nextCursor: 'refresh-2' })
    .mockResolvedValueOnce({ sessions: [session('first')], nextCursor: 'refresh-3' })
    .mockResolvedValueOnce({ sessions: [session('oldest')], nextCursor: null })
    .mockResolvedValueOnce({ sessions: [], nextCursor: null });
  const reportError = vi.fn();
  let state: ReturnType<typeof useSessionList>;
  function Harness() {
    state = useSessionList({ deviceId: 'device', enabled: true, reportError });
    return null;
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => state.loadMore());
    expect(state!.rows.map((row) => row.syncId)).toEqual(['first', 'oldest']);
    await act(async () => state.reload());
    expect(state!.rows.map((row) => row.syncId)).toEqual(['new', 'first', 'oldest']);
    expect(state!.nextCursor).toBeNull();
    expect(list.mock.calls.slice(2, 5).map(([request]) => request.cursor)).toEqual([
      null,
      'refresh-2',
      'refresh-3',
    ]);
    await act(async () => state.setDate('2026-09-21'));
    expect(state!.rows).toEqual([]);
    expect(list.mock.calls.at(-1)?.[0].cursor).toBeNull();
    expect(reportError).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});
