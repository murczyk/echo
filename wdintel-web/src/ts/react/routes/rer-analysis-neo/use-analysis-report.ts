import type { AnalysisStatsReq, InboxMessagesReq } from '../../../../Bindings';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  cancelAnalysisReportTask,
  downloadAnalysisSummaryTableXlsx,
  downloadAnalysisReportTaskResult,
  fetchAnalysisReportTaskStatus,
  launchAnalysisReportTask,
} from '../../services/api/analysis';
import { downloadBlob } from '../../utils/download-blob';
import {
  buildReportFilename,
  buildReportRequest,
  createDefaultReportState,
  reportTemplateToUiTitle,
  type AnalysisReportState,
} from './report-helpers';
import type { AnalysisReportTaskRun } from './types';

type Props = {
  analysisReq: AnalysisStatsReq | null;
  fromDateTimeStr: string;
  inboxReq: InboxMessagesReq | null;
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  toDateTimeStr: string;
};

type Result = {
  report: AnalysisReportState;
  reportDownloadInFlight: boolean;
  reportProgressExpanded: boolean;
  reportTaskRuns: AnalysisReportTaskRun[];
  cancelReportTaskRun: (id: number) => void;
  closeReport: () => void;
  downloadReport: () => Promise<void>;
  openReport: () => void;
  repeatReportTaskRun: (id: number) => Promise<void>;
  setReportProgressExpanded: (expanded: boolean) => void;
  toggleReportTaskRunLogs: (id: number, expanded: boolean) => void;
  updateReport: (patch: Partial<AnalysisReportState>) => void;
};

let reportTaskRunsMemory: AnalysisReportTaskRun[] = [];
let reportProgressExpandedMemory = true;
let reportTaskRunCounter = 0;
const reportTaskRunStatesMemory: Record<number, AnalysisReportState> = {};
const reportTaskRunTaskIdsMemory: Record<number, number> = {};
const cancelledReportTaskRunsMemory = new Set<number>();

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return normalizeReportTaskError(error.message);
  return 'Сталася помилка під час формування звіту.';
}

function normalizeReportTaskError(message: string): string {
  const compact = message.replace(/\s+/g, ' ').trim();

  if (compact.includes('No default AOR found')) {
    return 'Не знайдено AOR за замовчуванням для формування цього звіту.';
  }

  const noBacktrace = compact.split('Stack backtrace:')[0]?.trim() ?? compact;
  if (!noBacktrace.startsWith('AnyhowError')) {
    return noBacktrace;
  }

  const causes = [...noBacktrace.matchAll(/\d+:\s(.*?)(?=\s\d+:\s|$)/g)]
    .map((match) => match[1]?.trim() ?? '')
    .filter((part) => part.length > 0);
  const rootCause = causes
    .reverse()
    .find((part) => !part.startsWith('at ') && !part.startsWith('anyhow error') && !part.startsWith('line '));

  return rootCause ?? 'Сталася помилка під час формування звіту.';
}

function parseLastProgress(logs: string[]): { curr: number; overall: number } {
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const line = logs[index];
    const match = /\[(\d+)\/(\d+)\]/.exec(line);
    if (!match) continue;
    const curr = Number(match[1]);
    const overall = Number(match[2]);
    if (Number.isFinite(curr) && Number.isFinite(overall) && overall > 0) {
      return { curr, overall };
    }
  }
  return { curr: 1, overall: 100 };
}

