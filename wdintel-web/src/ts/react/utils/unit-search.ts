import type { Unit } from '../../../Bindings';
import {
  createRankedFilterOptions,
  findExactSearchMatch,
  normalizeSearchValue,
} from './search-filter';

export function getUnitDisplayLabel(unit: Unit): string {
  return unit.name.trim() || `#${unit.id}`;
}

export function getUnitFilterValue(unit: Unit): string {
  return String(unit.id);
}

export function isCanonicalUnitIdValue(value: string): boolean {
  const unitId = Number(value);
  return Number.isSafeInteger(unitId) && unitId > 0 && String(unitId) === value;
}

export function buildUnitFilterOptions(unitsList: Unit[]): Unit[] {
  return buildSelectableUnitOptions(unitsList);
}

export function buildSelectableUnitOptions(unitsList: Unit[]): Unit[] {
  return unitsList
    .filter((unit) => unit.active && unit.name.trim().length > 0)
    .map((unit) => ({ ...unit, name: unit.name.trim() }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
}

export function buildUnitLookupOptions(
  unitsList: Unit[],
  referencedUnitIds: readonly number[] = [],
): Array<{ id: number; label: string }> {
  const options = buildSelectableUnitOptions(unitsList).map((unit) => ({
    id: unit.id,
    label: getUnitDisplayLabel(unit),
  }));
  const optionIds = new Set(options.map((option) => option.id));
  const unitsById = new Map(unitsList.map((unit) => [unit.id, unit]));

  for (const id of referencedUnitIds) {
    if (optionIds.has(id)) continue;
    const unit = unitsById.get(id);
    options.push({ id, label: unit ? getUnitDisplayLabel(unit) : `#${id}` });
    optionIds.add(id);
  }

  return options;
}

export function unitsFromNames(names: readonly string[], options: readonly Unit[]): Unit[] {
  const optionByValue = new Map(options.map((option) => [getUnitFilterValue(option), option]));

  return names.flatMap((name) => {
    const option = optionByValue.get(name);
    return option ? [option] : [];
  });
}

export function unitNamesFromUnits(units: readonly Unit[]): string[] {
  return units.map(getUnitFilterValue);
}

export function findExactUnitSearchMatch(units: Unit[], inputValue: string): Unit | null {
  return findExactSearchMatch(units, inputValue, getUnitDisplayLabel);
}

export function filterUnitsBySearch(options: Unit[], inputValue: string): Unit[] {
  return createRankedFilterOptions(getUnitDisplayLabel)(options, { inputValue });
}

export { normalizeSearchValue as normalizeUnitSearchValue };
