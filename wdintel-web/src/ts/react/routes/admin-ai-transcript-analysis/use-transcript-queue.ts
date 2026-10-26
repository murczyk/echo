import { useEffect, useState } from 'react';
import type { AiTranscriptQueueRsp } from '../../../../Bindings';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { getTranscriptAnalysisQueue } from '../../services/api/ai-transcript-analysis';

const QUEUE_REFRESH_MS = 10_000;

export function useTranscriptQueue() {
  const [data, setData] = useState<AiTranscriptQueueRsp | null>(null);
  const [cursors, setCursors] = useState<Array<number | null>>([null]);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { notify } = usePowerSnackbar();
  const cursor = cursors[cursors.length - 1];

  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    let lastError: string | null = null;
    setData(null);
    setLoading(true);
    setError(null);
    async function load() {
      if (pending) return;
      pending = true;
      try {
        const response = await getTranscriptAnalysisQueue(
          { beforeMessageId: cursor },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setData(response);
        setError(null);
        lastError = null;
      } catch (cause) {
        if (controller.signal.aborted) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        if (message !== lastError) notify({ severity: 'error', message });
        lastError = message;
      } finally {
        pending = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    const interval = window.setInterval(() => void load(), QUEUE_REFRESH_MS);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [cursor, refresh]);

  return {
    data,
    loading,
    error,
    page: cursors.length,
    refresh: () => {
      setCursors([null]);
      setRefresh((value) => value + 1);
    },
    previous: () => setCursors((current) => current.slice(0, -1)),
    next: () => {
      if (data?.nextBeforeMessageId != null) {
        setCursors((current) => [...current, data.nextBeforeMessageId]);
      }
    },
  };
}
