import type {
  InboxMessagesReq,
  ReportPreviewReq,
  ReportType,
  ReoReportFileType,
  TagReportSortBy,
} from '../../../../Bindings';
import { hasMeaningfulFiltersBeyondDateRange } from './helpers';
import type { AnalysisQueryState } from './types';

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
  | 'rer_report'
  | 'sposob'
  | 'active_networks'
  | 'report_125'
  | 'summary_table'
  | 'kmz'
  | 'geojson';

export type ReportBuilderMode = 'reports' | 'exports';

export type SenderAggregation = 'ByProfile' | 'ByPost';

export type AnalysisReportState = {
  activeNetworksAorIds: number[];
  interceptionKeepFullMessage: boolean;
  interceptionKeepOldColors: boolean;
  open: boolean;
  reoAdjacentFreqsDistance: number;
  reoFileType: ReoReportFileType;
  reoNoComments: boolean;
  senderAdvancedFreqs: boolean;
  senderAggregation: SenderAggregation;
  sposobUnitName: string;
  tagReportSortBy: TagReportSortBy;
  template: ReportTemplateId;
  withoutComments: boolean;
  withoutModelTags: boolean;
  reportTagsOnlyThisUnit: boolean;
};

export type AppliedReportFilters = {
  globalHint: string;
  inPlaceHints: string[];
};

export const REPORT_ADJACENT_FREQS_OPTIONS = [0, 0.0005, 0.002, 0.005] as const;

export function isExportReportTemplate(template: ReportTemplateId): boolean {
  return template === 'summary_table' || template === 'kmz' || template === 'geojson';
}

export function reportTemplateToMode(template: ReportTemplateId): ReportBuilderMode {
  return isExportReportTemplate(template) ? 'exports' : 'reports';
}

export function createDefaultReportState(): AnalysisReportState {
  return {
    activeNetworksAorIds: [],
    interceptionKeepFullMessage: false,
    interceptionKeepOldColors: false,
    open: false,
    reoAdjacentFreqsDistance: 0,
    reoFileType: 'Docx',
    reoNoComments: false,
    senderAdvancedFreqs: false,
    senderAggregation: 'ByProfile',
    sposobUnitName: '',
    tagReportSortBy: 'ByTime',
    template: 'tags',
    withoutComments: false,
    withoutModelTags: false,
    reportTagsOnlyThisUnit: false,
  };
}

export function reportTemplateToKind(
  template: ReportTemplateId,
  senderAggregation: SenderAggregation,
): string {
  switch (template) {
    case 'senders':
      return senderAggregation === 'ByPost' ? 'posts' : 'senders';
    case 'posts_docx':
      return 'posts_docx';
    case 'active_networks':
      return 'active_networks';
    case 'report_125':
      return 'report_125';
    case 'summary_table':
      return 'summary_table';
    case 'kmz':
      return 'kmz';
    case 'geojson':
      return 'geojson';
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
    case 'rer_report':
      return 'Rer';
    case 'sposob':
      return null;
    case 'active_networks':
      return { ActiveNetworks: { aorIds: state.activeNetworksAorIds } };
    case 'report_125':
      return null;
    case 'summary_table':
      return null;
    case 'kmz':
    case 'geojson':
      return null;
  }
}

export function buildReportRequest(
  state: AnalysisReportState,
  req: InboxMessagesReq,
): ReportPreviewReq {
  return {
    kind: reportTemplateToKind(state.template, state.senderAggregation),
    reportType: reportTemplateToType(state),
    req: {
      ...req,
      nolimit: true,
      withoutModelTags: state.withoutModelTags,
    },
    reportTagsOnlyThisUnit: state.reportTagsOnlyThisUnit,
    tagReportSortBy: state.template === 'tags' ? state.tagReportSortBy : null,
    report1213LinkedNetworksOnly: null,
    withoutComments: state.template === 'babak' ? state.withoutComments : null,
    interceptionKeepFullMessage:
      state.template === 'interception' ? state.interceptionKeepFullMessage : null,
    interceptionKeepOldColors:
      state.template === 'interception' ? state.interceptionKeepOldColors : null,
    digestOmitExoId: state.template === 'digest' ? false : null,
    digestForm1217: state.template === 'digest' ? false : null,
    sposobUnitName: state.template === 'sposob' ? state.sposobUnitName.trim() : null,
  } as ReportPreviewReq;
}

