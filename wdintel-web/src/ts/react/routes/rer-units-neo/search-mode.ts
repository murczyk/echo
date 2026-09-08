import { normalizeSearchValue } from '../../utils/search-filter';
import type { Unit } from '../../../../Bindings';

export type UnitSearchMode = 'strict' | 'relaxed';

function searchTokens(value: string): string[] {
  return normalizeSearchValue(value).match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function buildUnitSearchText(unit: Unit): string {
  return [
    unit.name,
    unit.other,
    unit.teamOrCrew,
    unit.section,
    unit.squad,
    unit.platoon,
    unit.company,
    unit.battalion,
    unit.regiment,
    unit.brigade,
    unit.division,
    unit.corps,
    unit.army,
    unit.militaryDistrict,
    unit.armyRegion,
    unit.comment,
    unit.orbitNote,
  ]
    .map((value) => value ?? '')
    .join(' ');
}

function matchesByTokens(target: string, query: string): boolean {
  if (query.length === 0) return true;

  const targetTokens = new Set(searchTokens(target));
  return searchTokens(query).every((queryToken) => targetTokens.has(queryToken));
}

export function isUnitSearchMatch(value: string, query: string): boolean {
  const normalizedValue = normalizeSearchValue(value);
  const normalizedQuery = normalizeSearchValue(query);
  if (normalizedQuery === '') return true;

  return matchesByTokens(normalizedValue, normalizedQuery);
}

export function isUnitSearchMatchForUnit(unit: Unit, query: string): boolean {
  return isUnitSearchMatch(buildUnitSearchText(unit), query);
}
