import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeviceAudio, ListDeviceAudioReq } from '../../../../Bindings';
import { useOptionalPowerSnackbar } from '../../components/PowerSnackbar';
import { listDeviceAudio } from '../../services/api/device-audio';
import { isAbortError } from '../../services/api/client';
import { formatDeviceErrorMessage } from '../devices/helpers';
import { useDeviceAudioProcessing } from './use-device-audio-processing';

type ListState = {
  scope: string;
  rows: DeviceAudio[];
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  loadMoreError: string | null;
  ready: boolean;
  selectedAudioId: string | null;
};
type ListIntent = {
  deviceId: string;
  canRead: boolean;
  filter: boolean;
  cursor: string | null;
  more: boolean;
  restoreSelection: boolean;
};
function emptyState(scope: string): ListState {
  return {
    scope,
    rows: [],
    nextCursor: null,
    loading: false,
    loadingMore: false,
    error: null,
    loadMoreError: null,
    ready: false,
    selectedAudioId: null,
  };
}

async function readAudioPages(
  req: ListDeviceAudioReq,
  signal: AbortSignal,
  restoreSelection: () => string | null,
) {
  let response = await listDeviceAudio(req, { signal });
  const rows = new Map(response.audio.map((audio) => [audio.id, audio]));
  let restoreAudioId = restoreSelection();
  while (restoreAudioId && !rows.has(restoreAudioId) && response.nextCursor && !signal.aborted) {
    response = await listDeviceAudio({ ...req, cursor: response.nextCursor }, { signal });
    for (const audio of response.audio) rows.set(audio.id, audio);
    restoreAudioId = restoreSelection();
  }
  return { audio: [...rows.values()], nextCursor: response.nextCursor };
}

