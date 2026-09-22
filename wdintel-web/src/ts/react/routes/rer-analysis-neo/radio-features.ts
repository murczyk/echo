import type { AnalysisStatsReq, InboxMessagesReq } from '../../../../Bindings';
import type { AnalysisReportState } from './report-helpers';
import type { AnalysisQueryState } from './types';

export function effectiveRadioQuery(
  query: AnalysisQueryState,
  allowed: boolean,
): AnalysisQueryState {
  return allowed
    ? { ...query, radioFeaturesAllowed: true }
    : {
        ...query,
        radioFeaturesAllowed: false,
        freqsSelected: [],
        postsSelected: [],
        adjacentFreqsRange: 0,
        includeOnlyNewFreqs: false,
        includePelengLocations: false,
        metadataCc: [],
        metadataSender: [],
        metadataReceiver: [],
        metadataHash: [],
        onlyWithMetadata: false,
        withoutMetadata: false,
      };
}

export function effectiveRadioReport(
  report: AnalysisReportState,
  allowed: boolean,
): AnalysisReportState {
  if (allowed) return report;
  return {
    ...report,
    tagReportSortBy: 'ByTime',
    reoAdjacentFreqsDistance: 0,
    senderAdvancedFreqs: false,
    senderAggregation: 'ByProfile',
    template:
      report.template === 'summary_table'
        ? 'kmz'
        : ['pelengs', 'reo', 'mouse', 'report_125', 'posts_docx'].includes(report.template)
          ? 'tags'
          : report.template,
  };
}

export function effectiveRadioRequest<T extends AnalysisStatsReq | InboxMessagesReq>(
  request: T | null,
  allowed: boolean,
): T | null {
  if (allowed || request === null) return request;
  return {
    ...request,
    selectedFreqs: null,
    selectedPosts: null,
    ...('deniedPosts' in request ? { deniedPosts: null } : {}),
    ...('deniedFreqs' in request ? { deniedFreqs: null } : {}),
    includePelengLocations: false,
    metadataCc: null,
    metadataSender: null,
    metadataReceiver: null,
    metadataHash: null,
    onlyWithMetadata: false,
    withoutMetadata: false,
  };
}
