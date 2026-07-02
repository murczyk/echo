import { describe, expect, it } from 'vitest';

import { combineDateTimeInputToMs } from '../../utils/misc';
import {
  buildEtalonkaNetworkBatchReq,
  buildEtalonkaNetworksReportFilename,
  buildEtalonkaReportFilename,
  createDefaultNetworkEtalonkaReportState,
} from './use-rer-network-details-neo-page.etalonka-report';

describe('rer-network-details etalonka report helpers', () => {
  it('builds the standard payload with classic defaults', () => {
    const report = createDefaultNetworkEtalonkaReportState();

    expect(buildEtalonkaNetworkBatchReq(77, report)).toEqual({
      networkIds: [77],
      sortBy: null,
      etalonkaType: {
        AccordingToTheForm: {
          activeFreqsOnly: true,
          includeSigintSigns: true,
          includeConfirmation: true,
          includeHeadingsAndFreqs: false,
        },
      },
    });
    expect(buildEtalonkaReportFilename(77, report)).toBe('etalonka_network_77.docx');
    expect(buildEtalonkaNetworksReportFilename(report)).toBe('etalonka.docx');
  });

  it('builds the extended payload and filename with date suffixes', () => {
    const report = createDefaultNetworkEtalonkaReportState();
    report.reportType = 'ExtendedReport';
    report.activeFreqsOnly = false;
    report.includeSigintSigns = false;
    report.includeConfirmation = true;
    report.includeUnitCallsigns = true;
    report.includePelengsMap = false;
    report.fromDateTimeStr = '2026-01-15T12:34';
    report.toDateTimeStr = '2026-01-16T09:05';

    expect(buildEtalonkaNetworkBatchReq(12, report)).toEqual({
      networkIds: [12],
      sortBy: null,
      etalonkaType: {
        ExtendedReport: {
          sinceDateInclusiveMs: combineDateTimeInputToMs('2026-01-15T12:34') ?? 0,
          tillDateInclusiveMs: combineDateTimeInputToMs('2026-01-16T09:05'),
          activeFreqsOnly: false,
          includeUnitCallsigns: true,
          includeSigintSigns: false,
          includeConfirmation: true,
          includePelengsMap: false,
          includeHeadingsAndFreqs: false,
        },
      },
    });
    expect(buildEtalonkaReportFilename(12, report)).toBe(
      'etalonka_network_12_2026-01-15T12-34_2026-01-16T09-05.docx',
    );
    expect(buildEtalonkaNetworksReportFilename(report)).toBe(
      'etalonka_2026-01-15T12-34_2026-01-16T09-05.docx',
    );
  });
});