export function useDeviceAudio(deviceId: string, canRead: boolean, active = true) {
  const [unprocessedOnly, commitFilter] = useState(false);
  const scope = `${deviceId}:${unprocessedOnly}:${canRead}`;
  const [stored, setStored] = useState(() => emptyState(scope));
  const current = stored.scope === scope && canRead ? stored : emptyState(scope);
  const currentRef = useRef(current);
  currentRef.current = current;
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const listIntent = useRef<ListIntent | null>(null);
  const failedFirstPageFilter = useRef<boolean | null>(null);
  const { notify } = useOptionalPowerSnackbar();
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const confirmProcessing = useCallback(
    (audio: DeviceAudio, previousAudio?: DeviceAudio) => {
      const membershipChanged =
        unprocessedOnly &&
        previousAudio !== undefined &&
        previousAudio.processed !== audio.processed;
      const interrupted = listIntent.current;
      ++sequence.current;
      controller.current?.abort();
      pending.current = false;
      setStored((previous) => {
        if (previous.scope !== scope) return previous;
        const rows = previous.rows
          .map((row) =>
            row.id === audio.id
              ? { ...row, processed: audio.processed, processingVersion: audio.processingVersion }
              : row,
          )
          .filter((row) => !unprocessedOnly || !row.processed);
        return {
          ...previous,
          rows,
          nextCursor: membershipChanged ? null : previous.nextCursor,
          loading: false,
          loadingMore: false,
        };
      });
      if (membershipChanged || interrupted) {
        const targetFilter = interrupted?.filter ?? unprocessedOnly;
        listIntent.current = {
          deviceId,
          canRead,
          filter: targetFilter,
          cursor: null,
          more: false,
          restoreSelection: true,
        };
        void loadPageRef.current(null, false, targetFilter, true);
      }
    },
    [deviceId, canRead, scope, unprocessedOnly],
  );
  const processing = useDeviceAudioProcessing(deviceId, canRead, {
    row: (id) => currentRef.current.rows.find((row) => row.id === id),
    confirm: confirmProcessing,
  });

  const loadPage = useCallback(
    async (
      cursor: string | null,
      more: boolean,
      targetFilter = unprocessedOnly,
      restoreSelection = false,
    ) => {
      const targetScope = `${deviceId}:${targetFilter}:${canRead}`;
      if (!canRead || !active || (more && pending.current)) return;
      const seq = ++sequence.current;
      controller.current?.abort();
      const request = new AbortController();
      controller.current = request;
      pending.current = true;
      listIntent.current = {
        deviceId,
        canRead,
        filter: targetFilter,
        cursor,
        more,
        restoreSelection,
      };
      setStored((previous) => {
        const next = previous.scope === scope ? previous : emptyState(scope);
        return more
          ? { ...next, loadingMore: true, loadMoreError: null }
          : {
              ...next,
              loading: true,
              error: null,
              loadingMore: false,
              loadMoreError: null,
            };
      });
      try {
        const response = await readAudioPages(
          { deviceId, unprocessedOnly: targetFilter, limit: 50, cursor },
          request.signal,
          () => {
            const selectedId = currentRef.current.selectedAudioId;
            const selected = selectedId && processing.processingAudio(selectedId);
            return restoreSelection && selected && (!targetFilter || !selected.processed)
              ? selected.id
              : null;
          },
        );
        if (sequence.current !== seq || request.signal.aborted) return;
        processing.acceptProcessingPage(response.audio);
        if (!more) failedFirstPageFilter.current = null;
        commitFilter(targetFilter);
        setStored((previous) => {
          const rows = more ? [...previous.rows] : [];
          const ids = new Set(rows.map((row) => row.id));
          for (const row of response.audio) {
            if (!ids.has(row.id)) {
              rows.push(row);
              ids.add(row.id);
            }
          }
          return {
            ...previous,
            scope: targetScope,
            rows,
            nextCursor: response.nextCursor,
            ready: true,
            selectedAudioId:
              previous.scope.split(':')[0] === deviceId ? previous.selectedAudioId : null,
          };
        });
      } catch (error) {
        if (sequence.current !== seq || request.signal.aborted || isAbortError(error)) return;
        const message = `Помилка завантаження аудіо: ${formatDeviceErrorMessage(error)}`;
        if (!more) failedFirstPageFilter.current = targetFilter;
        setStored((previous) =>
          more ? { ...previous, loadMoreError: message } : { ...previous, error: message },
        );
        notifyRef.current({ severity: 'error', message });
      } finally {
        if (sequence.current === seq) {
          pending.current = false;
          listIntent.current = null;
          setStored((previous) => ({ ...previous, loading: false, loadingMore: false }));
        }
      }
    },
    [deviceId, canRead, active, unprocessedOnly, scope],
  );

  const loadPageRef = useRef(loadPage);
  loadPageRef.current = loadPage;
  useEffect(() => {
    setStored((previous) => (previous.scope === scope ? previous : emptyState(scope)));
    const interrupted = listIntent.current;
    if (interrupted && (interrupted.deviceId !== deviceId || interrupted.canRead !== canRead))
      listIntent.current = null;
    if (active) {
      const intent = listIntent.current;
      if (intent)
        void loadPageRef.current(
          intent.cursor,
          intent.more,
          intent.filter,
          intent.restoreSelection,
        );
      else if (!currentRef.current.ready) void loadPageRef.current(null, false);
    }
    return () => {
      ++sequence.current;
      controller.current?.abort();
      pending.current = false;
      setStored((previous) => ({ ...previous, loading: false, loadingMore: false }));
      failedFirstPageFilter.current = null;
    };
  }, [deviceId, canRead, active]);

  const reload = useCallback(() => loadPage(null, false), [loadPage]);
  const retry = useCallback(
    () => loadPage(null, false, failedFirstPageFilter.current ?? unprocessedOnly),
    [loadPage, unprocessedOnly],
  );
  const loadMore = useCallback(async () => {
    const next = currentRef.current;
    if (!next.loading && next.nextCursor !== null) await loadPage(next.nextCursor, true);
  }, [loadPage]);
  const selectAudio = useCallback(
    (id: string | null) => {
      setStored((previous) =>
        previous.scope === scope && (id === null || previous.rows.some((row) => row.id === id))
          ? { ...previous, selectedAudioId: id }
          : previous,
      );
    },
    [scope],
  );
  const setUnprocessedOnly = useCallback(
    (target: boolean) => {
      void loadPage(null, false, target);
    },
    [loadPage],
  );
  return {
    ...current,
    ...processing,
    unprocessedOnly,
    setUnprocessedOnly,
    selectAudio,
    reload,
    retry,
    loadMore,
  };
}
export type DeviceAudioState = ReturnType<typeof useDeviceAudio>;
