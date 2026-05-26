export const UNKNOWN_UNIT_FILTER_LABEL = '<Не вказано>';
export const UNKNOWN_UNIT_FILTER_VALUE = '';

const UNKNOWN_UNIT_FILTER_ALIASES = new Set(['', 'Не визначено']);

export function isUnknownUnitFilterValue(value: string | null | undefined): boolean {
  if (value == null) return true;
  return UNKNOWN_UNIT_FILTER_ALIASES.has(value.trim());
}

export function normalizeUnknownUnitFilterValue(value: string | null | undefined): string {
  const normalizedValue = value?.trim() ?? '';
  return isUnknownUnitFilterValue(normalizedValue) ? UNKNOWN_UNIT_FILTER_VALUE : normalizedValue;
}

export function normalizeUnknownUnitDisplayValue(value: string | null | undefined): string {
  const normalizedValue = value?.trim() ?? '';
  return isUnknownUnitFilterValue(normalizedValue) ? 'Не визначено' : normalizedValue;
}

export function normalizeUnknownUnitFilterLabel(value: string | null | undefined): string {
  const normalizedValue = value?.trim() ?? '';
  return isUnknownUnitFilterValue(normalizedValue) ? UNKNOWN_UNIT_FILTER_LABEL : normalizedValue;
}
