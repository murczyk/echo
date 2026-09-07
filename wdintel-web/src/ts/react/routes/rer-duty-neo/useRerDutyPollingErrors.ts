import { useCallback, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import { isUnauthorizedError } from '../../services/api/client';

/** Owns de-duplicated polling error episodes without letting an old recovery hide a newer one. */
export function useRerDutyPollingErrors() {
  const [errorState, setErrorState] = useState({ error: null as string | null, version: 0 });
  const errorStateRef = useRef(errorState);
  const pollingErrorsByScopeRef = useRef<Record<string, string>>({});
  const displayedPollingErrorScopeRef = useRef<string | null>(null);
  const authenticationFailedRef = useRef(false);

  const updateErrorState = useCallback((nextError: string | null, notify = false) => {
    const next = {
      error: nextError,
      version: errorStateRef.current.version + (notify ? 1 : 0),
    };
    errorStateRef.current = next;
    setErrorState(next);
  }, []);

  const setError = useCallback<Dispatch<SetStateAction<string | null>>>(
    (nextError) => {
      displayedPollingErrorScopeRef.current = null;
      const error =
        typeof nextError === 'function' ? nextError(errorStateRef.current.error) : nextError;
      updateErrorState(error, error !== null);
    },
    [updateErrorState],
  );

  const reportPollingFailure = useCallback(
    (scope: string, pollingError: unknown) => {
      if (isUnauthorizedError(pollingError)) {
        authenticationFailedRef.current = true;
        return;
      }
      if (pollingErrorsByScopeRef.current[scope] != null) return;
      const message = pollingError instanceof Error ? pollingError.message : String(pollingError);
      pollingErrorsByScopeRef.current[scope] = message;
      displayedPollingErrorScopeRef.current = scope;
      updateErrorState(message, true);
    },
    [updateErrorState],
  );

  const clearPollingFailure = useCallback(
    (scope: string) => {
      const pollingError = pollingErrorsByScopeRef.current[scope];
      if (pollingError == null) return;
      delete pollingErrorsByScopeRef.current[scope];
      if (displayedPollingErrorScopeRef.current !== scope) return;
      const [nextScope, nextPollingError] =
        Object.entries(pollingErrorsByScopeRef.current)[0] ?? [];
      displayedPollingErrorScopeRef.current = nextScope ?? null;
      if (errorStateRef.current.error === pollingError) {
        updateErrorState(nextPollingError ?? null);
      }
    },
    [updateErrorState],
  );

  return {
    error: errorState.error,
    errorNotificationVersion: errorState.version,
    setError,
    reportPollingFailure,
    clearPollingFailure,
    authenticationFailedRef,
  };
}
