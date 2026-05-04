import type { AnalysisStatsReq, InboxMessagesReq } from '../../../../Bindings';
import { useCallback, useState } from 'react';

import { downloadAnalysisReport, downloadAnalysisSummaryTableXlsx } from '../../services/api/analysis';
import { downloadBlob } from '../../utils/download-blob';
import {
  buildReportFilename,
  buildReportRequest,
  createDefaultReportState,
  type AnalysisReportState,
} from './report-helpers';

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
  analysisReq,
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
    if (report.template === 'summary_table') {
      if ((analysisReq === null || analysisReq === undefined)) {
        onError('Перевірте дату та час перед експортом.');
        return;
      }

      setReportDownloadInFlight(true);
      onError('');
      try {
        const blob = await downloadAnalysisSummaryTableXlsx(analysisReq);
        downloadBlob(blob, buildReportFilename(report, fromDateTimeStr, toDateTimeStr));
      } catch (error) {
        if (!onUnauthorized(error)) {
          onError(toErrorMessage(error));
        }
      } finally {
        setReportDownloadInFlight(false);
      }
      return;
    }

    if ((inboxReq === null || inboxReq === undefined)) {
      onError('Перевірте дату та час перед експортом.');
      return;
    }

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
  }, [analysisReq, fromDateTimeStr, inboxReq, onError, onUnauthorized, report, toDateTimeStr]);

  return {
    report,
    reportDownloadInFlight,
    closeReport,
    downloadReport,
    openReport,
    updateReport,
  };
}
