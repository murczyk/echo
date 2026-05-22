import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import { downloadNetworkEtalonkaReport } from '../../services/api/networks';
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
  const openEtalonkaReportDialog = useCallback(() => {
    setState((current) => {
      if (!current.network) return current;
      return {
        ...current,
        menuAnchorEl: null,
        etalonkaReport: {
          ...current.etalonkaReport,
          dialogOpen: true,
          error: null,
        },
      };
    });
  }, [setState]);

  const closeEtalonkaReportDialog = useCallback(() => {
    setState((current) => {
      if (current.etalonkaReport.downloading) return current;
      return {
        ...current,
        menuAnchorEl: null,
        etalonkaReport: {
          ...current.etalonkaReport,
          dialogOpen: false,
          error: null,
        },
      };
    });
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

    if (!network || report.downloading) return;

    const req = buildEtalonkaNetworkBatchReq(network.id, report);
    const fileName = buildEtalonkaReportFilename(network.id, report);

    setState((current) => ({
      ...current,
      menuAnchorEl: null,
      etalonkaReport: {
        ...current.etalonkaReport,
        downloading: true,
        error: null,
      },
    }));

    try {
      const blob = await downloadNetworkEtalonkaReport(req);
      downloadBlob(blob, fileName);
    } catch (error) {
      setState((current) => ({
        ...current,
        etalonkaReport: {
          ...current.etalonkaReport,
          downloading: false,
          error: formatErrorMessage(error),
        },
      }));
      return;
    }

    setState((current) => ({
      ...current,
      etalonkaReport: {
        ...current.etalonkaReport,
        downloading: false,
        error: null,
      },
    }));
  }, [state.etalonkaReport, state.network, setState]);

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
    downloadEtalonkaReport,
  };
}
