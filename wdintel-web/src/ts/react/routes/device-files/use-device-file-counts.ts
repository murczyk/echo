import { useCallback, useEffect, useRef, useState } from 'react';

import { redirectToLogin } from '../../auth-redirect';
import { isAbortError, isUnauthorizedError } from '../../services/api/client';
import { countDeviceFileSubtrees } from '../../services/api/devices';
import { toDeviceFileLoadError } from './helpers';
import { DEVICE_FILE_SUBTREE_COUNT_BATCH_SIZE, type DeviceFileLoadError } from './types';
type DeviceFileCountScope = {
  parentEntryId: string | null;
  directoryEntryIds: string[];
};

type QueuedDeviceFileCountScope = DeviceFileCountScope & {
  deviceId: string;
  generation: number;
};

export type DeviceFileCountsState = {
  countsByEntryId: Record<string, number>;
  loading: boolean;
  error: DeviceFileLoadError | null;
  enqueue: (scope: DeviceFileCountScope) => void;
  retry: () => void;
  reset: () => void;
};

export function useDeviceFileCounts({
  deviceId,
  enabled,
}: {
  deviceId: string;
  enabled: boolean;
}): DeviceFileCountsState {
  const [countsByEntryId, setCountsByEntryId] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<DeviceFileLoadError | null>(null);
  const generationRef = useRef(0);
  const queueRef = useRef<QueuedDeviceFileCountScope[]>([]);
  const failedScopesRef = useRef<DeviceFileCountScope[]>([]);
  const scheduledEntryIdsRef = useRef(new Set<string>());
  const pendingRequestCountRef = useRef(0);
  const activeControllerRef = useRef<AbortController | null>(null);
  const drainingRef = useRef(false);

  const drainQueue = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;

    try {
      while (queueRef.current.length > 0) {
        const scope = queueRef.current.shift();
        if (!scope || scope.generation !== generationRef.current) continue;

        const controller = new AbortController();
        activeControllerRef.current = controller;

        try {
          const rsp = await countDeviceFileSubtrees(
            {
              deviceId: scope.deviceId,
              parentEntryId: scope.parentEntryId,
              directoryEntryIds: scope.directoryEntryIds,
            },
            { signal: controller.signal },
          );
          if (scope.generation !== generationRef.current || controller.signal.aborted) continue;

          const requestedEntryIds = new Set(scope.directoryEntryIds);
          const responseEntryIds = new Set(rsp.counts.map((count) => count.entryId));
          if (
            rsp.counts.length !== requestedEntryIds.size ||
            responseEntryIds.size !== requestedEntryIds.size ||
            [...responseEntryIds].some((entryId) => !requestedEntryIds.has(entryId))
          ) {
            throw new Error('subtree count response does not match the requested directories');
          }

          setCountsByEntryId((current) => {
            const next = { ...current };
            for (const count of rsp.counts) next[count.entryId] = count.fileCount;
            return next;
          });
        } catch (loadError) {
          if (
            scope.generation !== generationRef.current ||
            controller.signal.aborted ||
            isAbortError(loadError)
          ) {
            continue;
          }
          for (const entryId of scope.directoryEntryIds) {
            scheduledEntryIdsRef.current.delete(entryId);
          }
          if (isUnauthorizedError(loadError)) {
            redirectToLogin();
          } else {
            failedScopesRef.current.push({
              parentEntryId: scope.parentEntryId,
              directoryEntryIds: scope.directoryEntryIds,
            });
            setError(toDeviceFileLoadError(loadError, 'Помилка завантаження кількості файлів'));
          }
        } finally {
          if (activeControllerRef.current === controller) activeControllerRef.current = null;
          if (scope.generation === generationRef.current) {
            pendingRequestCountRef.current -= 1;
            setLoading(pendingRequestCountRef.current > 0);
          }
        }
      }
    } finally {
      drainingRef.current = false;
    }
  }, []);

  const enqueue = useCallback(
    ({ parentEntryId, directoryEntryIds }: DeviceFileCountScope) => {
      if (!enabled) return;

      const unscheduledEntryIds = [...new Set(directoryEntryIds)].filter(
        (entryId) => !scheduledEntryIdsRef.current.has(entryId),
      );
      if (unscheduledEntryIds.length === 0) return;

      for (const entryId of unscheduledEntryIds) {
        scheduledEntryIdsRef.current.add(entryId);
      }
      for (
        let offset = 0;
        offset < unscheduledEntryIds.length;
        offset += DEVICE_FILE_SUBTREE_COUNT_BATCH_SIZE
      ) {
        queueRef.current.push({
          deviceId,
          generation: generationRef.current,
          parentEntryId,
          directoryEntryIds: unscheduledEntryIds.slice(
            offset,
            offset + DEVICE_FILE_SUBTREE_COUNT_BATCH_SIZE,
          ),
        });
        pendingRequestCountRef.current += 1;
      }
      setLoading(true);
      void drainQueue();
    },
    [deviceId, drainQueue, enabled],
  );

  const retry = useCallback(() => {
    const failedScopes = failedScopesRef.current;
    failedScopesRef.current = [];
    setError(null);
    for (const scope of failedScopes) enqueue(scope);
  }, [enqueue]);

  const reset = useCallback(() => {
    generationRef.current += 1;
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;
    queueRef.current = [];
    failedScopesRef.current = [];
    scheduledEntryIdsRef.current.clear();
    pendingRequestCountRef.current = 0;
    setCountsByEntryId({});
    setLoading(false);
    setError(null);
  }, []);

  useEffect(() => {
    reset();
  }, [deviceId, enabled, reset]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      activeControllerRef.current?.abort();
      queueRef.current = [];
    },
    [],
  );

  return { countsByEntryId, loading, error, enqueue, retry, reset };
}
