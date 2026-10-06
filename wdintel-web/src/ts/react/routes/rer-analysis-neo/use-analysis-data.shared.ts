import type { AnalysisCountItem, AnalysisFilterOptions } from './types';
import type { NewCallsignsRes } from '../../../../Bindings';
import { sortAndTakeTopAnalysisCountItems } from './count-items';
import { isNullOrUndefined } from '../../utils/misc';

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Сталася помилка під час завантаження аналізу.';
}

export function topItems<T>(
  list: T[],
  getKey: (item: T) => string,
  getCount: (item: T) => number,
  getValue?: (item: T) => string,
): AnalysisCountItem[] {
  return sortAndTakeTopAnalysisCountItems(
    list.map((item) => ({
      key: getKey(item),
      count: getCount(item),
      value: getValue?.(item),
    })),
  );
}

export function isAnalysisInboxPageExhausted(
  items: Array<unknown> | null | undefined,
  pageLimit: number | null | undefined,
): boolean {
  if (isNullOrUndefined(pageLimit)) return false;
  return (items?.length ?? 0) < pageLimit;
}

export {
  compareFilterLabels,
  normalizeFilterLabel,
  sortFilterOptionsByLabel,
} from '../../utils/filter-option-labels';

export const emptyOptions: AnalysisFilterOptions = {
  tags: [],
  aors: [],
  groups: [],
  senders: [],
  freqs: [],
  newFreqs: [],
  callsigns: [],
  units: [],
  locations: [],
  posts: [],
  networks: [],
  metadataCcs: [],
  metadataSenders: [],
  metadataReceivers: [],
  metadataHashes: [],
};

export const emptyNewCallsigns: NewCallsignsRes = {
  notSeen24h: [],
  notSeen7days: [],
  notSeen30days: [],
};
