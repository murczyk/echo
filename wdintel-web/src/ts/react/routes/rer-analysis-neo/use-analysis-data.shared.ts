import type { AnalysisCountItem, AnalysisFilterOptions } from './types';
import type { NewCallsignsRes } from '../../../../Bindings';
import { sortAndTakeTopAnalysisCountItems } from './count-items';

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Сталася помилка під час завантаження аналізу.';
}

export function topItems<T>(list: T[], getKey: (item: T) => string, getCount: (item: T) => number): AnalysisCountItem[] {
  return sortAndTakeTopAnalysisCountItems(list.map((item) => ({ key: getKey(item), count: getCount(item) })));
}

export const emptyOptions: AnalysisFilterOptions = {
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
