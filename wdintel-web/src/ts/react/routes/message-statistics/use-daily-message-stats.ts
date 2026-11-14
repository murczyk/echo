import { useCallback, useEffect, useRef, useState } from 'react';
import type { DailyMessageStatsReq, DailyMessageStatsRsp } from '../../../../Bindings';
import { fetchDailyMessageStats } from '../../services/api/daily-message-stats';
import { HttpRequestError, isAbortError } from '../../services/api/client';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { STATS_REFRESH_MS, today } from './state';

export function useDailyMessageStats(
  request: DailyMessageStatsReq | null,
  scopeVersion = 0,
  onDenied?: (error: unknown) => void,
) {
  const { notify } = usePowerSnackbar();
  const [data, setData] = useState<DailyMessageStatsRsp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const pending = useRef(false);
  const lastLoaded = useRef(0);
  const key = JSON.stringify([request, scopeVersion]);
  const reject = useRef(onDenied);
  reject.current = onDenied;
  const previousKey = useRef(key);
  const refresh = useCallback(() => {
    if (!pending.current) setRevision((value) => value + 1);
  }, []);
  useEffect(() => {
    if (!request) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    if (previousKey.current !== key) {
      setData(null);
      setError(null);
      previousKey.current = key;
    }
    setLoading(true);
    pending.current = true;
    fetchDailyMessageStats(request, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        setData(response);
        setError(null);
        lastLoaded.current = Date.now();
      })
      .catch((reason) => {
        if (controller.signal.aborted || isAbortError(reason)) return;
        const message =
          reason instanceof Error ? reason.message : 'Не вдалося завантажити статистику.';
        if (reason instanceof HttpRequestError && [401, 403].includes(reason.status)) {
          setData(null);
          reject.current?.(reason);
        }
        setError(message);
        notify({ severity: 'error', message });
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
          pending.current = false;
        }
      });
    return () => {
      controller.abort();
      pending.current = false;
    };
  }, [key, revision, notify]);
  useEffect(() => {
    if (!request || request.fromDate > today() || request.toDate < today()) return;
    const update = () => {
      if (request.toDate < today() || request.fromDate > today()) return;
      if (
        document.visibilityState === 'visible' &&
        Date.now() - lastLoaded.current >= STATS_REFRESH_MS
      )
        refresh();
    };
    const timer = window.setInterval(update, STATS_REFRESH_MS);
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
    };
  }, [key, refresh]);
  return { data, error, loading, refresh };
}