export function useAnalysisReport({
  analysisReq,
  fromDateTimeStr,
  inboxReq,
  onError,
  onUnauthorized,
  toDateTimeStr,
}: Props): Result {
  const [report, setReport] = useState(createDefaultReportState);
  const [reportDownloadInFlight, setReportDownloadInFlight] = useState(false);
  const [reportProgressExpanded, setReportProgressExpandedState] = useState(reportProgressExpandedMemory);
  const [reportTaskRuns, setReportTaskRuns] = useState<AnalysisReportTaskRun[]>(reportTaskRunsMemory);
  const isMountedRef = useRef(true);
  const runSessionRef = useRef(0);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      runSessionRef.current += 1;
    };
  }, []);

  const updateReportTaskRuns = useCallback(
    (updater: (current: AnalysisReportTaskRun[]) => AnalysisReportTaskRun[]) => {
      setReportTaskRuns((current) => {
        const next = updater(current);
        reportTaskRunsMemory = next;
        return next;
      });
    },
    [],
  );

  const openReport = useCallback(() => {
    setReport((current) => ({ ...current, open: true }));
  }, []);

  const closeReport = useCallback(() => {
    setReport((current) => ({ ...current, open: false }));
  }, []);

  const toggleReportTaskRunLogs = useCallback(
    (id: number, expanded: boolean) => {
      updateReportTaskRuns((current) => current.map((run) => (run.id === id ? { ...run, expanded } : run)));
    },
    [updateReportTaskRuns],
  );

  const setReportProgressExpanded = useCallback((expanded: boolean) => {
    reportProgressExpandedMemory = expanded;
    setReportProgressExpandedState(expanded);
  }, []);

  const cancelReportTaskRun = useCallback(
    (id: number) => {
      cancelledReportTaskRunsMemory.add(id);
      const taskId = reportTaskRunTaskIdsMemory[id];
      updateReportTaskRuns((current) =>
        current.map((run) =>
          run.id === id && run.running
            ? {
                ...run,
                running: false,
                cancelled: true,
                error: null,
                finishedAt: new Date().toISOString(),
                expanded: true,
              }
            : run,
        ),
      );
      if (taskId != null) {
        void cancelAnalysisReportTask(taskId);
      }
      setReportDownloadInFlight(false);
    },
    [updateReportTaskRuns],
  );

  const updateReport = useCallback((patch: Partial<AnalysisReportState>) => {
    setReport((current) => ({ ...current, ...patch }));
  }, []);

  const runReportDownload = useCallback(
    async (state: AnalysisReportState) => {
      const sessionId = runSessionRef.current + 1;
      runSessionRef.current = sessionId;
      const shouldStopRun = (runId: number | null) =>
        !isMountedRef.current || runSessionRef.current !== sessionId || (runId != null && cancelledReportTaskRunsMemory.has(runId));

      if (state.template === 'summary_table') {
        if (analysisReq == null) {
          onError('Перевірте дату та час перед експортом.');
          return;
        }

        setReportDownloadInFlight(true);
        onError('');
        try {
          const blob = await downloadAnalysisSummaryTableXlsx(analysisReq);
          if (shouldStopRun(null)) {
            return;
          }
          downloadBlob(blob, buildReportFilename(state, fromDateTimeStr, toDateTimeStr));
        } catch (error) {
          if (isMountedRef.current && !onUnauthorized(error)) {
            onError(toErrorMessage(error));
          }
        } finally {
          if (isMountedRef.current) {
            setReportDownloadInFlight(false);
          }
        }
        return;
      }

      if (inboxReq == null) {
        onError('Перевірте дату та час перед експортом.');
        return;
      }

      setReportDownloadInFlight(true);
      onError('');
      setReportProgressExpanded(true);
      let runId: number | null = null;
      try {
        const reportName = buildReportFilename(state, fromDateTimeStr, toDateTimeStr);
        const reportTitle = reportTemplateToUiTitle(state);
        const headerTitle = `Звіт ${reportTitle}: ${reportName}`;
        reportTaskRunCounter += 1;
        const currentRunId = reportTaskRunCounter;
        runId = currentRunId;
        reportTaskRunStatesMemory[currentRunId] = { ...state };
        updateReportTaskRuns((current) => [
          ...current,
          {
            id: currentRunId,
            reportTitle,
            reportName,
            headerTitle,
            running: true,
            cancelled: false,
            curr: 1,
            overall: 4,
            logs: [headerTitle],
            error: null,
            startedAt: new Date().toISOString(),
            finishedAt: null,
            expanded: true,
          },
        ]);

        const taskId = await launchAnalysisReportTask(buildReportRequest(state, inboxReq));
        if (runId != null) {
          reportTaskRunTaskIdsMemory[runId] = taskId;
        }
        if (shouldStopRun(runId)) {
          await cancelAnalysisReportTask(taskId).catch(() => undefined);
          return;
        }
        let running = true;
        let skip = 0;
        let logs: string[] = [];
        while (running) {
          if (shouldStopRun(runId)) {
            break;
          }
          const rsp = await fetchAnalysisReportTaskStatus(taskId, skip);
          if (shouldStopRun(runId)) {
            break;
          }
          if (rsp.loglines.length > 0) {
            logs = logs.concat(rsp.loglines);
            skip = logs.length;
          }
          const progress = parseLastProgress(logs);
          updateReportTaskRuns((current) =>
            current.map((run) =>
              run.id !== runId
                ? run
                : {
                    ...run,
                    running: rsp.running,
                    cancelled: false,
                    curr: rsp.running ? progress.curr : rsp.finishedWithError ? progress.curr : progress.overall,
                    overall: progress.overall,
                    logs: [run.headerTitle, ...logs],
                    error: rsp.finishedWithError ? normalizeReportTaskError(rsp.finishedWithError) : null,
                    finishedAt: rsp.running ? null : new Date().toISOString(),
                    expanded: rsp.running ? true : rsp.finishedWithError != null,
                  },
            ),
          );
          if (!rsp.running) {
            if (rsp.finishedWithError) {
              throw new Error(rsp.finishedWithError);
            }
            running = false;
            break;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 1000));
        }
        if (!isMountedRef.current || runSessionRef.current !== sessionId) {
          return;
        }
        if (runId != null && cancelledReportTaskRunsMemory.has(runId)) {
          cancelledReportTaskRunsMemory.delete(runId);
          return;
        }
        const blob = await downloadAnalysisReportTaskResult(taskId);
        if (shouldStopRun(runId)) {
          return;
        }
        downloadBlob(blob, buildReportFilename(state, fromDateTimeStr, toDateTimeStr));
        setReportProgressExpanded(false);
      } catch (error) {
        if (isMountedRef.current && !onUnauthorized(error)) {
          const message = toErrorMessage(error);
          onError(message);
          updateReportTaskRuns((current) =>
            current.map((run) =>
              run.id === runId ? { ...run, running: false, error: message, finishedAt: new Date().toISOString(), expanded: true } : run,
            ),
          );
        }
      } finally {
        if (runId != null) {
          delete reportTaskRunTaskIdsMemory[runId];
        }
        if (isMountedRef.current) {
          setReportDownloadInFlight(false);
        }
      }
    },
    [analysisReq, fromDateTimeStr, inboxReq, onError, onUnauthorized, setReportProgressExpanded, toDateTimeStr, updateReportTaskRuns],
  );

  const repeatReportTaskRun = useCallback(
    async (id: number) => {
      const reportState = reportTaskRunStatesMemory[id];
      if (reportState == null) return;
      setReport((current) => ({ ...current, ...reportState, open: true }));
      await runReportDownload(reportState);
    },
    [runReportDownload],
  );

  const downloadReport = useCallback(async () => {
    await runReportDownload(report);
  }, [report, runReportDownload]);

  return {
    report,
    reportDownloadInFlight,
    reportProgressExpanded,
    reportTaskRuns,
    cancelReportTaskRun,
    closeReport,
    downloadReport,
    openReport,
    repeatReportTaskRun,
    setReportProgressExpanded,
    toggleReportTaskRunLogs,
    updateReport,
  };
}
