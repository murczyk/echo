import { useCallback, useEffect, useRef } from 'react';

import { HttpRequestError } from '../../services/api/client';
import type { AnalysisFilterSectionId } from './types';

type FailedLoad = {
  requestKey: string;
  attempts: number;
  blocked: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

const FILTER_RETRY_INITIAL_DELAY_MS = 2000;
const FILTER_RETRY_MAX_DELAY_MS = 30000;

export function useAnalysisFilterRetries(
  retry: (section: AnalysisFilterSectionId) => Promise<void>,
) {
  const retryRef = useRef(retry);
  useEffect(() => {
    retryRef.current = retry;
  }, [retry]);
  const failuresRef = useRef(new Map<AnalysisFilterSectionId, FailedLoad>());

  const clearFilterRetry = useCallback((section: AnalysisFilterSectionId) => {
    const failure = failuresRef.current.get(section);
    if (failure?.timer != null) clearTimeout(failure.timer);
    failuresRef.current.delete(section);
  }, []);

  const clearFilterRetries = useCallback(() => {
    failuresRef.current.forEach((_, section) => clearFilterRetry(section));
  }, [clearFilterRetry]);

  useEffect(() => clearFilterRetries, [clearFilterRetries]);

  const isFilterRetryBlocked = useCallback(
    (section: AnalysisFilterSectionId, requestKey: string) => {
      const failure = failuresRef.current.get(section);
      if (failure?.requestKey !== requestKey) {
        clearFilterRetry(section);
        return false;
      }
      return failure.blocked;
    },
    [clearFilterRetry],
  );

  const scheduleFilterRetry = useCallback(
    (section: AnalysisFilterSectionId, requestKey: string, error: unknown) => {
      const previous = failuresRef.current.get(section);
      const attempts = previous?.requestKey === requestKey ? previous.attempts + 1 : 1;
      clearFilterRetry(section);
      const failure: FailedLoad = { requestKey, attempts, blocked: true };
      failuresRef.current.set(section, failure);
      if (error instanceof HttpRequestError && (error.status === 0 || error.status >= 500)) {
        const delay =
          Math.min(
            FILTER_RETRY_MAX_DELAY_MS / 1.2,
            FILTER_RETRY_INITIAL_DELAY_MS * 2 ** Math.min(attempts - 1, 4),
          ) *
          (1 + Math.random() * 0.2);
        failure.timer = setTimeout(() => {
          failure.timer = undefined;
          failure.blocked = false;
          void retryRef.current(section);
        }, delay);
      }
      return attempts === 1;
    },
    [clearFilterRetry],
  );

  return {
    clearFilterRetry,
    clearFilterRetries,
    isFilterRetryBlocked,
    scheduleFilterRetry,
  };
}
