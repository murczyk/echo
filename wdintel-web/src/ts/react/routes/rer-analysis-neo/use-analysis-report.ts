import type { InboxMessagesReq } from '../../../../Bindings';
import React from 'react';

import { downloadAnalysisReport } from '../../services/api/analysis';
import { downloadBlob } from '../../utils/download';
import {
  buildReportFilename,
  buildReportRequest,
  createDefaultReportState,
  type AnalysisReportState,
} from './report-helpers';

type Props = {
  dateFrom: string;
  dateTo: string;
  inboxReq: InboxMessagesReq | null;
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  timeFrom: string;
  timeTo: string;
};

type Result = {
  report: AnalysisReportState;
  reportDownloadInFlight: boolean;
  closeReport: () => void;
  downloadReport: () => Promise<void>;
  openReport: () => void;
  updateReport: (patch: Partial<AnalysisReportState>) => void;
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Сталася помилка під час формування звіту.';
}

export function useAnalysisReport({
  dateFrom,
  dateTo,
  inboxReq,
  onError,
  onUnauthorized,
  timeFrom,
  timeTo,
}: Props): Result {
  const [report, setReport] = React.useState(createDefaultReportState);
  const [reportDownloadInFlight, setReportDownloadInFlight] = React.useState(false);

  const openReport = React.useCallback(() => {
    setReport((current) => ({ ...current, open: true }));
  }, []);

  const closeReport = React.useCallback(() => {
    setReport((current) => ({ ...current, open: false }));
  }, []);

  const updateReport = React.useCallback((patch: Partial<AnalysisReportState>) => {
    setReport((current) => ({ ...current, ...patch }));
  }, []);

  const downloadReport = React.useCallback(async () => {
    if (inboxReq == null) return;

    setReportDownloadInFlight(true);
    onError('');
    try {
      const blob = await downloadAnalysisReport(buildReportRequest(report, inboxReq));
      downloadBlob(blob, buildReportFilename(report, dateFrom, timeFrom, dateTo, timeTo));
    } catch (error) {
      if (!onUnauthorized(error)) {
        onError(toErrorMessage(error));
      }
    } finally {
      setReportDownloadInFlight(false);
    }
  }, [dateFrom, dateTo, inboxReq, onError, onUnauthorized, report, timeFrom, timeTo]);

  return {
    report,
    reportDownloadInFlight,
    closeReport,
    downloadReport,
    openReport,
    updateReport,
  };
}
