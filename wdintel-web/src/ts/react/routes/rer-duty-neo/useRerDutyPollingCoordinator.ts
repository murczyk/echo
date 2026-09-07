import { useCallback, useRef } from 'react';
import type { MutableRefObject } from 'react';

type Params = {
  runCycle: () => Promise<void>;
  rerunRequestedRef: MutableRefObject<boolean>;
  canRerun: () => boolean;
};

/** Owns overlapping-poll suppression and exactly one recovery rerun. */
export function useRerDutyPollingCoordinator(params: Params) {
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const activePromiseRef = useRef<Promise<void> | null>(null);

  const poll = useCallback(async () => {
    if (activePromiseRef.current) {
      paramsRef.current.rerunRequestedRef.current = true;
      return activePromiseRef.current;
    }
    const promise = paramsRef.current.runCycle().finally(() => {
      if (activePromiseRef.current === promise) activePromiseRef.current = null;
      const rerunRequested = paramsRef.current.rerunRequestedRef.current;
      paramsRef.current.rerunRequestedRef.current = false;
      if (rerunRequested && paramsRef.current.canRerun()) void poll();
    });
    activePromiseRef.current = promise;
    return promise;
  }, []);
  return poll;
}
