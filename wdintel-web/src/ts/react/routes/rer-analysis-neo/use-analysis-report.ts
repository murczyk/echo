import type { AnalysisStatsReq, InboxMessagesReq } from '../../../../Bindings';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isNullOrUndefined } from '../../utils/misc';

import {
  downloadAnalysisGeojson,
  downloadAnalysisKmz,
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
  closeReport: () => void;
  downloadReport: () => Promise<void>;
  openReport: () => void;
  repeatReportTaskRun: (id: number) => Promise<void>;
  setReportProgressExpanded: (expanded: boolean) => void;
  toggleReportTaskRunLogs: (id: number, expanded: boolean) => void;
  updateReport: (patch: Partial<AnalysisReportState>) => void;
};

type ReportRunSnapshot = {
  analysisReq: AnalysisStatsReq | null;
  fromDateTimeStr: string;
  inboxReq: InboxMessagesReq | null;
  report: AnalysisReportState;
  toDateTimeStr: string;
};

type ReportTaskErrorCode = 'no_default_aor';

class ReportTaskError extends Error {
  code: ReportTaskErrorCode | null;

  constructor(message: string, code: ReportTaskErrorCode | null) {
    super(message);
    this.name = 'ReportTaskError';
    this.code = code;
  }
}

function normalizeReportTaskErrorCode(code: string | null): ReportTaskErrorCode | null {
  return code === 'no_default_aor' ? code : null;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof ReportTaskError) {
    if (error.code === 'no_default_aor') {
      return 'Не знайдено AOR за замовчуванням для формування цього звіту.';
    }
    return error.message || 'Сталася помилка під час формування звіту.';
  }
  if (error instanceof Error) return error.message || 'Сталася помилка під час формування звіту.';
  return 'Сталася помилка під час формування звіту.';
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
  return { curr: 1, overall: 4 };
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
  const [reportProgressExpanded, setReportProgressExpandedState] = useState(true);
  const [reportTaskRuns, setReportTaskRunsState] = useState<AnalysisReportTaskRun[]>([]);
  const isMountedRef = useRef(true);
  const runSessionRef = useRef(0);
  const reportTaskRunCounterRef = useRef(0);
  const reportTaskRunSnapshotsRef = useRef<Record<number, ReportRunSnapshot>>({});
  const reportTaskRunsRef = useRef<AnalysisReportTaskRun[]>([]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      runSessionRef.current += 1;
    };
  }, []);

  const updateReportTaskRuns = useCallback(
    (updater: (current: AnalysisReportTaskRun[]) => AnalysisReportTaskRun[]) => {
      setReportTaskRunsState((current) => {
        const next = updater(current);
        reportTaskRunsRef.current = next;
        return next;
      });
    },
    [],
  );

  const finalizeAbortedReportTaskRun = useCallback((id: number) => {
    const updater = (current: AnalysisReportTaskRun[]) =>
      current.map((run) =>
        run.id === id && run.running
          ? {
              ...run,
              running: false,
              cancelled: true,
              finishedAt: new Date().toISOString(),
              expanded: true,
            }
          : run,
      );

    reportTaskRunsRef.current = updater(reportTaskRunsRef.current);
    if (isMountedRef.current) {
      setReportTaskRunsState((current) => updater(current));
    }
  }, []);

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
    setReportProgressExpandedState(expanded);
  }, []);

  const updateReport = useCallback((patch: Partial<AnalysisReportState>) => {
    setReport((current) => ({ ...current, ...patch }));
  }, []);

  const runReportDownload = useCallback(
    async (state: AnalysisReportState, snapshot?: ReportRunSnapshot) => {
      const runSnapshot: ReportRunSnapshot = snapshot ?? {
        analysisReq,
        fromDateTimeStr,
        inboxReq,
        report: state,
        toDateTimeStr,
      };
      const sessionId = runSessionRef.current + 1;
      runSessionRef.current = sessionId;
      const shouldStopRun = () => !isMountedRef.current || runSessionRef.current !== sessionId;

      if (state.template === 'summary_table' || state.template === 'kmz' || state.template === 'geojson') {
        if (isNullOrUndefined(runSnapshot.analysisReq)) {
          onError('Перевірте дату та час перед експортом.');
          return;
        }

        setReportDownloadInFlight(true);
        onError('');
        try {
          const blob =
            state.template === 'summary_table'
              ? await downloadAnalysisSummaryTableXlsx(runSnapshot.analysisReq)
              : state.template === 'kmz'
                ? await downloadAnalysisKmz(runSnapshot.analysisReq)
                : await downloadAnalysisGeojson(runSnapshot.analysisReq);
          if (shouldStopRun()) {
            return;
          }
          downloadBlob(blob, buildReportFilename(state, runSnapshot.fromDateTimeStr, runSnapshot.toDateTimeStr));
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

      if (isNullOrUndefined(runSnapshot.inboxReq)) {
        onError('Перевірте дату та час перед експортом.');
        return;
      }

      setReportDownloadInFlight(true);
      onError('');
      setReportProgressExpanded(true);
      let runId: number | null = null;
      try {
        const reportName = buildReportFilename(state, runSnapshot.fromDateTimeStr, runSnapshot.toDateTimeStr);
        const reportTitle = reportTemplateToUiTitle(state);
        const headerTitle = `Звіт ${reportTitle}: ${reportName}`;
        reportTaskRunCounterRef.current += 1;
        const currentRunId = reportTaskRunCounterRef.current;
        runId = currentRunId;
        reportTaskRunSnapshotsRef.current[currentRunId] = {
          ...runSnapshot,
          report: { ...state },
        };
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

        const taskId = await launchAnalysisReportTask(buildReportRequest(state, runSnapshot.inboxReq));
        if (shouldStopRun()) {
          finalizeAbortedReportTaskRun(runId);
          return;
        }
        let running = true;
        let skip = 0;
        let logs: string[] = [];
        while (running) {
          if (shouldStopRun()) {
            finalizeAbortedReportTaskRun(runId);
            return;
          }
          const rsp = await fetchAnalysisReportTaskStatus(taskId, skip);
          if (shouldStopRun()) {
            finalizeAbortedReportTaskRun(runId);
            return;
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
                    error: rsp.finishedWithError
                      ? toErrorMessage(
                          new ReportTaskError(
                            rsp.finishedWithError,
                            normalizeReportTaskErrorCode(rsp.finishedWithErrorCode),
                          ),
                        )
                      : null,
                    finishedAt: rsp.running ? null : new Date().toISOString(),
                    expanded: rsp.running ? true : rsp.finishedWithError != null,
                  },
            ),
          );
          if (!rsp.running) {
            if (rsp.finishedWithError) {
              throw new ReportTaskError(
                rsp.finishedWithError,
                normalizeReportTaskErrorCode(rsp.finishedWithErrorCode),
              );
            }
            running = false;
            break;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 1000));
        }
        if (!isMountedRef.current || runSessionRef.current !== sessionId) {
          finalizeAbortedReportTaskRun(runId);
          return;
        }
        const blob = await downloadAnalysisReportTaskResult(taskId);
        if (shouldStopRun()) {
          finalizeAbortedReportTaskRun(runId);
          return;
        }
        downloadBlob(blob, buildReportFilename(state, runSnapshot.fromDateTimeStr, runSnapshot.toDateTimeStr));
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
        if (isMountedRef.current) {
          setReportDownloadInFlight(false);
        }
      }
    },
    [analysisReq, finalizeAbortedReportTaskRun, fromDateTimeStr, inboxReq, onError, onUnauthorized, setReportProgressExpanded, toDateTimeStr, updateReportTaskRuns],
  );

  const repeatReportTaskRun = useCallback(
    async (id: number) => {
      const snapshot = reportTaskRunSnapshotsRef.current[id];
      if (isNullOrUndefined(snapshot)) return;
      setReport((current) => ({ ...current, ...snapshot.report, open: true }));
      await runReportDownload(snapshot.report, snapshot);
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
    closeReport,
    downloadReport,
    openReport,
    repeatReportTaskRun,
    setReportProgressExpanded,
    toggleReportTaskRunLogs,
    updateReport,
  };
}
