import type { Unit } from '../../../Bindings';
import type { SearchableOptionSelection } from '../components/searchable-option.types';
import { createRankedFilterOptions, findExactSearchMatch, normalizeSearchValue } from './search-filter';

export const UNIT_FILTER_UNSET_ID = 0;
const UNIT_FILTER_UNSET_NAME = 'Не визначено';

export function getUnitDisplayLabel(unit: Unit): string {
  return unit.name.trim() || `#${unit.id}`;
}

export function getUnitFilterValue(unit: Unit): string {
  if (unit.id === UNIT_FILTER_UNSET_ID) {
    return UNIT_FILTER_UNSET_NAME;
  }
  return unit.name.trim();
}

function createSyntheticUnsetUnit(): Unit {
  return {
    id: UNIT_FILTER_UNSET_ID,
    name: UNIT_FILTER_UNSET_NAME,
    company: '',
    battalion: '',
    regiment: '',
    division: '',
    army: '',
    comment: '',
    active: true,
    createdAt: 0,
    createdBy: '',
  };
}

export function buildUnitFilterOptions(unitsList: Unit[]): Unit[] {
  const byName = new Map<string, Unit>();

  for (const unit of unitsList) {
    const name = unit.name.trim();
    if (name.length === 0) continue;

    const existing = byName.get(name);
    if (!existing || unit.id < existing.id) {
      byName.set(name, { ...unit, name });
    }
  }

  const sorted = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  return [createSyntheticUnsetUnit(), ...sorted];
}

export function unitSelectionsFromNames(
  names: readonly string[],
  options: readonly Unit[],
): SearchableOptionSelection[] {
  const optionByValue = new Map(options.map((option) => [getUnitFilterValue(option), option]));

  return names.flatMap((name) => {
    const option = optionByValue.get(name);
    return option ? [{ id: option.id, value: getUnitFilterValue(option) }] : [];
  });
}

export function unitNamesFromSelections(
  selections: readonly SearchableOptionSelection[],
): string[] {
  return selections.map((selection) => selection.value);
}

export function findExactUnitSearchMatch(units: Unit[], inputValue: string): Unit | null {
  return findExactSearchMatch(units, inputValue, getUnitDisplayLabel);
}

export function filterUnitsBySearch(options: Unit[], inputValue: string): Unit[] {
  return createRankedFilterOptions(getUnitDisplayLabel)(options, { inputValue });
}

export { normalizeSearchValue as normalizeUnitSearchValue };
