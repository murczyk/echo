import { notifyMessageReplyPoll } from '../shared/message-replies/events';
import { useCallback, useEffect, useRef } from 'react';
import { ANALYSIS_MESSAGE_RECONCILIATION_INTERVAL_MS } from './config';

type ReconcileBatch = (
  messageIds: number[],
  shouldApply: (messageId: number) => boolean,
  signal: AbortSignal,
) => Promise<void>;

export function useTargetedInboxReconciliation(reconcileBatch: ReconcileBatch, scopeKey = '') {
  const reconcileBatchRef = useRef(reconcileBatch);
  const requestedVersionsRef = useRef(new Map<number, number>());
  const pendingIdsRef = useRef(new Set<number>());
  const immediateIdsRef = useRef(new Set<number>());
  const runningRef = useRef(false);
  const mountedRef = useRef(true);
  const abortControllerRef = useRef<AbortController | null>(null);
  const drainPromiseRef = useRef<Promise<void>>(Promise.resolve());
  const resolveDrainRef = useRef<(() => void) | null>(null);
  const generationRef = useRef(0);
  const lastStartedAtRef = useRef(Number.NEGATIVE_INFINITY);
  const waitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resolveWaitRef = useRef<(() => void) | null>(null);

  reconcileBatchRef.current = reconcileBatch;

  const releaseWait = useCallback(() => {
    if (waitTimeoutRef.current !== null) clearTimeout(waitTimeoutRef.current);
    waitTimeoutRef.current = null;
    resolveWaitRef.current?.();
    resolveWaitRef.current = null;
  }, []);

  const waitForNextBatch = useCallback(() => {
    const waitMs =
      lastStartedAtRef.current + ANALYSIS_MESSAGE_RECONCILIATION_INTERVAL_MS - performance.now();
    if (immediateIdsRef.current.size > 0 || waitMs <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      resolveWaitRef.current = resolve;
      waitTimeoutRef.current = setTimeout(releaseWait, waitMs);
    });
  }, [releaseWait]);

  const drain = useCallback(
    async (generation: number) => {
      try {
        while (
          mountedRef.current &&
          generationRef.current === generation &&
          pendingIdsRef.current.size > 0
        ) {
          await waitForNextBatch();
          if (!mountedRef.current || generationRef.current !== generation) return;
          const messageIds = Array.from(
            new Set([...immediateIdsRef.current, ...pendingIdsRef.current]),
          );
          messageIds.forEach((messageId) => {
            pendingIdsRef.current.delete(messageId);
            immediateIdsRef.current.delete(messageId);
          });
          const requestedVersions = new Map(
            messageIds.map((messageId) => [
              messageId,
              requestedVersionsRef.current.get(messageId) ?? 0,
            ]),
          );
          const abortController = new AbortController();
          abortControllerRef.current = abortController;
          lastStartedAtRef.current = performance.now();
          notifyMessageReplyPoll('Analysis');

          try {
            await reconcileBatchRef.current(
              messageIds,
              (messageId) =>
                mountedRef.current &&
                generationRef.current === generation &&
                requestedVersionsRef.current.get(messageId) === requestedVersions.get(messageId),
              abortController.signal,
            );
          } catch (error) {
            console.error(error);
          }
          if (generationRef.current !== generation) return;

          messageIds.forEach((messageId) => {
            if (requestedVersionsRef.current.get(messageId) === requestedVersions.get(messageId)) {
              requestedVersionsRef.current.delete(messageId);
            }
          });
        }
      } finally {
        if (generationRef.current === generation) {
          runningRef.current = false;
          abortControllerRef.current = null;
          resolveDrainRef.current?.();
          resolveDrainRef.current = null;
        }
      }
    },
    [waitForNextBatch],
  );

  const scheduleReconciliation = useCallback(
    (messageIds: number[], options?: { immediate?: boolean }) => {
      if (messageIds.length === 0 || !mountedRef.current) return Promise.resolve();
      messageIds.forEach((messageId) => {
        requestedVersionsRef.current.set(
          messageId,
          (requestedVersionsRef.current.get(messageId) ?? 0) + 1,
        );
        pendingIdsRef.current.add(messageId);
        if (options?.immediate) immediateIdsRef.current.add(messageId);
      });
      if (options?.immediate) releaseWait();

      if (!runningRef.current) {
        runningRef.current = true;
        drainPromiseRef.current = new Promise<void>((resolve) => {
          resolveDrainRef.current = resolve;
        });
        const generation = generationRef.current;
        queueMicrotask(() => void drain(generation));
      }
      return drainPromiseRef.current;
    },
    [drain, releaseWait],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      ++generationRef.current;
      releaseWait();
      pendingIdsRef.current.clear();
      immediateIdsRef.current.clear();
      requestedVersionsRef.current.clear();
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      runningRef.current = false;
      lastStartedAtRef.current = Number.NEGATIVE_INFINITY;
      resolveDrainRef.current?.();
      resolveDrainRef.current = null;
    };
  }, [releaseWait, scopeKey]);

  return scheduleReconciliation;
}
