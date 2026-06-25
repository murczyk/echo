import dayjs from 'dayjs';

import type { EtalonkaJimForksReq, EtalonkaNetworkBatchReq, EtalonkaReportType, ListNetworksReq, ReportHistoryRow } from '../../../../Bindings';
import { APP_TIME_ZONE, combineDateTimeInputToMs } from '../../utils/misc';

export type NetworkEtalonkaReportType = 'AccordingToTheForm' | 'ExtendedReport';

export type NetworkEtalonkaReportState = {
  dialogOpen: boolean;
  taskRunId: number;
  taskId: number | null;
  historyRow?: ReportHistoryRow | null;
  startedAtMs: number | null;
  running: boolean;
  curr: number;
  overall: number;
  logs: string[];
  reportType: NetworkEtalonkaReportType;
  activeFreqsOnly: boolean;
  includeSigintSigns: boolean;
  includeConfirmation: boolean;
  includeUnitCallsigns: boolean;
  includePelengsMap: boolean;
  fromDateTimeStr: string;
  toDateTimeStr: string;
  downloadFileName: string | null;
  error: string | null;
  finishedAt: string | null;
  progressExpanded: boolean;
};

export function createDefaultNetworkEtalonkaReportState(): NetworkEtalonkaReportState {
  return {
    dialogOpen: false,
    taskRunId: 0,
    taskId: null,
    historyRow: null,
    startedAtMs: null,
    running: false,
    curr: 0,
    overall: 4,
    logs: [],
    reportType: 'AccordingToTheForm',
    activeFreqsOnly: true,
    includeSigintSigns: true,
    includeConfirmation: true,
    includeUnitCallsigns: false,
    includePelengsMap: true,
    fromDateTimeStr: '',
    toDateTimeStr: '',
    downloadFileName: null,
    error: null,
    finishedAt: null,
    progressExpanded: false,
  };
}

function formatDateTimeForFileName(value: string): string | null {
  const millis = combineDateTimeInputToMs(value, APP_TIME_ZONE);
  if (millis === null) return null;
  return dayjs(millis).tz(APP_TIME_ZONE).format('YYYY-MM-DDTHH-mm');
}

function toEtalonkaReportType(report: NetworkEtalonkaReportState): EtalonkaReportType {
  if (report.reportType === 'AccordingToTheForm') {
    return {
      AccordingToTheForm: {
        activeFreqsOnly: report.activeFreqsOnly,
        includeSigintSigns: report.includeSigintSigns,
        includeConfirmation: report.includeConfirmation,
      },
    };
  }

  return {
    ExtendedReport: {
      sinceDateInclusiveMs: combineDateTimeInputToMs(report.fromDateTimeStr, APP_TIME_ZONE) ?? 0,
      tillDateInclusiveMs: combineDateTimeInputToMs(report.toDateTimeStr, APP_TIME_ZONE),
      activeFreqsOnly: report.activeFreqsOnly,
      includeUnitCallsigns: report.includeUnitCallsigns,
      includeSigintSigns: report.includeSigintSigns,
      includeConfirmation: report.includeConfirmation,
      includePelengsMap: report.includePelengsMap,
    },
  };
}

export function buildEtalonkaNetworkBatchReq(networkId: number, report: NetworkEtalonkaReportState): EtalonkaNetworkBatchReq {
  return buildEtalonkaNetworksBatchReq([networkId], report);
}

export function buildEtalonkaNetworksBatchReq(networkIds: number[], report: NetworkEtalonkaReportState): EtalonkaNetworkBatchReq {
  return {
    networkIds,
    sortBy: null,
    etalonkaType: toEtalonkaReportType(report),
  };
}

export function buildEtalonkaNetworksReportReq(req: ListNetworksReq, report: NetworkEtalonkaReportState): EtalonkaJimForksReq {
  return {
    req,
    etalonkaType: toEtalonkaReportType(report),
  };
}

function buildEtalonkaFilename(baseFileName: string, report: NetworkEtalonkaReportState): string {
  if (report.reportType !== 'ExtendedReport') {
    return `${baseFileName}.docx`;
  }

  const dateParts = [report.fromDateTimeStr, report.toDateTimeStr]
    .map((value) => formatDateTimeForFileName(value))
    .filter((value): value is string => value !== null);

  return `${[baseFileName, ...dateParts].join('_')}.docx`;
}

export function buildEtalonkaReportFilename(networkId: number, report: NetworkEtalonkaReportState): string {
  return buildEtalonkaFilename(`etalonka_network_${networkId}`, report);
}

export function buildEtalonkaNetworksReportFilename(report: NetworkEtalonkaReportState): string {
  return buildEtalonkaFilename('etalonka', report);
}
