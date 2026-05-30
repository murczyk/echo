import type { Unit } from '../../../Bindings';
import { createRankedFilterOptions, findExactSearchMatch, normalizeSearchValue } from './search-filter';

export function getUnitDisplayLabel(unit: Unit): string {
  return unit.name.trim() || `#${unit.id}`;
}

export function findExactUnitSearchMatch(units: Unit[], inputValue: string): Unit | null {
  return findExactSearchMatch(units, inputValue, getUnitDisplayLabel);
}

export function filterUnitsBySearch(options: Unit[], inputValue: string): Unit[] {
  return createRankedFilterOptions(getUnitDisplayLabel)(options, { inputValue });
}

export { normalizeSearchValue as normalizeUnitSearchValue };
