import { type Dispatch, type SetStateAction } from 'react';
import type { MRT_ColumnFiltersState, MRT_SortingState } from 'material-react-table';

import type { ListNetworksReq, Network } from '../../../../Bindings';
import { downloadBlob } from '../../utils/download-blob';
import { isUnauthorizedError } from '../../services/api/client';
import {
  downloadNetworkEtalonkaReportTaskResult,
  launchNetworkGoiReportTask,
  launchNetworkEtalonkaBatchReportTask,
  launchNetworksEtalonkaReportTask,
} from '../../services/api/networks';
import { fetchBgtaskStatusAndLogs, getBgtaskProgressFromPercent } from '../../services/api/bgtask';
import {
  downloadReportHistory,
  fetchReportHistoryStatus,
  fetchReportHistoryTaskStatus,
  isCancelledReportHistory,
  isCancelledReportHistoryError,
  parseUtcDateTime,
} from '../../services/api/report-history';
import type { NetworkEtalonkaReportState } from '../rer-network-details-neo/use-rer-network-details-neo-page.etalonka-report';
import type { NetworksFilterState } from './helpers';
import {
  buildEtalonkaNetworksBatchReq,
  buildEtalonkaNetworksReportReq,
  buildEtalonkaReportFilename,
  buildEtalonkaNetworksReportFilename,
  createDefaultNetworkEtalonkaReportState,
} from '../rer-network-details-neo/use-rer-network-details-neo-page.etalonka-report';
import { ReportCancelledError } from '../rer-network-details-neo/report-cancelled-error';
import { buildNetworksReportReq } from './helpers';
import { formatErrorMessage } from './use-rer-networks-neo-page.shared';
import { redirectToLogin } from '../../auth-redirect';
import type { SelectedSidebarUnitFilter } from '../rer-callsigns-neo/types';
import type { ReportHistoryRow } from '../../../../Bindings';

type ReportArgs = {
  rows: Array<{ id: number }>;
  filters: Pick<NetworksFilterState, 'status' | 'unitText' | 'showOnlyInvestigating'>;
  selectedSidebarUnitFilter: SelectedSidebarUnitFilter | null;
  columnFilters: MRT_ColumnFiltersState;
  sorting: MRT_SortingState;
  tableGlobalFilter: string;
  reportTargetNetworkIds: number[] | null;
  reportTargetRequest: ListNetworksReq | null;
  etalonkaReport: NetworkEtalonkaReportState;
  downloadInFlight: 'etalonka' | 'goi' | null;
  setReportTargetNetworkIds: Dispatch<SetStateAction<number[] | null>>;
  setReportTargetRequest: Dispatch<SetStateAction<ListNetworksReq | null>>;
  setEtalonkaReport: Dispatch<SetStateAction<NetworkEtalonkaReportState>>;
  setReportsMenuAnchorEl: Dispatch<SetStateAction<HTMLElement | null>>;
  setDownloadInFlight: Dispatch<SetStateAction<'etalonka' | 'goi' | null>>;
  setStatus: Dispatch<SetStateAction<{ kind: 'info' | 'success' | 'error'; text: string } | null>>;
};

