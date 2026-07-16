import { describe, expect, it } from 'vitest';

import type { InboxMessagesReq } from '../../../../Bindings';
import { emptyQueryState } from './helpers';
import {
  buildReportRequest,
  createDefaultReportState,
  describeAppliedReportFilters,
  reportDownloadMeta,
  reportTemplateToKind,
  reportTemplateToUiTitle,
} from './report-helpers';

describe('report-helpers', () => {
  it('describes page filters and report-specific overrides', () => {
    const queryState = {
      ...emptyQueryState(),
      fromDateTimeStr: '2026-03-30T08:00',
      toDateTimeStr: '2026-03-31T08:00',
      groupsSelected: ['Alpha'],
    };
    const report = {
      ...createDefaultReportState(),
      template: 'active_networks' as const,
      activeNetworksAorIds: [11],
      reportTagsOnlyThisUnit: true,
      withoutModelTags: true,
    };

    expect(describeAppliedReportFilters(queryState, report)).toEqual({
      globalHint: 'Застосуються поточні фільтри сторінки аналізу.',
      inPlaceHints: [
        'Використовуються AOR, обрані в конструкторі.',
        'Лише для цього звіту: не змінює фільтри сторінки.',
      ],
    });
  });

  it('uses direct export metadata for kmz and geojson', () => {
    expect(reportDownloadMeta({ ...createDefaultReportState(), template: 'kmz' })).toEqual({
      extension: 'kmz',
      mimeType: 'application/vnd.google-earth.kmz',
    });
    expect(reportDownloadMeta({ ...createDefaultReportState(), template: 'geojson' })).toEqual({
      extension: 'geojson',
      mimeType: 'application/geo+json',
    });
  });

  it('renders direct export titles', () => {
    expect(reportTemplateToUiTitle({ ...createDefaultReportState(), template: 'kmz' })).toBe('KMZ');
    expect(reportTemplateToUiTitle({ ...createDefaultReportState(), template: 'geojson' })).toBe(
      'GeoJSON',
    );
  });

  it('maps report 1.2.5 to a docx report request', () => {
    const state = { ...createDefaultReportState(), template: 'report_125' as const };
    const request = buildReportRequest(state, {} as InboxMessagesReq);

    expect(reportTemplateToKind(state.template, state.senderAggregation)).toBe('report_125');
    expect(request.kind).toBe('report_125');
    expect(request.reportType).toBeNull();
    expect(reportDownloadMeta(state)).toEqual({
      extension: 'docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect(reportTemplateToUiTitle(state)).toBe('звіт 1.2.5');
  });

  it('sends time sorting by default for tag reports', () => {
    const request = buildReportRequest(createDefaultReportState(), {} as InboxMessagesReq);

    expect(request.tagReportSortBy).toBe('ByTime');
  });

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
