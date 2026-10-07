import { useCallback, useEffect, useRef, useState } from 'react';

import type { InboxMessagesReq } from '../../../../Bindings';
import { fetchInboxCount } from '../../services/api/analysis';
import { isAbortError } from '../../services/api/client';
import { isNullOrUndefined } from '../../utils/misc';
import { buildInboxOverallCountReq, buildInboxReq } from './helpers';
import type { AnalysisQueryState } from './types';
import { toErrorMessage } from './use-analysis-data.shared';

type Params = {
  deferInitialLoad: boolean;
  newestFirst: boolean;
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  optionsFreqValues: string[];
  queryState: AnalysisQueryState;
};

const MESSAGE_COUNTS_DEBOUNCE_MS = 200;
const OVERALL_MESSAGE_COUNT_REFRESH_COALESCE_MS = 5_000;

export function useAnalysisMessageCounts({
  deferInitialLoad,
  newestFirst,
  onError,
  onUnauthorized,
  optionsFreqValues,
  queryState,
}: Params) {
  const [messagesTotalCount, setMessagesTotalCount] = useState<number | null>(null);
  const [messagesOverallCount, setMessagesOverallCount] = useState<number | null>(null);
  const [messagesTotalLoading, setMessagesTotalLoading] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);
  const [activeRequestKey, setActiveRequestKey] = useState<string | null>(null);
  const onErrorRef = useRef(onError);
  const onUnauthorizedRef = useRef(onUnauthorized);
  const overallRefreshTimeoutRef = useRef<number | null>(null);
  const overallRefreshAbortControllerRef = useRef<AbortController | null>(null);
  const overallCountRequestGenerationRef = useRef(0);
  const messagesTotalRequestJson = JSON.stringify(
    buildInboxReq(queryState, optionsFreqValues, true),
  );
  const messagesOverallRequestJson = JSON.stringify(buildInboxOverallCountReq(queryState));
  const requestKey = `${loadVersion}|${newestFirst ? 'newest' : 'oldest'}|${messagesTotalRequestJson}|${messagesOverallRequestJson}`;

  onErrorRef.current = onError;
  onUnauthorizedRef.current = onUnauthorized;

  const cancelScheduledOverallMessageCountRefresh = useCallback(() => {
    if (overallRefreshTimeoutRef.current !== null) {
      window.clearTimeout(overallRefreshTimeoutRef.current);
      overallRefreshTimeoutRef.current = null;
    }
    overallRefreshAbortControllerRef.current?.abort();
    overallRefreshAbortControllerRef.current = null;
  }, []);

  useEffect(
    () => cancelScheduledOverallMessageCountRefresh,
    [
      cancelScheduledOverallMessageCountRefresh,
      deferInitialLoad,
      messagesOverallRequestJson,
      messagesTotalRequestJson,
      newestFirst,
    ],
  );

  useEffect(() => {
    if (deferInitialLoad) return;

    setActiveRequestKey(requestKey);
    const inboxReq = JSON.parse(messagesTotalRequestJson) as InboxMessagesReq | null;
    const overallInboxReq = JSON.parse(messagesOverallRequestJson) as InboxMessagesReq | null;
    if (isNullOrUndefined(inboxReq) || isNullOrUndefined(overallInboxReq)) {
      setMessagesTotalCount(null);
      setMessagesOverallCount(null);
      setMessagesTotalLoading(false);
      return;
    }

    setMessagesTotalCount(null);
    setMessagesOverallCount(null);
    setMessagesTotalLoading(true);
    let abortController: AbortController | null = null;

    const timeoutId = window.setTimeout(() => {
      abortController = new AbortController();
      const signal = abortController.signal;
      const overallCountRequestGeneration = ++overallCountRequestGenerationRef.current;
      const countRequestsAreShared = messagesTotalRequestJson === messagesOverallRequestJson;
      const selectedCountPromise = fetchInboxCount(
        { ...inboxReq, nolimit: true, newestFirst },
        { signal },
      );
      const overallCountPromise = countRequestsAreShared
        ? selectedCountPromise
        : fetchInboxCount({ ...overallInboxReq, nolimit: true, newestFirst }, { signal });

      void Promise.all([selectedCountPromise, overallCountPromise])
        .then(([selectedCount, overallCount]) => {
          if (signal.aborted) return;
          const canApplyOverallCount =
            overallCountRequestGenerationRef.current === overallCountRequestGeneration;
          if (!countRequestsAreShared || canApplyOverallCount) {
            setMessagesTotalCount(selectedCount.quantity);
          }
          if (canApplyOverallCount) setMessagesOverallCount(overallCount.quantity);
        })
        .catch((loadError: unknown) => {
          if (signal.aborted || isAbortError(loadError)) return;
          if (!onUnauthorizedRef.current(loadError)) onErrorRef.current(toErrorMessage(loadError));
        })
        .finally(() => {
          if (!signal.aborted) setMessagesTotalLoading(false);
        });
    }, MESSAGE_COUNTS_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeoutId);
      abortController?.abort();
    };
  }, [
    deferInitialLoad,
    loadVersion,
    messagesOverallRequestJson,
    messagesTotalRequestJson,
    newestFirst,
    requestKey,
  ]);

  const refreshMessageCounts = useCallback(() => {
    cancelScheduledOverallMessageCountRefresh();
    setLoadVersion((current) => current + 1);
  }, [cancelScheduledOverallMessageCountRefresh]);
  const scheduleOverallMessageCountRefresh = useCallback(() => {
    if (deferInitialLoad || overallRefreshTimeoutRef.current !== null) {
      return;
    }

    overallRefreshTimeoutRef.current = window.setTimeout(() => {
      overallRefreshTimeoutRef.current = null;
      const overallInboxReq = JSON.parse(messagesOverallRequestJson) as InboxMessagesReq | null;
      if (isNullOrUndefined(overallInboxReq)) return;

      overallRefreshAbortControllerRef.current?.abort();
      const abortController = new AbortController();
      overallRefreshAbortControllerRef.current = abortController;
      const signal = abortController.signal;
      const overallCountRequestGeneration = ++overallCountRequestGenerationRef.current;
      void fetchInboxCount({ ...overallInboxReq, nolimit: true, newestFirst }, { signal })
        .then((overallCount) => {
          if (
            signal.aborted ||
            overallCountRequestGenerationRef.current !== overallCountRequestGeneration
          ) {
            return;
          }
          setMessagesOverallCount(overallCount.quantity);
          if (messagesTotalRequestJson === messagesOverallRequestJson) {
            setMessagesTotalCount(overallCount.quantity);
          }
        })
        .catch((loadError: unknown) => {
          if (signal.aborted || isAbortError(loadError)) return;
          if (!onUnauthorizedRef.current(loadError)) onErrorRef.current(toErrorMessage(loadError));
        })
        .finally(() => {
          if (overallRefreshAbortControllerRef.current === abortController) {
            overallRefreshAbortControllerRef.current = null;
          }
        });
    }, OVERALL_MESSAGE_COUNT_REFRESH_COALESCE_MS);
  }, [deferInitialLoad, messagesOverallRequestJson, messagesTotalRequestJson, newestFirst]);

  return {
    messagesOverallCount,
    messagesTotalCount,
    messagesTotalLoading:
      !deferInitialLoad && (messagesTotalLoading || activeRequestKey !== requestKey),
    refreshMessageCounts,
    scheduleOverallMessageCountRefresh,
  };
}
