import type { Unit } from '../../../Bindings';
import {
  createRankedFilterOptions,
  findExactSearchMatch,
  normalizeSearchValue,
} from './search-filter';

export const UNIT_FILTER_UNSET_ID = 0;
const UNIT_FILTER_UNSET_NAME = 'Не визначено';
const UNIT_FILTER_ID_PREFIX = 'unit-id:';

export function getUnitDisplayLabel(unit: Unit): string {
  return unit.name.trim() || `#${unit.id}`;
}

export function getUnitFilterValue(unit: Unit): string {
  return unit.id === UNIT_FILTER_UNSET_ID ? UNIT_FILTER_UNSET_NAME : getUnitIdFilterValue(unit.id);
}

export function getUnitIdFilterValue(unitId: number): string {
  return unitId === UNIT_FILTER_UNSET_ID
    ? UNIT_FILTER_UNSET_NAME
    : `${UNIT_FILTER_ID_PREFIX}${unitId}`;
}

export function getCanonicalUnitIdValue(value: string): number | null {
  if (!value.startsWith(UNIT_FILTER_ID_PREFIX)) return null;
  const rawUnitId = value.slice(UNIT_FILTER_ID_PREFIX.length);
  const unitId = Number(rawUnitId);
  return Number.isSafeInteger(unitId) && unitId > 0 && String(unitId) === rawUnitId ? unitId : null;
}

export function isCanonicalUnitIdValue(value: string): boolean {
  return getCanonicalUnitIdValue(value) !== null;
}

function createSyntheticUnsetUnit(): Unit {
  return {
    id: UNIT_FILTER_UNSET_ID,
    name: UNIT_FILTER_UNSET_NAME,
    other: '',
    teamOrCrew: '',
    section: '',
    squad: '',
    platoon: '',
    company: '',
    battalion: '',
    regiment: '',
    brigade: '',
    division: '',
    corps: '',
    army: '',
    militaryDistrict: '',
    armyRegion: '',
    comment: '',
    orbitNote: null,
    presentInOrbit: null,
    active: true,
    isDeduplicateCandidate: null,
    createdAt: 0,
    createdByLoginId: '',
    hasOrbit: false,
    orbitUnitIds: [],
    orbitUnitGenerativeNames: [],
  };
}

export function buildUnitFilterOptions(unitsList: Unit[]): Unit[] {
  return [createSyntheticUnsetUnit(), ...buildSelectableUnitOptions(unitsList)];
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
