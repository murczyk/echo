import { useEffect } from 'react';
import type { MutableRefObject } from 'react';

import { AUTH_UNAUTHORIZED_EVENT } from '../../auth-redirect';
import { cancelDutyNotificationPollCycle } from './notifications';
import type { DutyNotificationPollCycle } from './notifications';

type Params = {
  ready: boolean;
  hasShortState: boolean;
  pollIntervalMs: number;
  poll: () => Promise<void>;
  intervalRef: MutableRefObject<ReturnType<typeof setInterval> | null>;
  authenticationFailedRef: MutableRefObject<boolean>;
  mountedRef: MutableRefObject<boolean>;
  lifecycleGenerationRef: MutableRefObject<number>;
  notificationCyclesRef: MutableRefObject<Set<DutyNotificationPollCycle>>;
  rerunRequestedRef: MutableRefObject<boolean>;
};

/** Owns polling start/stop, auth shutdown, and browser recovery events. */
export function useRerDutyPollingLifecycle(params: Params) {
  useEffect(() => {
    if (params.hasShortState && !params.ready) return;
    params.intervalRef.current = setInterval(() => {
      void params.poll();
    }, params.pollIntervalMs);
    return () => {
      if (params.intervalRef.current) clearInterval(params.intervalRef.current);
      params.intervalRef.current = null;
    };
  }, [params.hasShortState, params.intervalRef, params.poll, params.pollIntervalMs, params.ready]);

  useEffect(() => {
    params.mountedRef.current = true;
    const stopPolling = () => {
      params.authenticationFailedRef.current = true;
    };
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, stopPolling);
    return () => {
      window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, stopPolling);
      params.mountedRef.current = false;
      params.lifecycleGenerationRef.current += 1;
      params.notificationCyclesRef.current.forEach(cancelDutyNotificationPollCycle);
      params.notificationCyclesRef.current.clear();
      params.rerunRequestedRef.current = false;
    };
  }, [
    params.authenticationFailedRef,
    params.lifecycleGenerationRef,
    params.mountedRef,
    params.notificationCyclesRef,
    params.rerunRequestedRef,
  ]);

  useEffect(() => {
    const recover = () => {
      if (document.visibilityState !== 'hidden') void params.poll();
    };
    window.addEventListener('focus', recover);
    window.addEventListener('online', recover);
    document.addEventListener('visibilitychange', recover);
    return () => {
      window.removeEventListener('focus', recover);
      window.removeEventListener('online', recover);
      document.removeEventListener('visibilitychange', recover);
    };
  }, [params.poll]);
}
