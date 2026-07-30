import {
  addAnalysisSelection,
  toggleExclusiveAnalysisSelection,
} from './analysis-filter-selection';

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

export function normalizeUnknownUnitSelections(values: string[]): string[] {
  const normalized: string[] = [];

  for (const value of values) {
    const nextValue = normalizeUnknownUnitFilterValue(value);
    if (normalized.includes(nextValue)) continue;
    normalized.push(nextValue);
  }

  return normalized;
}

export function toggleExclusiveUnitSelection(values: string[], value: string): string[] {
  const normalizedValues = normalizeUnknownUnitSelections(values);
  const normalizedValue = normalizeUnknownUnitFilterValue(value);
  return toggleExclusiveAnalysisSelection(normalizedValues, normalizedValue);
}

export function addUnitSelection(values: string[], value: string): string[] {
  const normalizedValues = normalizeUnknownUnitSelections(values);
  const normalizedValue = normalizeUnknownUnitFilterValue(value);
  return addAnalysisSelection(normalizedValues, normalizedValue);
}

export function normalizeUnknownUnitDisplayValue(value: string | null | undefined): string {
  const normalizedValue = value?.trim() ?? '';
  return isUnknownUnitFilterValue(normalizedValue) ? 'Не визначено' : normalizedValue;
}

export function normalizeUnknownUnitFilterLabel(value: string | null | undefined): string {
  const normalizedValue = value?.trim() ?? '';
  return isUnknownUnitFilterValue(normalizedValue) ? UNKNOWN_UNIT_FILTER_LABEL : normalizedValue;
}
