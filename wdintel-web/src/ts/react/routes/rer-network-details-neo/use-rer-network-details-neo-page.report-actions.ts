import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import {
  downloadNetworkEtalonkaReportTaskResult,
  launchNetworkEtalonkaBatchReportTask,
} from '../../services/api/networks';
import { fetchBgtaskStatusAndLogs, getBgtaskProgress } from '../../services/api/bgtask';
import { isUnauthorizedError } from '../../services/api/client';
import { downloadBlob } from '../../utils/download-blob';
import { formatErrorMessage, type NetworkDetailsNeoPageState } from './use-rer-network-details-neo-page.shared';
import {
  buildEtalonkaNetworkBatchReq,
  buildEtalonkaReportFilename,
  type NetworkEtalonkaReportState,
  type NetworkEtalonkaReportType,
} from './use-rer-network-details-neo-page.etalonka-report';

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
        curr: 1,
        overall: 5,
        logs: ['[1/5] Підготовка даних'],
        finishedAt: null,
        progressExpanded: true,
        downloadFileName: fileName,
        startedAtMs: Date.now(),
        taskRunId: current.taskRunId + 1,
      }));

      try {
        const taskId = await launchNetworkEtalonkaBatchReportTask(buildEtalonkaNetworkBatchReq(network.id, report));
        let running = true;
        let serverLogSkip = 0;
        let logs: string[] = ['[1/5] Підготовка даних'];

        while (running) {
          const rsp = await fetchBgtaskStatusAndLogs(taskId, serverLogSkip);
          if (rsp.loglines.length > 0) {
            logs = logs.concat(rsp.loglines);
            serverLogSkip += rsp.loglines.length;
          }
          const progress = getBgtaskProgress(logs);
          updateReportState(setState, (current) => ({
            ...current,
            taskId,
            running: rsp.running,
            curr: rsp.running ? progress.curr : progress.overall,
            overall: progress.overall,
            logs,
            error: rsp.finishedWithError,
            finishedAt: rsp.running ? null : new Date().toISOString(),
            progressExpanded: rsp.running ? current.progressExpanded : current.progressExpanded || rsp.finishedWithError != null,
            downloadFileName: fileName,
            startedAtMs: current.startedAtMs,
          }));

          if (!rsp.running) {
            running = false;
            if (rsp.finishedWithError) {
              throw new Error(rsp.finishedWithError);
            }
            break;
          }

          await new Promise((resolve) => window.setTimeout(resolve, 1000));
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
          startedAtMs: current.startedAtMs,
        }));
      } catch (error) {
        updateReportState(setState, (current) => ({
          ...current,
          running: false,
          progressExpanded: true,
          error: formatErrorMessage(error),
          startedAtMs: current.startedAtMs,
        }));
        if (isUnauthorizedError(error)) {
          window.location.assign('/login');
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
        window.location.assign('/login');
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
