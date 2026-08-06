import { normalizeSearchValue } from '../../utils/search-filter';
import type { Unit } from '../../../../Bindings';

export type UnitSearchMode = 'strict' | 'relaxed';

function isNumericToken(token: string): boolean {
  return /^\d+$/.test(token);
}

export function buildUnitSearchText(unit: Unit): string {
  return [
    unit.name,
    unit.company,
    unit.battalion,
    unit.regiment,
    unit.division,
    unit.army,
    unit.comment,
    unit.orbitNote,
  ]
    .map((value) => value ?? '')
    .join(' ');
}

function matchesByTokens(target: string, query: string): boolean {
  if (query.length === 0) return true;

  const targetTokens = normalizeSearchValue(target).split(' ');
  const queryTokens = normalizeSearchValue(query).split(' ');

  let nextIndex = 0;

  for (const queryToken of queryTokens) {
    let matchedIndex = -1;

    for (let index = nextIndex; index < targetTokens.length; index += 1) {
      const targetToken = targetTokens[index];
      const tokenMatches = isNumericToken(queryToken)
        ? targetToken === queryToken
        : targetToken.includes(queryToken);

      if (tokenMatches) {
        matchedIndex = index;
        break;
      }
    }

    if (matchedIndex === -1) {
      return false;
    }

    nextIndex = matchedIndex + 1;
  }

  return true;
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
