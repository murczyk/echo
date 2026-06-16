import { type Dispatch, type SetStateAction } from 'react';
import type { MRT_ColumnFiltersState, MRT_SortingState } from 'material-react-table';

import type { ListNetworksReq, Network } from '../../../../Bindings';
import { downloadBlob } from '../../utils/download-blob';
import { isUnauthorizedError } from '../../services/api/client';
import {
  downloadNetworkEtalonkaReportTaskResult,
  downloadNetworkGoiReport,
  launchNetworkEtalonkaBatchReportTask,
  launchNetworksEtalonkaReportTask,
} from '../../services/api/networks';
import { fetchBgtaskStatusAndLogs, getBgtaskProgress } from '../../services/api/bgtask';
import type { NetworkEtalonkaReportState } from '../rer-network-details-neo/use-rer-network-details-neo-page.etalonka-report';
import type { NetworksFilterState } from './helpers';
import {
  buildEtalonkaNetworksBatchReq,
  buildEtalonkaNetworksReportReq,
  buildEtalonkaReportFilename,
  buildEtalonkaNetworksReportFilename,
  createDefaultNetworkEtalonkaReportState,
} from '../rer-network-details-neo/use-rer-network-details-neo-page.etalonka-report';
import { buildNetworksReportReq } from './helpers';
import { formatErrorMessage } from './use-rer-networks-neo-page.shared';
import { redirectToLogin } from '../../auth-redirect';

type ReportArgs = {
  rows: Array<{ id: number }>;
  filters: Pick<NetworksFilterState, 'status' | 'unitText' | 'showOnlyInvestigating'>;
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
  async function runEtalonkaReportTask(
    launchReport: () => Promise<number>,
    fileName: string,
  ) {
    args.setEtalonkaReport((current) => ({
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
      const taskId = await launchReport();
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
        args.setEtalonkaReport((current) => ({
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
      args.setEtalonkaReport((current) => ({
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
      args.setEtalonkaReport((current) => ({
        ...current,
        running: false,
        error: formatErrorMessage(error),
        progressExpanded: true,
        startedAtMs: current.startedAtMs,
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
        selectedUnitLabel: args.filters.unitText.trim() === '' ? null : args.filters.unitText.trim(),
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
    const hasRowReport = args.reportTargetNetworkIds !== null && args.reportTargetNetworkIds.length > 0;
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
                buildEtalonkaNetworksBatchReq(args.reportTargetNetworkIds ?? [], args.etalonkaReport),
              ),
        fileName,
      );
    } catch (error) {
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
          () => launchNetworkEtalonkaBatchReportTask({
            networkIds,
            sortBy: null,
            etalonkaType: {
              AccordingToTheForm: {
                activeFreqsOnly: true,
                includeSigintSigns: true,
                includeConfirmation: true,
              },
            },
          }),
          buildEtalonkaNetworksReportFilename(createDefaultNetworkEtalonkaReportState()),
        );
      } else {
        const blob = await downloadNetworkGoiReport();
        downloadBlob(blob, 'goi_report.xlsx');
      }
      args.setStatus({ kind: 'success', text: kind === 'etalonka' ? 'Еталонний опис завантажено.' : 'Звіт ГОІ завантажено.' });
    } catch (error) {
      if (isUnauthorizedError(error)) {
        if (kind === 'etalonka') {
          args.setEtalonkaReport((current) => ({ ...current, running: false, error: null }));
        }
        redirectToLogin();
        return;
      }
      args.setStatus({ kind: 'error', text: `Помилка завантаження звіту: ${formatErrorMessage(error)}` });
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
