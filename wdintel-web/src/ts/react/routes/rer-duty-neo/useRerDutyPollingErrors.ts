import { useCallback, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import { isUnauthorizedError } from '../../services/api/client';

/** Owns de-duplicated polling error episodes without letting an old recovery hide a newer one. */
export function useRerDutyPollingErrors() {
  const [error, setErrorState] = useState<string | null>(null);
  const [errorNotificationVersion, setErrorNotificationVersion] = useState(0);
  const pollingErrorsByScopeRef = useRef<Record<string, string>>({});
  const displayedPollingErrorScopeRef = useRef<string | null>(null);
  const authenticationFailedRef = useRef(false);

  const setError = useCallback<Dispatch<SetStateAction<string | null>>>((nextError) => {
    displayedPollingErrorScopeRef.current = null;
    setErrorState(nextError);
  }, []);

  const reportPollingFailure = useCallback((scope: string, pollingError: unknown) => {
    if (isUnauthorizedError(pollingError)) {
      authenticationFailedRef.current = true;
      return;
    }
    if (pollingErrorsByScopeRef.current[scope] != null) return;
    const message = pollingError instanceof Error ? pollingError.message : String(pollingError);
    pollingErrorsByScopeRef.current[scope] = message;
    displayedPollingErrorScopeRef.current = scope;
    setErrorState(message);
    setErrorNotificationVersion((version) => version + 1);
  }, []);

  const clearPollingFailure = useCallback((scope: string) => {
    const pollingError = pollingErrorsByScopeRef.current[scope];
    if (pollingError == null) return;
    delete pollingErrorsByScopeRef.current[scope];
    if (displayedPollingErrorScopeRef.current !== scope) return;
    const [nextScope, nextPollingError] = Object.entries(pollingErrorsByScopeRef.current)[0] ?? [];
    displayedPollingErrorScopeRef.current = nextScope ?? null;
    setErrorState((current) => (current === pollingError ? (nextPollingError ?? null) : current));
  }, []);

  return {
    error,
    errorNotificationVersion,
    setError,
    reportPollingFailure,
    clearPollingFailure,
    authenticationFailedRef,
  };
}
