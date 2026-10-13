import { useCallback, useRef } from 'react';
import type { MutableRefObject } from 'react';

type Params = {
  runCycle: (automatic: boolean) => Promise<void>;
  rerunRequestedRef: MutableRefObject<boolean>;
  canRerun: () => boolean;
};

/** Owns overlapping-poll suppression and exactly one recovery rerun. */
export function useRerDutyPollingCoordinator(params: Params) {
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const activePromiseRef = useRef<Promise<void> | null>(null);
  const rerunAutomaticRef = useRef(true);

  const poll = useCallback(async (automatic = false) => {
    if (activePromiseRef.current) {
      paramsRef.current.rerunRequestedRef.current = true;
      rerunAutomaticRef.current &&= automatic;
      return activePromiseRef.current;
    }
    const promise = paramsRef.current.runCycle(automatic).finally(() => {
      if (activePromiseRef.current === promise) activePromiseRef.current = null;
      const rerunRequested = paramsRef.current.rerunRequestedRef.current;
      const rerunAutomatic = rerunAutomaticRef.current;
      paramsRef.current.rerunRequestedRef.current = false;
      rerunAutomaticRef.current = true;
      if (rerunRequested && paramsRef.current.canRerun()) void poll(rerunAutomatic);
    });
    activePromiseRef.current = promise;
    return promise;
  }, []);
  return poll;
}