export function createRerNetworksNeoReportActions(args: ReportArgs) {
  async function runEtalonkaReportTask(launchReport: () => Promise<number>, fileName: string) {
    args.setEtalonkaReport((current) => ({
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
      const taskId = await launchReport();
      let serverLogSkip = 0;
      let logs: string[] = [];

      while (true) {
        const row = await fetchReportHistoryStatus(taskId);
        if (row.status === 'failed') {
          if (isCancelledReportHistory(row)) {
            args.setEtalonkaReport((current) => ({
              ...current,
              taskId,
              historyRow: row,
              running: false,
              curr: current.curr,
              overall: current.overall,
              logs,
              error: 'Звіт скасовано в Моїх звітах.',
              finishedAt: row.completedAt ?? new Date().toISOString(),
              downloadFileName: fileName,
              startedAtMs: parseUtcDateTime(row.startedAt)?.getTime() ?? null,
            }));
            throw new ReportCancelledError();
          }
          args.setEtalonkaReport((current) => ({
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
          args.setEtalonkaReport((current) => ({
            ...current,
            taskId,
            historyRow: row,
            running: true,
            curr: 0,
            overall: 100,
            logs: [],
            error: null,
            finishedAt: null,
            progressExpanded: current.progressExpanded,
            downloadFileName: fileName,
            startedAtMs: parseUtcDateTime(row.startedAt)?.getTime() ?? null,
          }));
          await new Promise((resolve) => window.setTimeout(resolve, 1000));
          continue;
        }

        const rsp = await fetchBgtaskStatusAndLogs(row.bgtaskId, serverLogSkip);
        if (rsp.loglines.length > 0) {
          logs = logs.concat(rsp.loglines);
          serverLogSkip = logs.length;
        }
        const progress = getBgtaskProgressFromPercent(logs, rsp.progress);
        args.setEtalonkaReport((current) => ({
          ...current,
          taskId,
          historyRow: row,
          running: rsp.running,
          curr: rsp.running ? progress.curr : progress.overall,
          overall: progress.overall,
          logs,
          error: rsp.finishedWithError,
          finishedAt: rsp.running ? null : new Date().toISOString(),
          progressExpanded: rsp.running
            ? current.progressExpanded
            : current.progressExpanded || rsp.finishedWithError != null,
          downloadFileName: fileName,
          startedAtMs: parseUtcDateTime(row.startedAt)?.getTime() ?? null,
        }));

        if (!rsp.running) {
          if (rsp.finishedWithError) {
            const latestRow = await fetchReportHistoryStatus(taskId);
            if (
              isCancelledReportHistory(latestRow) ||
              isCancelledReportHistoryError(rsp.finishedWithError)
            ) {
              args.setEtalonkaReport((current) => ({
                ...current,
                taskId,
                historyRow: latestRow,
                running: false,
                curr: current.curr,
                overall: current.overall,
                logs,
                error: 'Звіт скасовано в Моїх звітах.',
                finishedAt: latestRow.completedAt ?? new Date().toISOString(),
                downloadFileName: fileName,
                startedAtMs: parseUtcDateTime(latestRow.startedAt)?.getTime() ?? null,
              }));
              throw new ReportCancelledError();
            }
            throw new Error(rsp.finishedWithError);
          }
          break;
        }

        await new Promise((resolve) => window.setTimeout(resolve, 1000));
      }

      const blob = await downloadNetworkEtalonkaReportTaskResult(taskId);
      downloadBlob(blob, fileName);
      args.setEtalonkaReport((current) => ({
        ...current,
        running: false,
        curr: current.overall,
        logs,
        error: null,
        finishedAt: new Date().toISOString(),
        progressExpanded: current.progressExpanded,
        downloadFileName: fileName,
        startedAtMs: current.historyRow?.startedAt
          ? (parseUtcDateTime(current.historyRow.startedAt)?.getTime() ?? current.startedAtMs)
          : current.startedAtMs,
      }));
    } catch (error) {
      if (error instanceof ReportCancelledError) {
        throw error;
      }
      args.setEtalonkaReport((current) => ({
        ...current,
        running: false,
        error: formatErrorMessage(error),
        progressExpanded: true,
        startedAtMs: current.historyRow?.startedAt
          ? (parseUtcDateTime(current.historyRow.startedAt)?.getTime() ?? current.startedAtMs)
          : current.startedAtMs,
      }));
      throw error;
    }
  }

  function openReportDialog(network: Network) {
    args.setReportTargetNetworkIds([network.id]);
    args.setReportTargetRequest(null);
    args.setEtalonkaReport((current) => ({ ...current, dialogOpen: true, error: null }));
  }

  function openTopReportDialog() {
    if (args.rows.length === 0) {
      args.setReportTargetNetworkIds(null);
      args.setReportTargetRequest(null);
      args.setStatus({ kind: 'info', text: 'Немає мереж для звіту з активними фільтрами.' });
      args.setReportsMenuAnchorEl(null);
      return;
    }

    args.setReportTargetNetworkIds(null);
    args.setReportTargetRequest(
      buildNetworksReportReq({
        searchText: args.tableGlobalFilter,
        selectedSidebarUnitFilter: args.selectedSidebarUnitFilter,
        selectedUnitLabel:
          args.filters.unitText.trim() === '' ? null : args.filters.unitText.trim(),
        showOnlyInvestigating: args.filters.showOnlyInvestigating,
        status: args.filters.status,
        columnFilters: args.columnFilters,
        sorting: args.sorting,
      }),
    );
    args.setEtalonkaReport((current) => ({ ...current, dialogOpen: true, error: null }));
    args.setReportsMenuAnchorEl(null);
  }

  function closeReportDialog() {
    args.setEtalonkaReport((current) => ({ ...current, dialogOpen: false, error: null }));
  }

  async function downloadEtalonkaReport() {
    if (args.etalonkaReport.running) return;
    const isFilteredReport = args.reportTargetRequest !== null;
    const hasRowReport =
      args.reportTargetNetworkIds !== null && args.reportTargetNetworkIds.length > 0;
    if (!isFilteredReport && !hasRowReport) return;

    const fileName = isFilteredReport
      ? buildEtalonkaNetworksReportFilename(args.etalonkaReport)
      : args.reportTargetNetworkIds!.length === 1
        ? buildEtalonkaReportFilename(args.reportTargetNetworkIds![0], args.etalonkaReport)
        : buildEtalonkaNetworksReportFilename(args.etalonkaReport);

    try {
      await runEtalonkaReportTask(
        () =>
          isFilteredReport
            ? launchNetworksEtalonkaReportTask(
                buildEtalonkaNetworksReportReq(args.reportTargetRequest!, args.etalonkaReport),
              )
            : launchNetworkEtalonkaBatchReportTask(
                buildEtalonkaNetworksBatchReq(
                  args.reportTargetNetworkIds ?? [],
                  args.etalonkaReport,
                ),
              ),
        fileName,
      );
    } catch (error) {
      if (error instanceof ReportCancelledError) {
        return;
      }
      if (isUnauthorizedError(error)) {
        args.setEtalonkaReport((current) => ({ ...current, running: false, error: null }));
        redirectToLogin();
        return;
      }
      args.setEtalonkaReport((current) => ({
        ...current,
        running: false,
        error: formatErrorMessage(error),
        progressExpanded: true,
      }));
    }
  }

  async function runDownload(kind: 'etalonka' | 'goi', networkIdsOverride?: number[]) {
    if (args.downloadInFlight !== null) return;
    const networkIds = networkIdsOverride ?? args.rows.map((row) => row.id);
    if (networkIds.length === 0) {
      args.setStatus({ kind: 'info', text: 'Немає мереж для звіту з активними фільтрами.' });
      return;
    }

    args.setDownloadInFlight(kind);
    try {
      if (kind === 'etalonka') {
        await runEtalonkaReportTask(
          () =>
            launchNetworkEtalonkaBatchReportTask({
              networkIds,
              sortBy: null,
              etalonkaType: {
                AccordingToTheForm: {
                  activeFreqsOnly: true,
                  includeSigintSigns: true,
                  includeConfirmation: true,
                  includeHeadingsAndFreqs: false,
                },
              },
            }),
          buildEtalonkaNetworksReportFilename(createDefaultNetworkEtalonkaReportState()),
        );
      } else {
        const reportHistoryId = await launchNetworkGoiReportTask();
        let running = true;
        while (running) {
          const rsp = await fetchReportHistoryTaskStatus(reportHistoryId, 0);
          if (!rsp.running) {
            if (rsp.finishedWithError) {
              throw new Error(rsp.finishedWithError);
            }
            running = false;
            break;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 1000));
        }
        const blob = await downloadReportHistory(reportHistoryId);
        downloadBlob(blob, 'goi_report.xlsx');
      }
      args.setStatus({
        kind: 'success',
        text: kind === 'etalonka' ? 'Еталонний опис завантажено.' : 'Звіт ГОІ завантажено.',
      });
    } catch (error) {
      if (isUnauthorizedError(error)) {
        if (kind === 'etalonka') {
          args.setEtalonkaReport((current) => ({ ...current, running: false, error: null }));
        }
        redirectToLogin();
        return;
      }
      if (error instanceof ReportCancelledError) {
        args.setStatus({ kind: 'info', text: 'Звіт скасовано в Моїх звітах.' });
        return;
      }
      args.setStatus({
        kind: 'error',
        text: `Помилка завантаження звіту: ${formatErrorMessage(error)}`,
      });
    } finally {
      args.setDownloadInFlight(null);
      args.setReportsMenuAnchorEl(null);
    }
  }

  return {
    openReportDialog,
    openTopReportDialog,
    closeReportDialog,
    downloadEtalonkaReport,
    runDownload,
  };
}
