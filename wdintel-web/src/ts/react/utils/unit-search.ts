import type { Unit } from '../../../Bindings';

export function normalizeUnitSearchValue(value: string): string {
  return value.toLocaleLowerCase('uk-UA').replace(/\s+/g, ' ').trim();
}

export function getUnitDisplayLabel(unit: Unit): string {
  return unit.name.trim() || `#${unit.id}`;
}

export function findExactUnitSearchMatch(units: Unit[], inputValue: string): Unit | null {
  const normalizedInput = normalizeUnitSearchValue(inputValue);
  if (normalizedInput === '') return null;

  return units.find((unit) => {
    const unitLabel = normalizeUnitSearchValue(getUnitDisplayLabel(unit));
    return unitLabel === normalizedInput || normalizedInput === String(unit.id) || normalizedInput === `#${unit.id}`;
  }) ?? null;
}

export function filterUnitsBySearch(options: Unit[], inputValue: string): Unit[] {
  const normalizedInput = normalizeUnitSearchValue(inputValue);
  if (normalizedInput === '') return options;

  const searchTokens = normalizedInput.split(' ');
  return options.filter((unit) => {
    const unitName = normalizeUnitSearchValue(unit.name);
    const unitNameTokens = unitName.split(' ');
    const unitId = String(unit.id);
    const unitHashId = `#${unit.id}`;

    return searchTokens.every((token) => {
      if (token === unitId || token === unitHashId) return true;
      if (/\d/.test(token)) return unitNameTokens.includes(token);
      return unitName.includes(token);
    });
  });
}
