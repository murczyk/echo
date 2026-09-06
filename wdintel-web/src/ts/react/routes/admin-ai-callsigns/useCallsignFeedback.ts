import { useCallback, useEffect, useState } from 'react';
import type {
  InboxMessage,
  FeedbackDetail,
  FeedbackItem,
  ReparseFailure,
  ReparseStatus,
} from '../../../../Bindings';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import {
  getCallsignFeedback,
  getCallsignReparseRuns,
  listCallsignFeedback,
} from '../../services/api/ai-callsigns';

import { fetchMessagesByIds } from '../../services/api/inbox-messages';

const POLL_MS = 5_000;

export function useCallsignFeedback() {
  const { notify } = usePowerSnackbar();
  const [currentMessage, setCurrentMessage] = useState<[number, InboxMessage] | null>(null);
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<FeedbackItem[]>([]);
  const [after, setAfter] = useState('');
  const [loading, setLoading] = useState(false);
  const [runs, setRuns] = useState<ReparseStatus[]>([]);
  const [days, setDays] = useState('14');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [details, setDetails] = useState<FeedbackDetail[]>([]);
  const [beforeId, setBeforeId] = useState<number | null>(null);
  const [failures, setFailures] = useState<ReparseFailure[] | null>(null);
  const fail = useCallback(
    (error: unknown) =>
      notify({
        severity: 'error',
        message: error instanceof Error ? error.message : String(error),
      }),
    [notify],
  );
  const refreshRuns = useCallback(async () => {
    try {
      setRuns(await getCallsignReparseRuns());
    } catch (error) {
      fail(error);
    }
  }, [fail]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listCallsignFeedback({ search, after })
      .then((items) => {
        if (!cancelled) setRows(items);
      })
      .catch((error) => {
        if (!cancelled) fail(error);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [search, after, fail]);
  useEffect(() => {
    void refreshRuns();
    const interval = window.setInterval(() => {
      void refreshRuns();
    }, POLL_MS);
    return () => window.clearInterval(interval);
  }, [refreshRuns]);
  useEffect(() => {
    if (selected === null) return;
    let cancelled = false;
    getCallsignFeedback({ callsign: selected, beforeId })
      .then((items) => {
        if (!cancelled) setDetails(items);
      })
      .catch((error) => {
        if (!cancelled) fail(error);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, beforeId, fail]);
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      await refreshRuns();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };
  const active = runs.some((run) => run.state === 'running' || run.state === 'enumerating');
  const validDays = /^\d+$/.test(days) && Number.isSafeInteger(Number(days)) && Number(days) > 0;
  const openMessage = async (id: number) => {
    try {
      const messages = await fetchMessagesByIds([id]);
      if (!messages[0]) throw new Error('Повідомлення недоступне або видалене.');
      setCurrentMessage(messages[0]);
    } catch (error) {
      fail(error);
    }
  };
  return {
    currentMessage,
    setCurrentMessage,
    openMessage,
    search,
    setSearch,
    rows,
    after,
    setAfter,
    loading,
    runs,
    days,
    setDays,
    busy,
    selected,
    setSelected,
    details,
    setDetails,
    beforeId,
    setBeforeId,
    failures,
    setFailures,
    fail,
    perform,
    active,
    validDays,
  };
}
