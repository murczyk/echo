import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import {
  downloadNetworkEtalonkaReportTaskResult,
  launchNetworkEtalonkaBatchReportTask,
} from '../../services/api/networks';
import { fetchBgtaskStatusAndLogs, getBgtaskProgressFromPercent } from '../../services/api/bgtask';
import { fetchReportHistoryStatus, parseUtcDateTime } from '../../services/api/report-history';
import { isUnauthorizedError } from '../../services/api/client';
import { redirectToLogin } from '../../auth-redirect';
import { downloadBlob } from '../../utils/download-blob';
import { formatErrorMessage, type NetworkDetailsNeoPageState } from './use-rer-network-details-neo-page.shared';
import {
  buildEtalonkaNetworkBatchReq,
  buildEtalonkaReportFilename,
  type NetworkEtalonkaReportState,
  type NetworkEtalonkaReportType,
} from './use-rer-network-details-neo-page.etalonka-report';
import type { ReportHistoryRow } from '../../../../Bindings';

type SetState = Dispatch<SetStateAction<NetworkDetailsNeoPageState>>;

type Args = {
  state: NetworkDetailsNeoPageState;
  setState: SetState;
};

function updateReportState(
  setState: SetState,
  updater: (current: NetworkEtalonkaReportState) => NetworkEtalonkaReportState,
) {
  setState((current) => ({
    ...current,
    etalonkaReport: updater(current.etalonkaReport),
  }));
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function applyReportHistoryRow(
  setState: SetState,
  row: ReportHistoryRow,
  progress: { curr: number; overall: number },
  logs: string[],
  fileName: string,
) {
  updateReportState(setState, (current) => ({
    ...current,
    taskId: row.id,
    historyRow: row,
    running: row.status === 'planned' || row.status === 'in_progress',
    curr: row.bgtaskId === null ? 0 : progress.curr,
    overall: row.bgtaskId === null ? 100 : progress.overall,
    logs: row.bgtaskId === null ? [] : logs,
    error: null,
    finishedAt: row.status === 'done' ? new Date().toISOString() : null,
    progressExpanded: current.progressExpanded,
    downloadFileName: fileName,
    startedAtMs: parseUtcDateTime(row.startedAt)?.getTime() ?? null,
  }));
}

export function useRerNetworkDetailsNeoPageReportActions({ state, setState }: Args) {
  const runEtalonkaReportTask = useCallback(
    async (report: NetworkEtalonkaReportState) => {
      const network = state.network;
      if (!network) return;

      const fileName = buildEtalonkaReportFilename(network.id, report);
      updateReportState(setState, (current) => ({
        ...current,
        error: null,
        running: true,
        taskId: null,
        curr: 0,
        overall: 100,
        logs: [],
        historyRow: null,
        finishedAt: null,
        progressExpanded: false,
        downloadFileName: fileName,
        startedAtMs: null,
        taskRunId: current.taskRunId + 1,
      }));

      try {
        const taskId = await launchNetworkEtalonkaBatchReportTask(buildEtalonkaNetworkBatchReq(network.id, report));
        let serverLogSkip = 0;
        let logs: string[] = [];

        while (true) {
          const row = await fetchReportHistoryStatus(taskId);
          if (row.status === 'failed') {
            updateReportState(setState, (current) => ({
              ...current,
              taskId,
              historyRow: row,
              running: false,
              curr: current.curr,
              overall: current.overall,
              logs,
              error: row.lastError ?? 'Сталася помилка під час формування звіту.',
              finishedAt: row.completedAt ?? new Date().toISOString(),
              downloadFileName: fileName,
              startedAtMs: parseUtcDateTime(row.startedAt)?.getTime() ?? null,
            }));
            throw new Error(row.lastError ?? 'Сталася помилка під час формування звіту.');
          }

          if (row.bgtaskId === null) {
            applyReportHistoryRow(setState, row, { curr: 0, overall: 100 }, [], fileName);
            await sleep(1000);
            continue;
          }

          const rsp = await fetchBgtaskStatusAndLogs(row.bgtaskId, serverLogSkip);
          if (rsp.loglines.length > 0) {
            logs = logs.concat(rsp.loglines);
            serverLogSkip = logs.length;
          }
          const progress = getBgtaskProgressFromPercent(logs, rsp.progress);
          updateReportState(setState, (current) => ({
            ...current,
            taskId,
            historyRow: row,
            running: rsp.running,
            curr: rsp.running ? progress.curr : progress.overall,
            overall: progress.overall,
            logs,
            error: rsp.finishedWithError,
            finishedAt: rsp.running ? null : new Date().toISOString(),
            progressExpanded: rsp.running ? current.progressExpanded : current.progressExpanded || rsp.finishedWithError != null,
            downloadFileName: fileName,
            startedAtMs: parseUtcDateTime(row.startedAt)?.getTime() ?? null,
          }));

          if (!rsp.running) {
            if (rsp.finishedWithError) {
              throw new Error(rsp.finishedWithError);
            }
            break;
          }

          await sleep(1000);
        }

        const blob = await downloadNetworkEtalonkaReportTaskResult(taskId);
        downloadBlob(blob, fileName);
        updateReportState(setState, (current) => ({
          ...current,
          running: false,
          curr: current.overall,
          logs,
          error: null,
          finishedAt: new Date().toISOString(),
          progressExpanded: current.progressExpanded,
          downloadFileName: fileName,
          startedAtMs: current.historyRow?.startedAt ? parseUtcDateTime(current.historyRow.startedAt)?.getTime() ?? current.startedAtMs : current.startedAtMs,
        }));
      } catch (error) {
        updateReportState(setState, (current) => ({
          ...current,
          running: false,
          progressExpanded: true,
          error: formatErrorMessage(error),
          startedAtMs: current.historyRow?.startedAt ? parseUtcDateTime(current.historyRow.startedAt)?.getTime() ?? current.startedAtMs : current.startedAtMs,
        }));
        if (isUnauthorizedError(error)) {
          redirectToLogin();
          return;
        }
        throw error;
      }
    },
    [setState, state.network],
  );

  const openEtalonkaReportDialog = useCallback(() => {
    setState((current) => {
      if (!current.network) return current;
      return {
        ...current,
        menuAnchorEl: null,
        etalonkaReport: { ...current.etalonkaReport, dialogOpen: true, error: null },
      };
    });
  }, [setState]);

  const closeEtalonkaReportDialog = useCallback(() => {
    setState((current) => ({ ...current, menuAnchorEl: null, etalonkaReport: { ...current.etalonkaReport, dialogOpen: false, error: null } }));
  }, [setState]);

  const setEtalonkaReportProgressExpanded = useCallback((progressExpanded: boolean) => {
    updateReportState(setState, (current) => ({
      ...current,
      progressExpanded,
    }));
  }, [setState]);

  const setEtalonkaReportType = useCallback((reportType: NetworkEtalonkaReportType) => {
    updateReportState(setState, (current) => ({
      ...current,
      reportType,
    }));
  }, [setState]);

  const setEtalonkaReportActiveFreqsOnly = useCallback((activeFreqsOnly: boolean) => {
    updateReportState(setState, (current) => ({
      ...current,
      activeFreqsOnly,
    }));
  }, [setState]);

  const setEtalonkaReportIncludeSigintSigns = useCallback((includeSigintSigns: boolean) => {
    updateReportState(setState, (current) => ({
      ...current,
      includeSigintSigns,
    }));
  }, [setState]);

  const setEtalonkaReportIncludeConfirmation = useCallback((includeConfirmation: boolean) => {
    updateReportState(setState, (current) => ({
      ...current,
      includeConfirmation,
    }));
  }, [setState]);

  const setEtalonkaReportIncludeUnitCallsigns = useCallback((includeUnitCallsigns: boolean) => {
    updateReportState(setState, (current) => ({
      ...current,
      includeUnitCallsigns,
    }));
  }, [setState]);

  const setEtalonkaReportIncludePelengsMap = useCallback((includePelengsMap: boolean) => {
    updateReportState(setState, (current) => ({
      ...current,
      includePelengsMap,
    }));
  }, [setState]);

  const setEtalonkaReportFromDateTimeStr = useCallback((fromDateTimeStr: string) => {
    updateReportState(setState, (current) => ({
      ...current,
      fromDateTimeStr,
    }));
  }, [setState]);

  const setEtalonkaReportToDateTimeStr = useCallback((toDateTimeStr: string) => {
    updateReportState(setState, (current) => ({
      ...current,
      toDateTimeStr,
    }));
  }, [setState]);

  const downloadEtalonkaReport = useCallback(async () => {
    const network = state.network;
    const report = state.etalonkaReport;

    if (!network || report.running) return;

    setState((current) => ({ ...current, menuAnchorEl: null }));
    try {
      await runEtalonkaReportTask(report);
    } catch (error) {
      if (isUnauthorizedError(error)) {
        redirectToLogin();
      }
    }
  }, [runEtalonkaReportTask, state.etalonkaReport, state.network, setState]);

  return {
    openEtalonkaReportDialog,
    closeEtalonkaReportDialog,
    setEtalonkaReportType,
    setEtalonkaReportActiveFreqsOnly,
    setEtalonkaReportIncludeSigintSigns,
    setEtalonkaReportIncludeConfirmation,
    setEtalonkaReportIncludeUnitCallsigns,
    setEtalonkaReportIncludePelengsMap,
    setEtalonkaReportFromDateTimeStr,
    setEtalonkaReportToDateTimeStr,
    setEtalonkaReportProgressExpanded,
    downloadEtalonkaReport,
  };
}
