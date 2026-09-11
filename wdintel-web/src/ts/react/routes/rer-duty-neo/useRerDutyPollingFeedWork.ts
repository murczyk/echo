import { useCallback, useRef } from 'react';

/** Owns one in-flight background operation per feed without coupling it to poll scheduling. */
export function useRerDutyPollingFeedWork() {
  const activeWorkByFeedIdRef = useRef<Partial<Record<string, Promise<void>>>>({});

  const startFeedWork = useCallback((feedId: string, work: () => Promise<void>) => {
    if (activeWorkByFeedIdRef.current[feedId]) return null;
    const promise = work().finally(() => {
      if (activeWorkByFeedIdRef.current[feedId] === promise) {
        delete activeWorkByFeedIdRef.current[feedId];
      }
    });
    activeWorkByFeedIdRef.current[feedId] = promise;
    return promise;
  }, []);

  const forgetFeedWork = useCallback((feedId: string) => {
    delete activeWorkByFeedIdRef.current[feedId];
  }, []);

  return { startFeedWork, forgetFeedWork };
}
