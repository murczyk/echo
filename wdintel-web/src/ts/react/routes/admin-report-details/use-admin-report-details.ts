import { useEffect, useRef, useState } from 'react';

import type { ReportHistoryRow } from '../../../../Bindings';
import { fetchBgtaskStatusAndLogs } from '../../services/api/bgtask';
import { isAbortError } from '../../services/api/client';
import { fetchReportHistoryStatus } from '../../services/api/report-history';
import { formatErrorMessage } from '../rer-network-details-neo/use-rer-network-details-neo-page.helpers';

const REPORT_DETAILS_POLL_INTERVAL_MS = 1000;

export type AdminReportDetailsState = {
  row: ReportHistoryRow | null;
  logs: string[];
  taskError: string | null;
  taskRunning: boolean | null;
  loading: boolean;
  error: string | null;
};

const INITIAL_STATE: AdminReportDetailsState = {
  row: null,
  logs: [],
  taskError: null,
  taskRunning: null,
  loading: true,
  error: null,
};

export function useAdminReportDetails(reportId: number): AdminReportDetailsState {
  const [state, setState] = useState(INITIAL_STATE);
  const taskIdRef = useRef<number | null>(null);
  const logsRef = useRef<string[]>([]);

  useEffect(() => {
    let stopped = false;
    let timeoutId: number | null = null;
    let abortController: AbortController | null = null;

    async function poll() {
      const controller = new AbortController();
      abortController = controller;
      try {
        let row = await fetchReportHistoryStatus(reportId, {
          signal: controller.signal,
        });
        let taskError: string | null = null;
        let taskRunning: boolean | null = null;
        let loadError: string | null = null;

        if (row.bgtaskId !== null) {
          if (taskIdRef.current !== row.bgtaskId) {
            taskIdRef.current = row.bgtaskId;
            logsRef.current = [];
          }
          try {
            const task = await fetchBgtaskStatusAndLogs(row.bgtaskId, logsRef.current.length, {
              signal: controller.signal,
            });
            logsRef.current = logsRef.current.concat(task.loglines);
            taskError = task.finishedWithError;
            taskRunning = task.running;
            row = { ...row, progress: task.progress ?? row.progress };
          } catch (error) {
            if (isAbortError(error)) throw error;
            loadError = formatErrorMessage(error);
          }
        }

        if (stopped) return;
        setState({
          row,
          logs: logsRef.current,
          taskError,
          taskRunning,
          loading: false,
          error: loadError,
        });
        if (row.status !== 'planned' && row.status !== 'in_progress') return;
      } catch (error) {
        if (stopped || isAbortError(error)) return;
        setState((current) => ({
          ...current,
          loading: false,
          error: formatErrorMessage(error),
        }));
      }

      if (!stopped) {
        timeoutId = window.setTimeout(poll, REPORT_DETAILS_POLL_INTERVAL_MS);
      }
    }

    void poll();
    return () => {
      stopped = true;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      abortController?.abort();
    };
  }, [reportId]);

  return state;
}
