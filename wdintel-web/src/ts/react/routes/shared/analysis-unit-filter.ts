import {
  addAnalysisSelection,
  toggleExclusiveAnalysisSelection,
} from './analysis-filter-selection';
import type { Unit } from '../../../../Bindings';

export const UNKNOWN_UNIT_FILTER_LABEL = '<Не вказано>';
export const UNKNOWN_UNIT_FILTER_VALUE = '';

const UNKNOWN_UNIT_FILTER_ALIASES = new Set(['', 'Не визначено']);
const ARMY_SUFFIX_RANK = new Map([
  ['А', 0],
  ['ЗА', 1],
  ['ЗВА', 2],
]);

type AnalysisUnitFilterOption = {
  value: string;
  label: string;
  count: number;
  values?: string[];
};

function numericArmySuffix(value: string): { prefix: string; suffix: string } | null {
  const match = /^(.*\s)?(\d+)\s+(А|ЗА|ЗВА)$/iu.exec(value.trim());
  if (match == null) return null;
  return {
    prefix: `${match[1] ?? ''}${match[2]}`.trim(),
    suffix: match[3].toLocaleUpperCase('uk-UA'),
  };
}

function unitAliasKey(value: string): string {
  if (isUnknownUnitFilterValue(value)) return UNKNOWN_UNIT_FILTER_VALUE;
  const armySuffix = numericArmySuffix(value);
  if (armySuffix != null) {
    return `${armySuffix.prefix.toLocaleLowerCase('uk-UA')} а`;
  }
  return value.trim().toLocaleLowerCase('uk-UA');
}

function canonicalUnitNameRank(name: string): number {
  const suffix = numericArmySuffix(name)?.suffix;
  return suffix == null ? 0 : (ARMY_SUFFIX_RANK.get(suffix) ?? Number.MAX_SAFE_INTEGER);
}

function preferCanonicalUnitName(
  current: { id: number; name: string } | undefined,
  candidate: { id: number; name: string },
): boolean {
  if (current == null) return true;
  const rankDifference =
    canonicalUnitNameRank(candidate.name) - canonicalUnitNameRank(current.name);
  if (rankDifference !== 0) return rankDifference < 0;
  return candidate.id < current.id;
}

export function groupEquivalentAnalysisUnitOptions(
  options: AnalysisUnitFilterOption[],
  catalogUnits: Array<Pick<Unit, 'id' | 'name'>>,
): AnalysisUnitFilterOption[] {
  const catalogByAlias = new Map<string, { id: number; name: string }>();
  catalogUnits.forEach((unit) => {
    const name = unit.name.trim();
    if (name.length === 0) return;
    const key = unitAliasKey(name);
    const candidate = { id: unit.id, name };
    if (preferCanonicalUnitName(catalogByAlias.get(key), candidate)) {
      catalogByAlias.set(key, candidate);
    }
  });

  const grouped = new Map<
    string,
    AnalysisUnitFilterOption & { values: string[]; fallbackId: number }
  >();
  options.forEach((option, index) => {
    const key = unitAliasKey(option.value);
    const rawValues = option.values ?? [option.value];
    const canonicalName = catalogByAlias.get(key)?.name;
    const existing = grouped.get(key);
    if (existing != null) {
      existing.count += option.count;
      existing.values = Array.from(new Set([...existing.values, ...rawValues]));
      if (
        canonicalName == null &&
        preferCanonicalUnitName(
          { id: existing.fallbackId, name: existing.label },
          { id: index, name: option.label },
        )
      ) {
        existing.value = option.value;
        existing.label = option.label;
        existing.fallbackId = index;
      }
      return;
    }
    grouped.set(key, {
      value: canonicalName ?? option.value,
      label: canonicalName ?? option.label,
      count: option.count,
      values: Array.from(new Set(rawValues)),
      fallbackId: index,
    });
  });

  return Array.from(grouped.values()).map(({ fallbackId: _fallbackId, ...option }) => {
    if (
      option.values.length === 1 &&
      option.values[0] === option.value &&
      option.label === option.value
    ) {
      const { values: _values, ...singleOption } = option;
      return singleOption;
    }
    return option;
  });
}

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
