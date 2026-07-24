import type { AnalysisStatsReq, InboxMessagesReq, ReportHistoryRow } from '../../../../Bindings';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isNullOrUndefined } from '../../utils/misc';

import {
  downloadAnalysisReportTaskResult,
  fetchAnalysisReportTaskStatus,
  launchAnalysisGeojsonTask,
  launchAnalysisKmzTask,
  launchAnalysisReportTask,
  launchAnalysisSummaryTableTask,
} from '../../services/api/analysis';
import { fetchBgtaskStatusAndLogs, getBgtaskProgressFromPercent } from '../../services/api/bgtask';
import { downloadBlob } from '../../utils/download-blob';
import {
  fetchReportHistoryStatus,
  isCancelledReportHistory,
} from '../../services/api/report-history';
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

type ReportTaskErrorCode =
  'mouse_report_message_limit' | 'summary_table_report_message_limit' | 'no_default_aor';

class ReportTaskError extends Error {
  code: ReportTaskErrorCode | null;

  constructor(message: string, code: ReportTaskErrorCode | null) {
    super(message);
    this.name = 'ReportTaskError';
    this.code = code;
  }
}

function normalizeReportTaskErrorCode(code: string | null): ReportTaskErrorCode | null {
  if (code?.includes('mouse_report_message_limit')) return 'mouse_report_message_limit';
  if (code?.includes('summary_table_report_message_limit')) {
    return 'summary_table_report_message_limit';
  }
  return code === 'no_default_aor' ? code : null;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof ReportTaskError) {
    if (
      error.code === 'mouse_report_message_limit' ||
      error.code === 'summary_table_report_message_limit'
    ) {
      return 'Звіт містить понад 10 000 повідомлень. Зменшіть період або звузьте фільтри.';
    }
    if (error.code === 'no_default_aor') {
      return 'Не знайдено AOR за замовчуванням для формування цього звіту.';
    }
    return 'Сталася помилка під час формування звіту.';
  }
  if (error instanceof Error) return error.message || 'Сталася помилка під час формування звіту.';
  return 'Сталася помилка під час формування звіту.';
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
  const [reportProgressExpanded, setReportProgressExpandedState] = useState(false);
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

  const finalizeCancelledReportTaskRun = useCallback(
    (id: number, historyRow: ReportHistoryRow, logs: string[]) => {
      updateReportTaskRuns((current) =>
        current.map((run) =>
          run.id === id
            ? {
                ...run,
                running: false,
                cancelled: true,
                curr: run.curr,
                overall: run.overall,
                logs,
                error: null,
                finishedAt: historyRow.completedAt ?? new Date().toISOString(),
                expanded: false,
                historyRow,
                startedAt: historyRow.startedAt ?? run.startedAt,
              }
            : run,
        ),
      );
    },
    [updateReportTaskRuns],
  );

  const openReport = useCallback(() => {
    setReport((current) => ({ ...current, open: true }));
  }, []);

  const closeReport = useCallback(() => {
    setReport((current) => ({ ...current, open: false }));
  }, []);

  const toggleReportTaskRunLogs = useCallback(
    (id: number, expanded: boolean) => {
      updateReportTaskRuns((current) =>
        current.map((run) => (run.id === id ? { ...run, expanded } : run)),
      );
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

      if (
        state.template === 'summary_table' ||
        state.template === 'kmz' ||
        state.template === 'geojson'
      ) {
        if (isNullOrUndefined(runSnapshot.analysisReq)) {
          onError('Перевірте дату та час перед експортом.');
          return;
        }

        setReportDownloadInFlight(true);
        onError('');
        try {
          const taskId =
            state.template === 'summary_table'
              ? await launchAnalysisSummaryTableTask(runSnapshot.analysisReq)
              : state.template === 'kmz'
                ? await launchAnalysisKmzTask(runSnapshot.analysisReq)
                : await launchAnalysisGeojsonTask(runSnapshot.analysisReq);
          let running = true;
          let skip = 0;
          while (running) {
            if (shouldStopRun()) {
              return;
            }
            const rsp = await fetchAnalysisReportTaskStatus(taskId, skip);
            skip += rsp.loglines.length;
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
          const blob = await downloadAnalysisReportTaskResult(taskId);
          if (shouldStopRun()) {
            return;
          }
          downloadBlob(
            blob,
            buildReportFilename(state, runSnapshot.fromDateTimeStr, runSnapshot.toDateTimeStr),
          );
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
      setReportProgressExpanded(false);
      let runId: number | null = null;
      try {
        const reportName = buildReportFilename(
          state,
          runSnapshot.fromDateTimeStr,
          runSnapshot.toDateTimeStr,
        );
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
            curr: 0,
            overall: 100,
            logs: [],
            error: null,
            startedAt: null,
            finishedAt: null,
            expanded: false,
            historyRow: null,
          },
        ]);

        const taskId = await launchAnalysisReportTask(
          buildReportRequest(state, runSnapshot.inboxReq),
        );
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
          const historyRow = await fetchReportHistoryStatus(taskId);
          if (shouldStopRun()) {
            finalizeAbortedReportTaskRun(runId);
            return;
          }
          if (historyRow.status === 'failed') {
            if (isCancelledReportHistory(historyRow)) {
              finalizeCancelledReportTaskRun(runId, historyRow, logs);
              return;
            }
            const message = toErrorMessage(
              new ReportTaskError(
                historyRow.lastError ?? 'Сталася помилка під час формування звіту.',
                normalizeReportTaskErrorCode(historyRow.lastError),
              ),
            );
            updateReportTaskRuns((current) =>
              current.map((run) =>
                run.id !== runId
                  ? run
                  : {
                      ...run,
                      running: false,
                      cancelled: false,
                      curr: 0,
                      overall: 100,
                      logs,
                      error: message,
                      startedAt: historyRow.startedAt ?? run.startedAt,
                      finishedAt: new Date().toISOString(),
                      expanded: true,
                      historyRow,
                    },
              ),
            );
            throw new ReportTaskError(
              historyRow.lastError ?? 'Сталася помилка під час формування звіту.',
              normalizeReportTaskErrorCode(historyRow.lastError),
            );
          }
          if (historyRow.status === 'done') {
            updateReportTaskRuns((current) =>
              current.map((run) =>
                run.id !== runId
                  ? run
                  : {
                      ...run,
                      running: false,
                      cancelled: false,
                      curr: 100,
                      overall: 100,
                      logs,
                      error: null,
                      startedAt: historyRow.startedAt ?? run.startedAt,
                      finishedAt: new Date().toISOString(),
                      expanded: true,
                      historyRow,
                    },
              ),
            );
            running = false;
            break;
          }

          if (historyRow.bgtaskId === null) {
            updateReportTaskRuns((current) =>
              current.map((run) =>
                run.id !== runId
                  ? run
                  : {
                      ...run,
                      running: true,
                      cancelled: false,
                      curr: 0,
                      overall: 100,
                      logs: [],
                      error: null,
                      startedAt: historyRow.startedAt ?? null,
                      finishedAt: null,
                      expanded: run.expanded,
                      historyRow,
                    },
              ),
            );
            await new Promise((resolve) => window.setTimeout(resolve, 1000));
            continue;
          }

          const rsp = await fetchBgtaskStatusAndLogs(historyRow.bgtaskId, skip);
          if (rsp.loglines.length > 0) {
            logs = logs.concat(rsp.loglines);
            skip = logs.length;
          }
          const progress = getBgtaskProgressFromPercent(logs, rsp.progress);
          updateReportTaskRuns((current) =>
            current.map((run) =>
              run.id !== runId
                ? run
                : {
                    ...run,
                    running: rsp.running,
                    cancelled: false,
                    curr: rsp.running
                      ? progress.curr
                      : rsp.finishedWithError
                        ? progress.curr
                        : progress.overall,
                    overall: progress.overall,
                    logs,
                    error: rsp.finishedWithError
                      ? toErrorMessage(
                          new ReportTaskError(
                            rsp.finishedWithError,
                            normalizeReportTaskErrorCode(rsp.finishedWithErrorCode),
                          ),
                        )
                      : null,
                    finishedAt: rsp.running ? null : new Date().toISOString(),
                    expanded: run.expanded || rsp.finishedWithError != null,
                    historyRow,
                    startedAt: historyRow.startedAt ?? run.startedAt,
                  },
            ),
          );
          if (!rsp.running) {
            if (rsp.finishedWithError) {
              const latestRow = await fetchReportHistoryStatus(taskId);
              if (isCancelledReportHistory(latestRow)) {
                finalizeCancelledReportTaskRun(runId, latestRow, logs);
                return;
              }
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
        let downloadFileName = buildReportFilename(
          state,
          runSnapshot.fromDateTimeStr,
          runSnapshot.toDateTimeStr,
        );
        if (state.template === 'rer_report' || state.template === 'sposob') {
          const latestRow = await fetchReportHistoryStatus(taskId);
          if (shouldStopRun()) {
            finalizeAbortedReportTaskRun(runId);
            return;
          }
          if (latestRow.fileName != null) {
            downloadFileName = latestRow.fileName;
          }
        }
        const blob = await downloadAnalysisReportTaskResult(taskId);
        if (shouldStopRun()) {
          finalizeAbortedReportTaskRun(runId);
          return;
        }
        downloadBlob(blob, downloadFileName);
        setReportProgressExpanded(false);
      } catch (error) {
        if (isMountedRef.current && !onUnauthorized(error)) {
          const message = toErrorMessage(error);
          onError(message);
          updateReportTaskRuns((current) =>
            current.map((run) =>
              run.id === runId
                ? {
                    ...run,
                    running: false,
                    error: message,
                    finishedAt: new Date().toISOString(),
                    expanded: true,
                  }
                : run,
            ),
          );
        }
      } finally {
        if (isMountedRef.current) {
          setReportDownloadInFlight(false);
        }
      }
    },
    [
      analysisReq,
      finalizeAbortedReportTaskRun,
      finalizeCancelledReportTaskRun,
      fromDateTimeStr,
      inboxReq,
      onError,
      onUnauthorized,
      setReportProgressExpanded,
      toDateTimeStr,
      updateReportTaskRuns,
    ],
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
