import type {
  InboxMessagesReq,
  ReportPreviewReq,
  ReportType,
  ReoReportFileType,
} from '../../../../Bindings';

export type ReportTemplateId =
  | 'tags'
  | 'pelengs'
  | 'babak'
  | 'interception'
  | 'senders'
  | 'posts_docx'
  | 'mouse'
  | 'reo'
  | 'digest'
  | 'active_networks';

export type SenderAggregation = 'ByProfile' | 'ByPost';

export type AnalysisReportState = {
  activeNetworksAorIds: number[];
  open: boolean;
  reoAdjacentFreqsDistance: number;
  reoFileType: ReoReportFileType;
  reoNoComments: boolean;
  senderAdvancedFreqs: boolean;
  senderAggregation: SenderAggregation;
  template: ReportTemplateId;
  withoutComments: boolean;
  withoutModelTags: boolean;
  reportTagsOnlyThisUnit: boolean;
};

export const REPORT_ADJACENT_FREQS_OPTIONS = [0, 0.0005, 0.002, 0.005] as const;

export function createDefaultReportState(): AnalysisReportState {
  return {
    activeNetworksAorIds: [],
    open: false,
    reoAdjacentFreqsDistance: 0,
    reoFileType: 'Docx',
    reoNoComments: false,
    senderAdvancedFreqs: false,
    senderAggregation: 'ByProfile',
    template: 'tags',
    withoutComments: false,
    withoutModelTags: false,
    reportTagsOnlyThisUnit: false,
  };
}

export function reportTemplateToKind(template: ReportTemplateId, senderAggregation: SenderAggregation): string {
  switch (template) {
    case 'senders':
      return senderAggregation === 'ByPost' ? 'posts' : 'senders';
    case 'posts_docx':
      return 'posts_docx';
    case 'active_networks':
      return 'active_networks';
    default:
      return template;
  }
}

export function reportTemplateToType(state: AnalysisReportState): ReportType | null {
  switch (state.template) {
    case 'tags':
      return 'Tags';
    case 'pelengs':
      return 'Pelengs';
    case 'babak':
      return 'Babak';
    case 'interception':
      return 'Interception';
    case 'mouse':
      return 'Mouse';
    case 'senders':
      return {
        Senders: {
          aggregation: state.senderAggregation,
          advancedFreqs: state.senderAdvancedFreqs,
        },
      };
    case 'posts_docx':
      return null;
    case 'reo':
      return {
        Reo: [
          {
            adjacentFreqsDistance: state.reoAdjacentFreqsDistance,
            noComments: state.reoNoComments,
          },
          state.reoFileType,
        ],
      };
    case 'digest':
      return 'Digest';
    case 'active_networks':
      return { ActiveNetworks: { aorIds: state.activeNetworksAorIds } };
  }
}

export function buildReportRequest(state: AnalysisReportState, req: InboxMessagesReq): ReportPreviewReq {
  return {
    kind: reportTemplateToKind(state.template, state.senderAggregation),
    reportType: reportTemplateToType(state),
    req: {
      ...req,
      nolimit: true,
      withoutModelTags: state.withoutModelTags,
    },
    reportTagsOnlyThisUnit: state.reportTagsOnlyThisUnit,
    withoutComments: state.template === 'babak' ? state.withoutComments : null,
    digestOmitExoId: state.template === 'digest' ? false : null,
    digestForm1217: state.template === 'digest' ? false : null,
  };
}

export function reportDownloadMeta(state: AnalysisReportState): { extension: string; mimeType: string } {
  switch (state.template) {
    case 'pelengs':
    case 'interception':
    case 'senders':
      return { extension: 'xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    case 'reo':
      return state.reoFileType === 'Xlsx'
        ? { extension: 'xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
        : { extension: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    default:
      return { extension: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  }
}

export function buildReportFilename(state: AnalysisReportState, dateFrom: string, timeFrom: string, dateTo: string, timeTo: string) {
  const { extension } = reportDownloadMeta(state);
  return `report_${dateFrom}T${timeFrom}_${dateTo}T${timeTo}.${extension}`;
}
