import { useCallback, useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';

import type { MessageFeedState } from './utils';

type Params = {
  intervalMs: number;
  lastCountStartedAtRef: MutableRefObject<Record<string, number>>;
  hasActiveTailCount: (feedId: string) => boolean;
  poll: () => Promise<void>;
};

export function useRerDutyCountSchedule(params: Params) {
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduledAtRef = useRef(Infinity);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
      scheduledAtRef.current = Infinity;
    };
  }, []);

  const scheduleDuePoll = useCallback((delayMs: number) => {
    const dueAt = performance.now() + delayMs;
    if (timeoutRef.current !== null && scheduledAtRef.current <= dueAt) return;
    if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
    scheduledAtRef.current = dueAt;
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      scheduledAtRef.current = Infinity;
      if (mountedRef.current) void paramsRef.current.poll();
    }, delayMs);
  }, []);

  return useCallback(
    (feeds: MessageFeedState[], automatic: boolean) => {
      if (!automatic) return feeds;
      const now = performance.now();
      const available = feeds.filter((feed) => !paramsRef.current.hasActiveTailCount(feed.id));
      const remainingMs = (feedId: string) =>
        (paramsRef.current.lastCountStartedAtRef.current[feedId] ?? -Infinity) +
        paramsRef.current.intervalMs -
        now;
      const delays = available.map((feed) => remainingMs(feed.id)).filter((delay) => delay > 0);
      if (delays.length > 0) scheduleDuePoll(Math.min(...delays));
      return available.filter((feed) => remainingMs(feed.id) <= 0);
    },
    [scheduleDuePoll],
  );
}
