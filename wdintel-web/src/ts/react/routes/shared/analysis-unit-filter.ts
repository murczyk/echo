const UNKNOWN_UNIT_FILTER_VALUES = new Set(['', 'Не визначено', 'Не вказано']);

export function normalizeUnknownUnitFilterValue(value: string): string {
  const trimmed = value.trim();
  return UNKNOWN_UNIT_FILTER_VALUES.has(trimmed) ? '' : trimmed;
}

export function normalizeUnknownUnitSelections(values: string[]): string[] {
  const normalized: string[] = [];

  for (const value of values) {
    const nextValue = normalizeUnknownUnitFilterValue(value);
    if (normalized.includes(nextValue)) continue;
    normalized.push(nextValue);
  }

  return normalized;
}

export function normalizeUnknownUnitFilterLabel(value: string): string {
  return normalizeUnknownUnitFilterValue(value) === '' ? '<Не вказано>' : value.trim();
}
