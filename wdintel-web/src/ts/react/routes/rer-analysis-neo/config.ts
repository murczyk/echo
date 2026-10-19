import type { AnalysisSearchMode } from '../../../../Bindings';

export const ANALYSIS_MESSAGE_RECONCILIATION_INTERVAL_MS = 2_000;
export const ANALYSIS_SYSTEM_COUNT_INTERVAL_MS = 30_000;
export const ANALYSIS_SHOW_UNREAD_DIVIDER = false;

export const ANALYSIS_SEARCH_DOC_URL = '/docs/analysis-search/';

export const ANALYSIS_SEARCH_MODES = [
  { mode: 'Fuzzy', label: 'Гнучкий пошук' },
  { mode: 'Exact', label: 'Точний збіг' },
  { mode: 'Substring', label: 'Збіг за входженням' },
] satisfies Array<{ mode: AnalysisSearchMode; label: string }>;
