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
  const messagesTotalRequestJson = JSON.stringify(
    buildInboxReq(queryState, optionsFreqValues, true),
  );
  const messagesOverallRequestJson = JSON.stringify(buildInboxOverallCountReq(queryState));
  const requestKey = `${loadVersion}|${newestFirst ? 'newest' : 'oldest'}|${messagesTotalRequestJson}|${messagesOverallRequestJson}`;

  onErrorRef.current = onError;
  onUnauthorizedRef.current = onUnauthorized;

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
      const selectedCountPromise = fetchInboxCount(
        { ...inboxReq, nolimit: true, newestFirst },
        { signal },
      );
      const overallCountPromise =
        messagesTotalRequestJson === messagesOverallRequestJson
          ? selectedCountPromise
          : fetchInboxCount({ ...overallInboxReq, nolimit: true, newestFirst }, { signal });

      void Promise.all([selectedCountPromise, overallCountPromise])
        .then(([selectedCount, overallCount]) => {
          if (signal.aborted) return;
          setMessagesTotalCount(selectedCount.quantity);
          setMessagesOverallCount(overallCount.quantity);
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
    setLoadVersion((current) => current + 1);
  }, []);

  return {
    messagesOverallCount,
    messagesTotalCount,
    messagesTotalLoading:
      !deferInitialLoad && (messagesTotalLoading || activeRequestKey !== requestKey),
    refreshMessageCounts,
  };
}
