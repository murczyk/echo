import { useCallback, useEffect, useRef, useState } from 'react';

import type { DeviceFileJournalEntry } from '../../../../Bindings';
import { redirectToLogin } from '../../auth-redirect';
import { isAbortError, isUnauthorizedError } from '../../services/api/client';
import { journalDeviceFiles } from '../../services/api/devices';
import { toDeviceFileLoadError } from './helpers';
import {
  DEVICE_FILE_PAGE_SIZE,
  type DeviceAnalyticsTagFilter,
  type DeviceFileLoadError,
} from './types';

export type DeviceFileJournalState = {
  entries: DeviceFileJournalEntry[];
  totalCount: number | null;
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: DeviceFileLoadError | null;
  loadMoreError: DeviceFileLoadError | null;
  reload: () => Promise<void>;
  loadMore: () => Promise<void>;
};

function appendJournalEntries(
  current: DeviceFileJournalEntry[],
  incoming: DeviceFileJournalEntry[],
): DeviceFileJournalEntry[] {
  const knownFileIds = new Set(current.map((entry) => entry.fileId));
  return [...current, ...incoming.filter((entry) => !knownFileIds.has(entry.fileId))];
}

export function useDeviceFileJournal({
  deviceId,
  enabled,
  tagFilter,
}: {
  deviceId: string;
  enabled: boolean;
  tagFilter: DeviceAnalyticsTagFilter;
}): DeviceFileJournalState {
  const [entries, setEntries] = useState<DeviceFileJournalEntry[]>([]);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<DeviceFileLoadError | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<DeviceFileLoadError | null>(null);
  const nextCursorRef = useRef<string | null>(null);
  const requestSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const tagFilterKey = JSON.stringify(tagFilter);
  const tagFilterRef = useRef(tagFilter);
  tagFilterRef.current = tagFilter;

  const load = useCallback(
    async (append: boolean) => {
      if (!enabled) return;
      const cursor = append ? nextCursorRef.current : null;
      if (append && cursor === null) return;

      const seq = ++requestSeqRef.current;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      if (append) {
        setLoadingMore(true);
        setLoadMoreError(null);
      } else {
        setLoading(true);
        setError(null);
        setLoadMoreError(null);
        nextCursorRef.current = null;
        setNextCursor(null);
        setEntries([]);
        setTotalCount(null);
      }

      const currentTagFilter = tagFilterRef.current;
      try {
        const rsp = await journalDeviceFiles(
          {
            deviceId,
            limit: DEVICE_FILE_PAGE_SIZE,
            cursor,
            tagIds: currentTagFilter.tagIds.length === 0 ? null : currentTagFilter.tagIds,
            tagMatch: currentTagFilter.tagIds.length === 0 ? null : currentTagFilter.tagMatch,
            untagged: currentTagFilter.untagged || null,
          },
          { signal: controller.signal },
        );
        if (requestSeqRef.current !== seq || controller.signal.aborted) return;

        setEntries((current) =>
          append ? appendJournalEntries(current, rsp.entries) : rsp.entries,
        );
        nextCursorRef.current = rsp.nextCursor;
        setNextCursor(rsp.nextCursor);
        setTotalCount(rsp.totalCount);
      } catch (loadError) {
        if (requestSeqRef.current !== seq || controller.signal.aborted || isAbortError(loadError)) {
          return;
        }
        if (isUnauthorizedError(loadError)) {
          redirectToLogin();
          return;
        }
        const journalError = toDeviceFileLoadError(
          loadError,
          'Помилка завантаження журналу синхронізації',
        );
        if (append) setLoadMoreError(journalError);
        else setError(journalError);
      } finally {
        if (requestSeqRef.current === seq) {
          setLoading(false);
          setLoadingMore(false);
        }
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [deviceId, enabled, tagFilterKey],
  );

  useEffect(() => {
    requestSeqRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    nextCursorRef.current = null;
    setEntries([]);
    setNextCursor(null);
    setTotalCount(null);
    setLoading(false);
    setLoadingMore(false);
    setError(null);
    setLoadMoreError(null);
    if (enabled) void load(false);

    return () => {
      requestSeqRef.current += 1;
      abortRef.current?.abort();
    };
  }, [deviceId, enabled, load]);

  return {
    entries,
    totalCount,
    nextCursor,
    loading,
    loadingMore,
    error,
    loadMoreError,
    reload: () => load(false),
    loadMore: () => load(true),
  };
}
