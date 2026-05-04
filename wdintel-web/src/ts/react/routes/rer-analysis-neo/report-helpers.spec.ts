import { describe, expect, it } from 'vitest';

import { emptyQueryState } from './helpers';
import {
  createDefaultReportState,
  describeAppliedReportFilters,
  reportDownloadMeta,
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
    expect(reportTemplateToUiTitle({ ...createDefaultReportState(), template: 'geojson' })).toBe('GeoJSON');
  });
});
