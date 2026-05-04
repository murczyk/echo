import type { AnalysisCountItem, AnalysisFilterOptions } from './types';
import type { NewCallsignsRes } from '../../../../Bindings';
import { sortAndTakeTopAnalysisCountItems } from './count-items';
import { isNullOrUndefined, isPresent } from '../../utils/misc';


const FILTER_LABEL_COLLATOR = new Intl.Collator('uk', { sensitivity: 'base', numeric: true });

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Сталася помилка під час завантаження аналізу.';
}

export function topItems<T>(list: T[], getKey: (item: T) => string, getCount: (item: T) => number): AnalysisCountItem[] {
  return sortAndTakeTopAnalysisCountItems(list.map((item) => ({ key: getKey(item), count: getCount(item) })));
}

export function isAnalysisInboxPageExhausted(
  items: Array<unknown> | null | undefined,
  pageLimit: number | null | undefined,
): boolean {
  if (isNullOrUndefined(pageLimit)) return false;
  return (items?.length ?? 0) < pageLimit;
}

export function normalizeFilterLabel(label: string): string {
  const trimmed = label.trim();
  return trimmed === '' ? '<Не вказано>' : trimmed;
}

export function compareFilterLabels(left: string, right: string): number {
  return FILTER_LABEL_COLLATOR.compare(left.trim(), right.trim());
}

export function sortFilterOptionsByLabel<T extends { label: string; value: string }>(
  options: T[],
  priorityLabels: string[] = [],
): T[] {
  const priorities = new Map(priorityLabels.map((label, index) => [label, index]));

  return [...options].sort((left, right) => {
    const leftPriority = priorities.get(left.label.trim());
    const rightPriority = priorities.get(right.label.trim());

    if (isPresent(leftPriority) || isPresent(rightPriority)) {
      const leftIndex = leftPriority ?? Number.POSITIVE_INFINITY;
      const rightIndex = rightPriority ?? Number.POSITIVE_INFINITY;
      if (leftIndex !== rightIndex) {
        return leftIndex - rightIndex;
      }
    }

    const labelDiff = compareFilterLabels(left.label, right.label);
    if (labelDiff !== 0) return labelDiff;
    return compareFilterLabels(left.value, right.value);
  });
}

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
