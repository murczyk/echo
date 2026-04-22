import type { InboxMessagesReq } from '../../../../Bindings';
import { useCallback, useState } from 'react';

import { downloadAnalysisReport } from '../../services/api/analysis';
import { downloadBlob } from '../../utils/download-blob';
import {
  buildReportFilename,
  buildReportRequest,
  createDefaultReportState,
  type AnalysisReportState,
} from './report-helpers';

type Props = {
  fromDateTimeStr: string;
  inboxReq: InboxMessagesReq | null;
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  toDateTimeStr: string;
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
  fromDateTimeStr,
  inboxReq,
  onError,
  onUnauthorized,
  toDateTimeStr,
}: Props): Result {
  const [report, setReport] = useState(createDefaultReportState);
  const [reportDownloadInFlight, setReportDownloadInFlight] = useState(false);

  const openReport = useCallback(() => {
    setReport((current) => ({ ...current, open: true }));
  }, []);

  const closeReport = useCallback(() => {
    setReport((current) => ({ ...current, open: false }));
  }, []);

  const updateReport = useCallback((patch: Partial<AnalysisReportState>) => {
    setReport((current) => ({ ...current, ...patch }));
  }, []);

  const downloadReport = useCallback(async () => {
    if (inboxReq == null) return;

    setReportDownloadInFlight(true);
    onError('');
    try {
      const blob = await downloadAnalysisReport(buildReportRequest(report, inboxReq));
      downloadBlob(blob, buildReportFilename(report, fromDateTimeStr, toDateTimeStr));
    } catch (error) {
      if (!onUnauthorized(error)) {
        onError(toErrorMessage(error));
      }
    } finally {
      setReportDownloadInFlight(false);
    }
  }, [fromDateTimeStr, inboxReq, onError, onUnauthorized, report, toDateTimeStr]);

  return {
    report,
    reportDownloadInFlight,
    closeReport,
    downloadReport,
    openReport,
    updateReport,
  };
}