export function reportDownloadMeta(state: AnalysisReportState): {
  extension: string;
  mimeType: string;
} {
  switch (state.template) {
    case 'pelengs':
    case 'interception':
    case 'senders':
      return {
        extension: 'xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      };
    case 'reo':
      return state.reoFileType === 'Xlsx'
        ? {
            extension: 'xlsx',
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          }
        : {
            extension: 'docx',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          };
    case 'summary_table':
      return {
        extension: 'xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      };
    case 'kmz':
      return { extension: 'kmz', mimeType: 'application/vnd.google-earth.kmz' };
    case 'geojson':
      return { extension: 'geojson', mimeType: 'application/geo+json' };
    default:
      return {
        extension: 'docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      };
  }
}

export function buildReportFilename(
  state: AnalysisReportState,
  fromDateTimeStr: string,
  toDateTimeStr: string,
) {
  const { extension } = reportDownloadMeta(state);
  return `report_${fromDateTimeStr}_${toDateTimeStr}.${extension}`;
}

export function reportTemplateToUiTitle(state: AnalysisReportState): string {
  switch (state.template) {
    case 'tags':
      return 'донесення';
    case 'pelengs':
      return 'пеленги';
    case 'babak':
      return 'бабак';
    case 'interception':
      return 'перехоплення';
    case 'senders':
      return state.senderAggregation === 'ByPost' ? 'пости' : 'відправники';
    case 'posts_docx':
      return 'пости';
    case 'mouse':
      return 'мишка';
    case 'reo':
      return 'РЕО';
    case 'digest':
      return 'дайджест';
    case 'active_networks':
      return 'активні радіомережі';
    case 'report_125':
      return 'звіт 1.2.5';
    case 'rer_report':
      return 'РЕР звіт';
    case 'sposob':
      return 'способ';
    case 'summary_table':
      return 'підсумкова таблиця';
    case 'kmz':
      return 'KMZ';
    case 'geojson':
      return 'GeoJSON';
  }
}

export function describeAppliedReportFilters(
  queryState: AnalysisQueryState,
  report: AnalysisReportState,
): AppliedReportFilters {
  const hasPageFilters = hasMeaningfulFiltersBeyondDateRange(queryState);
  const hasReportOverrides =
    report.reportTagsOnlyThisUnit ||
    (report.template === 'tags' && report.tagReportSortBy !== 'ByTime') ||
    (report.template === 'babak' && report.withoutComments) ||
    ((report.template === 'babak' || report.template === 'interception') &&
      report.withoutModelTags) ||
    (report.template === 'active_networks' && report.activeNetworksAorIds.length > 0);

  let globalHint = 'Звіт буде сформовано за вибраний період без додаткових фільтрів.';
  if (report.template === 'summary_table') {
    globalHint = hasPageFilters
      ? 'Підсумкова таблиця використовує поточні фільтри сторінки аналізу.'
      : 'Підсумкова таблиця буде сформована за вибраний період без додаткових фільтрів.';
  } else if (report.template === 'kmz' || report.template === 'geojson') {
    globalHint = hasPageFilters
      ? 'Експорт використовує поточні фільтри сторінки аналізу.'
      : 'Експорт буде сформовано за вибраний період без додаткових фільтрів.';
  } else if (hasPageFilters) {
    globalHint = 'Застосуються поточні фільтри сторінки аналізу.';
  } else if (hasReportOverrides) {
    globalHint = 'Застосуються налаштування цього звіту.';
  }

  const inPlaceHints: string[] = [];
  if (report.template === 'active_networks' && report.activeNetworksAorIds.length > 0) {
    inPlaceHints.push('Використовуються AOR, обрані в конструкторі.');
  }
  if (report.reportTagsOnlyThisUnit) {
    inPlaceHints.push('Лише для цього звіту: не змінює фільтри сторінки.');
  }
  if (report.template === 'tags' && report.tagReportSortBy === 'ByFreqThenTime') {
    inPlaceHints.push('Сортування: за частотою та часом.');
  }
  if (report.template === 'babak' && report.withoutComments) {
    inPlaceHints.push('Коментарі не включаються у звіт.');
  }
  if (
    (report.template === 'babak' || report.template === 'interception') &&
    report.withoutModelTags
  ) {
    inPlaceHints.push('Без автоматичних тегів для цього шаблону.');
  }

  return { globalHint, inPlaceHints };
}
