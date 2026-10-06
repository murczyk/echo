import { isPresent } from './misc';

export const EMPTY_FILTER_LABEL = '<Не вказано>';

const FILTER_LABEL_COLLATOR = new Intl.Collator('uk', { sensitivity: 'base', numeric: true });

export function normalizeFilterLabel(label: string): string {
  const trimmed = label.trim();
  return trimmed === '' ? EMPTY_FILTER_LABEL : trimmed;
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

/** Location options labelled and ordered like Analysis: `<Не вказано>` first, then by label. */
export function sortLocationFilterOptions<T extends { label: string; value: string }>(
  options: T[],
): T[] {
  return sortFilterOptionsByLabel(
    options.map((option) => ({ ...option, label: normalizeFilterLabel(option.label) })),
    [EMPTY_FILTER_LABEL],
  );
}
