import { useCallback, useEffect, useRef, useState } from 'react';

import type { InboxMessagesReq } from '../../../../Bindings';
import { fetchInboxCount } from '../../services/api/analysis';
import { isAbortError } from '../../services/api/client';
import { isNullOrUndefined } from '../../utils/misc';
import { buildInboxOverallCountReq, buildInboxReq } from './helpers';
import type { AnalysisQueryState } from './types';
import { toErrorMessage } from './use-analysis-data.shared';

type Params = {
  newestFirst: boolean;
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  optionsFreqValues: string[];
  queryState: AnalysisQueryState;
};

export function useAnalysisMessageCounts({
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
  const onErrorRef = useRef(onError);
  const onUnauthorizedRef = useRef(onUnauthorized);
  const messagesTotalRequestJson = JSON.stringify(
    buildInboxReq(queryState, optionsFreqValues, true),
  );
  const messagesOverallRequestJson = JSON.stringify(buildInboxOverallCountReq(queryState));

  onErrorRef.current = onError;
  onUnauthorizedRef.current = onUnauthorized;

  useEffect(() => {
    const inboxReq = JSON.parse(messagesTotalRequestJson) as InboxMessagesReq | null;
    const overallInboxReq = JSON.parse(messagesOverallRequestJson) as InboxMessagesReq | null;
    if (isNullOrUndefined(inboxReq) || isNullOrUndefined(overallInboxReq)) {
      setMessagesTotalCount(null);
      setMessagesOverallCount(null);
      setMessagesTotalLoading(false);
      return;
    }

    const abortController = new AbortController();
    setMessagesTotalCount(null);
    setMessagesOverallCount(null);
    setMessagesTotalLoading(true);

    const selectedCountPromise = fetchInboxCount(
      { ...inboxReq, nolimit: true, newestFirst },
      { signal: abortController.signal },
    );
    const overallCountPromise =
      messagesTotalRequestJson === messagesOverallRequestJson
        ? selectedCountPromise
        : fetchInboxCount(
            { ...overallInboxReq, nolimit: true, newestFirst },
            { signal: abortController.signal },
          );

    void Promise.all([selectedCountPromise, overallCountPromise])
      .then(([selectedCount, overallCount]) => {
        if (abortController.signal.aborted) return;
        setMessagesTotalCount(selectedCount.quantity);
        setMessagesOverallCount(overallCount.quantity);
      })
      .catch((loadError: unknown) => {
        if (abortController.signal.aborted || isAbortError(loadError)) return;
        if (!onUnauthorizedRef.current(loadError)) onErrorRef.current(toErrorMessage(loadError));
      })
      .finally(() => {
        if (!abortController.signal.aborted) setMessagesTotalLoading(false);
      });

    return () => abortController.abort();
  }, [loadVersion, messagesOverallRequestJson, messagesTotalRequestJson, newestFirst]);

  const reloadMessageCounts = useCallback(() => {
    setLoadVersion((current) => current + 1);
  }, []);

  return {
    messagesOverallCount,
    messagesTotalCount,
    messagesTotalLoading,
    reloadMessageCounts,
  };
}
