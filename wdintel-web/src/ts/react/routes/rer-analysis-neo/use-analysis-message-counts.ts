import { useCallback, useEffect, useRef, useState } from 'react';

import type { InboxMessagesReq } from '../../../../Bindings';
import { fetchInboxCount } from '../../services/api/analysis';
import { isAbortError } from '../../services/api/client';
import { isNullOrUndefined } from '../../utils/misc';
import { buildInboxOverallCountReq, buildInboxReq } from './helpers';
import type { AnalysisQueryState } from './types';
import { toErrorMessage } from './use-analysis-data.shared';
import { ANALYSIS_SYSTEM_COUNT_INTERVAL_MS } from './config';

type Params = {
  deferInitialLoad: boolean;
  newestFirst: boolean;
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  optionsFreqValues: string[];
  queryState: AnalysisQueryState;
};

const MESSAGE_COUNTS_DEBOUNCE_MS = 200;
// Covers sequential analytics/PostgreSQL timeouts plus transport allowance, as in Duty.
const ANALYSIS_COUNT_REQUEST_DEADLINE_MS = 65_000;
type MessageCountRefreshMode = 'immediate' | 'deferred';

async function requestMessageCounts(
  selectedReq: InboxMessagesReq,
  overallReq: InboxMessagesReq,
  shared: boolean,
  signal: AbortSignal,
  onFailure: (error: unknown) => void,
) {
  const reportFailure = (error: unknown): never => {
    onFailure(error);
    throw error;
  };
  const selected = fetchInboxCount(selectedReq, { signal }).catch(reportFailure);
  const overall = shared ? selected : fetchInboxCount(overallReq, { signal }).catch(reportFailure);
  const results = await Promise.allSettled([selected, overall]);
  const [selectedResult, overallResult] = results;
  if (selectedResult.status === 'rejected') throw selectedResult.reason;
  if (overallResult.status === 'rejected') throw overallResult.reason;
  return [selectedResult.value, overallResult.value] as const;
}

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
  const systemRefreshTimeoutRef = useRef<number | null>(null);
  const activeCountControllerRef = useRef<AbortController | null>(null);
  const systemRefreshPendingRef = useRef(false);
  const userRefreshScheduledRef = useRef(false);
  const lastCountStartedAtRef = useRef(Number.NEGATIVE_INFINITY);
  const countRequestGenerationRef = useRef(0);
  const drainSystemRefreshRef = useRef<() => void>(() => {});
  const messagesTotalRequestJson = JSON.stringify(
    buildInboxReq(queryState, optionsFreqValues, true),
  );
  const messagesOverallRequestJson = JSON.stringify(buildInboxOverallCountReq(queryState));
  const requestKey = `${loadVersion}|${newestFirst ? 'newest' : 'oldest'}|${messagesTotalRequestJson}|${messagesOverallRequestJson}`;

  onErrorRef.current = onError;
  onUnauthorizedRef.current = onUnauthorized;

  const cancelCountWork = useCallback(() => {
    systemRefreshPendingRef.current = false;
    userRefreshScheduledRef.current = false;
    if (systemRefreshTimeoutRef.current !== null) {
      window.clearTimeout(systemRefreshTimeoutRef.current);
      systemRefreshTimeoutRef.current = null;
    }
    ++countRequestGenerationRef.current;
    activeCountControllerRef.current?.abort();
    activeCountControllerRef.current = null;
  }, []);

  const startCountCycle = useCallback(() => {
    const inboxReq = JSON.parse(messagesTotalRequestJson) as InboxMessagesReq | null;
    const overallInboxReq = JSON.parse(messagesOverallRequestJson) as InboxMessagesReq | null;
    if (isNullOrUndefined(inboxReq) || isNullOrUndefined(overallInboxReq)) return;
    const controller = new AbortController();
    activeCountControllerRef.current = controller;
    lastCountStartedAtRef.current = performance.now();
    const generation = ++countRequestGenerationRef.current;
    let timedOut = false;
    let failureReported = false;
    const reportFailure = (error: unknown) => {
      if (countRequestGenerationRef.current !== generation) return;
      if (!timedOut && (controller.signal.aborted || isAbortError(error))) return;
      if (timedOut) error = controller.signal.reason;
      const unauthorized = onUnauthorizedRef.current(error);
      if (!unauthorized && !failureReported) onErrorRef.current(toErrorMessage(error));
      failureReported = true;
    };
    let deadlineId: number;
    const deadline = new Promise<never>((_, reject) => {
      deadlineId = window.setTimeout(() => {
        timedOut = true;
        const error = new Error('Сервер не відповів вчасно. Спробуйте ще раз.');
        controller.abort(error);
        reject(error);
      }, ANALYSIS_COUNT_REQUEST_DEADLINE_MS);
      controller.signal.addEventListener(
        'abort',
        () => {
          window.clearTimeout(deadlineId);
          reject(controller.signal.reason);
        },
        { once: true },
      );
    });
    const counts = requestMessageCounts(
      { ...inboxReq, nolimit: true, newestFirst },
      { ...overallInboxReq, nolimit: true, newestFirst },
      messagesTotalRequestJson === messagesOverallRequestJson,
      controller.signal,
      reportFailure,
    );
    void Promise.race([counts, deadline])
      .then(([selectedCount, overallCount]) => {
        if (controller.signal.aborted || countRequestGenerationRef.current !== generation) return;
        setMessagesTotalCount(selectedCount.quantity);
        setMessagesOverallCount(overallCount.quantity);
      })
      .catch((error: unknown) => {
        if (!failureReported) reportFailure(error);
      })
      .finally(() => {
        window.clearTimeout(deadlineId);
        if (activeCountControllerRef.current !== controller) return;
        activeCountControllerRef.current = null;
        setMessagesTotalLoading(false);
        drainSystemRefreshRef.current();
      });
  }, [messagesOverallRequestJson, messagesTotalRequestJson, newestFirst]);

  const drainSystemRefresh = useCallback(() => {
    if (
      deferInitialLoad ||
      !systemRefreshPendingRef.current ||
      userRefreshScheduledRef.current ||
      activeCountControllerRef.current
    )
      return;
    const waitMs =
      lastCountStartedAtRef.current + ANALYSIS_SYSTEM_COUNT_INTERVAL_MS - performance.now();
    if (waitMs > 0) {
      if (systemRefreshTimeoutRef.current === null) {
        systemRefreshTimeoutRef.current = window.setTimeout(() => {
          systemRefreshTimeoutRef.current = null;
          drainSystemRefreshRef.current();
        }, waitMs);
      }
      return;
    }
    systemRefreshPendingRef.current = false;
    startCountCycle();
  }, [deferInitialLoad, startCountCycle]);
  drainSystemRefreshRef.current = drainSystemRefresh;

  useEffect(() => {
    if (deferInitialLoad) return cancelCountWork;
    setActiveRequestKey(requestKey);
    setMessagesTotalCount(null);
    setMessagesOverallCount(null);
    const inboxReq = JSON.parse(messagesTotalRequestJson) as InboxMessagesReq | null;
    const overallInboxReq = JSON.parse(messagesOverallRequestJson) as InboxMessagesReq | null;
    if (isNullOrUndefined(inboxReq) || isNullOrUndefined(overallInboxReq)) {
      setMessagesTotalLoading(false);
      return cancelCountWork;
    }
    setMessagesTotalLoading(true);
    userRefreshScheduledRef.current = true;
    const timeoutId = window.setTimeout(() => {
      userRefreshScheduledRef.current = false;
      startCountCycle();
    }, MESSAGE_COUNTS_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timeoutId);
      cancelCountWork();
    };
  }, [
    cancelCountWork,
    deferInitialLoad,
    messagesOverallRequestJson,
    messagesTotalRequestJson,
    requestKey,
    startCountCycle,
  ]);

  const refreshMessageCounts = useCallback(() => {
    cancelCountWork();
    setLoadVersion((current) => current + 1);
  }, [cancelCountWork]);
  const scheduleOverallMessageCountRefresh = useCallback(
    (_mode: MessageCountRefreshMode = 'immediate') => {
      if (deferInitialLoad) return;
      systemRefreshPendingRef.current = true;
      drainSystemRefresh();
    },
    [deferInitialLoad, drainSystemRefresh],
  );

  return {
    messagesOverallCount,
    messagesTotalCount,
    messagesTotalLoading:
      !deferInitialLoad && (messagesTotalLoading || activeRequestKey !== requestKey),
    refreshMessageCounts,
    scheduleOverallMessageCountRefresh,
  };
}
