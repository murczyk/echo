import { type Dispatch, type SetStateAction } from 'react';
import type { MRT_ColumnFiltersState, MRT_SortingState } from 'material-react-table';

import type { ListNetworksReq, Network } from '../../../../Bindings';
import { downloadBlob } from '../../utils/download-blob';
import { isUnauthorizedError } from '../../services/api/client';
import {
  downloadNetworkEtalonkaReport,
  downloadNetworkGoiReport,
  downloadNetworksEtalonkaReport,
} from '../../services/api/networks';
import type { NetworkEtalonkaReportState } from '../rer-network-details-neo/use-rer-network-details-neo-page.etalonka-report';
import type { NetworksFilterState } from './helpers';
import {
  buildEtalonkaNetworksBatchReq,
  buildEtalonkaNetworksReportReq,
  buildEtalonkaReportFilename,
} from '../rer-network-details-neo/use-rer-network-details-neo-page.etalonka-report';
import { buildNetworksReportReq } from './helpers';
import { formatErrorMessage, redirectToLogin } from './use-rer-networks-neo-page.shared';

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
  function openReportDialog(network: Network) {
    args.setReportTargetNetworkIds([network.id]);
    args.setReportTargetRequest(null);
    args.setEtalonkaReport((current) => ({
      ...current,
      dialogOpen: true,
      downloading: false,
      error: null,
    }));
  }

  function openTopReportDialog() {
    if (args.rows.length === 0) {
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
    args.setEtalonkaReport((current) => ({
      ...current,
      dialogOpen: true,
      downloading: false,
      error: null,
    }));
    args.setReportsMenuAnchorEl(null);
  }

  function closeReportDialog() {
    args.setEtalonkaReport((current) => (current.downloading ? current : { ...current, dialogOpen: false, error: null }));
    args.setReportTargetNetworkIds(null);
    args.setReportTargetRequest(null);
  }

  async function downloadEtalonkaReport() {
    if (args.etalonkaReport.downloading) return;
    const isFilteredReport = args.reportTargetRequest !== null;
    const hasRowReport = args.reportTargetNetworkIds !== null && args.reportTargetNetworkIds.length > 0;
    if (!isFilteredReport && !hasRowReport) return;

    const fileName = isFilteredReport
      ? 'etalonka_networks.docx'
      : args.reportTargetNetworkIds!.length === 1
        ? buildEtalonkaReportFilename(args.reportTargetNetworkIds![0], args.etalonkaReport)
        : 'etalonka_networks.docx';

    args.setEtalonkaReport((current) => ({ ...current, downloading: true, error: null }));

    try {
      const blob = isFilteredReport
        ? await downloadNetworksEtalonkaReport(
            buildEtalonkaNetworksReportReq(args.reportTargetRequest!, args.etalonkaReport),
          )
        : await downloadNetworkEtalonkaReport(
            buildEtalonkaNetworksBatchReq(args.reportTargetNetworkIds ?? [], args.etalonkaReport),
          );
      downloadBlob(blob, fileName);
      args.setEtalonkaReport((current) => ({ ...current, downloading: false, error: null }));
    } catch (error) {
      if (isUnauthorizedError(error)) {
        args.setEtalonkaReport((current) => ({ ...current, downloading: false, error: null }));
        redirectToLogin();
        return;
      }
      args.setEtalonkaReport((current) => ({ ...current, downloading: false, error: formatErrorMessage(error) }));
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
        const blob = await downloadNetworkEtalonkaReport({
          networkIds,
          sortBy: null,
          etalonkaType: {
            AccordingToTheForm: {
              activeFreqsOnly: true,
              includeSigintSigns: true,
              includeConfirmation: true,
            },
          },
        });
        downloadBlob(blob, 'etalonka_networks.docx');
      } else {
        const blob = await downloadNetworkGoiReport();
        downloadBlob(blob, 'goi_report.xlsx');
      }
      args.setStatus({ kind: 'success', text: kind === 'etalonka' ? 'Звіт завантажено.' : 'Звіт ГОІ завантажено.' });
    } catch (error) {
      if (isUnauthorizedError(error)) {
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
