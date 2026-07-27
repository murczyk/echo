import { useCallback, useEffect, useRef } from 'react';

type ReconcileBatch = (
  messageIds: number[],
  shouldApply: (messageId: number) => boolean,
  signal: AbortSignal,
) => Promise<void>;

export function useTargetedInboxReconciliation(reconcileBatch: ReconcileBatch) {
  const reconcileBatchRef = useRef(reconcileBatch);
  const requestedVersionsRef = useRef(new Map<number, number>());
  const pendingIdsRef = useRef(new Set<number>());
  const runningRef = useRef(false);
  const mountedRef = useRef(true);
  const abortControllerRef = useRef<AbortController | null>(null);
  const drainPromiseRef = useRef<Promise<void>>(Promise.resolve());
  const resolveDrainRef = useRef<(() => void) | null>(null);

  reconcileBatchRef.current = reconcileBatch;

  const drain = useCallback(async () => {
    try {
      while (mountedRef.current && pendingIdsRef.current.size > 0) {
        const messageIds = Array.from(pendingIdsRef.current);
        pendingIdsRef.current.clear();
        const requestedVersions = new Map(
          messageIds.map((messageId) => [
            messageId,
            requestedVersionsRef.current.get(messageId) ?? 0,
          ]),
        );
        const abortController = new AbortController();
        abortControllerRef.current = abortController;

        await reconcileBatchRef.current(
          messageIds,
          (messageId) =>
            mountedRef.current &&
            requestedVersionsRef.current.get(messageId) === requestedVersions.get(messageId),
          abortController.signal,
        );

        messageIds.forEach((messageId) => {
          if (requestedVersionsRef.current.get(messageId) === requestedVersions.get(messageId)) {
            requestedVersionsRef.current.delete(messageId);
          }
        });
      }
    } finally {
      runningRef.current = false;
      abortControllerRef.current = null;
      resolveDrainRef.current?.();
      resolveDrainRef.current = null;
    }
  }, []);

  const scheduleReconciliation = useCallback(
    (messageIds: number[]) => {
      messageIds.forEach((messageId) => {
        requestedVersionsRef.current.set(
          messageId,
          (requestedVersionsRef.current.get(messageId) ?? 0) + 1,
        );
        pendingIdsRef.current.add(messageId);
      });
      if (messageIds.length === 0 || !mountedRef.current) return Promise.resolve();

      if (!runningRef.current) {
        runningRef.current = true;
        drainPromiseRef.current = new Promise<void>((resolve) => {
          resolveDrainRef.current = resolve;
        });
        queueMicrotask(() => void drain());
      }
      return drainPromiseRef.current;
    },
    [drain],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingIdsRef.current.clear();
      requestedVersionsRef.current.clear();
      abortControllerRef.current?.abort();
      resolveDrainRef.current?.();
      resolveDrainRef.current = null;
    };
  }, []);

  return scheduleReconciliation;
}
