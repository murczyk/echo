import dayjs from 'dayjs';

import type { EtalonkaNetworkBatchReq, EtalonkaReportType } from '../../../../Bindings';
import { APP_TIME_ZONE, combineDateTimeInputToMs } from '../../utils/misc';

export type NetworkEtalonkaReportType = 'AccordingToTheForm' | 'ExtendedReport';

export type NetworkEtalonkaReportState = {
  dialogOpen: boolean;
  downloading: boolean;
  reportType: NetworkEtalonkaReportType;
  activeFreqsOnly: boolean;
  includeSigintSigns: boolean;
  includeConfirmation: boolean;
  includeUnitCallsigns: boolean;
  includePelengsMap: boolean;
  fromDateTimeStr: string;
  toDateTimeStr: string;
  error: string | null;
};

export function createDefaultNetworkEtalonkaReportState(): NetworkEtalonkaReportState {
  return {
    dialogOpen: false,
    downloading: false,
    reportType: 'AccordingToTheForm',
    activeFreqsOnly: true,
    includeSigintSigns: true,
    includeConfirmation: true,
    includeUnitCallsigns: false,
    includePelengsMap: true,
    fromDateTimeStr: '',
    toDateTimeStr: '',
    error: null,
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
  return {
    networkIds: [networkId],
    sortBy: null,
    etalonkaType: toEtalonkaReportType(report),
  };
}

export function buildEtalonkaReportFilename(networkId: number, report: NetworkEtalonkaReportState): string {
  const baseFileName = `etalonka_network_${networkId}`;

  if (report.reportType !== 'ExtendedReport') {
    return `${baseFileName}.docx`;
  }

  const dateParts = [report.fromDateTimeStr, report.toDateTimeStr]
    .map((value) => formatDateTimeForFileName(value))
    .filter((value): value is string => value !== null);

  return `${[baseFileName, ...dateParts].join('_')}.docx`;
}
