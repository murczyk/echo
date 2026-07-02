import type { AnalysisCountItem } from './types';

export function sortAndTakeTopAnalysisCountItems(items: AnalysisCountItem[]): AnalysisCountItem[] {
  const summaryItems = items.filter((item) => item.key.trim().length === 0);
  const detailItems = items.filter((item) => item.key.trim().length > 0);

  return [
    ...summaryItems,
    ...detailItems.sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }

      return left.key.localeCompare(right.key, 'uk');
    }),
  ];
}
