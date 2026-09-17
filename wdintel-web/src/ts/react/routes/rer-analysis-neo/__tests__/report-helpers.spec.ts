import { describe, expect, it } from 'vitest';

import type { InboxMessagesReq } from '../../../../../Bindings';
import {
  buildReportRequest,
  createDefaultReportState,
  reportTemplateToKind,
} from '../report-helpers';

describe('report-helpers', () => {
  // @test-scope parser: preserves report kind compatibility at the report request boundary.
  it('maps report 1.2.5 to a docx report request', () => {
    const state = { ...createDefaultReportState(), template: 'report_125' as const };
    const request = buildReportRequest(state, {} as InboxMessagesReq);

    expect(reportTemplateToKind(state.template, state.senderAggregation)).toBe('report_125');
    expect(request.kind).toBe('report_125');
    expect(request.reportType).toBeNull();
  });

  // @test-scope parser: preserves tag report sorting fields on the report request wire boundary.
  it('sends frequency then time sorting only for tag reports', () => {
    const request = buildReportRequest(
      { ...createDefaultReportState(), tagReportSortBy: 'ByFreqThenTime' },
      {} as InboxMessagesReq,
    );
    const nonTagRequest = buildReportRequest(
      { ...createDefaultReportState(), template: 'babak', tagReportSortBy: 'ByFreqThenTime' },
      {} as InboxMessagesReq,
    );

    expect(request.tagReportSortBy).toBe('ByFreqThenTime');
    expect(nonTagRequest.tagReportSortBy).toBeNull();
  });

  // @test-scope parser: preserves Sposob unit-name request compatibility.
  it('sends Sposob unit name only for Sposob reports', () => {
    const request = buildReportRequest(
      { ...createDefaultReportState(), template: 'sposob', sposobUnitName: '  ручний підрозділ  ' },
      {} as InboxMessagesReq,
    );
    const nonSposobRequest = buildReportRequest(
      { ...createDefaultReportState(), template: 'tags', sposobUnitName: 'ручний підрозділ' },
      {} as InboxMessagesReq,
    );

    expect(request.sposobUnitName).toBe('ручний підрозділ');
    expect(nonSposobRequest.sposobUnitName).toBeNull();
  });
});
