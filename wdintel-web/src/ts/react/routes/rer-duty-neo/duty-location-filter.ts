import type { AnalysisStatsLocation, AnalysisStatsReq } from '../../../../Bindings';
import { emptyAnalysisStatsReq } from '../../services/api/inbox-reference-data';
import {
  EMPTY_FILTER_LABEL,
  normalizeFilterLabel,
  sortLocationFilterOptions,
} from '../../utils/filter-option-labels';
import { DUTY_LOCATIONS_LOOKBACK_MS } from './utils';

export function buildDutyLocationsStatsReq(nowMs: number): AnalysisStatsReq {
  return {
    ...emptyAnalysisStatsReq(nowMs - DUTY_LOCATIONS_LOOKBACK_MS, nowMs),
    messageTimeBasis: 'creation',
  };
}

const EMPTY_LOCATION_TOKENS = new Set(
  [EMPTY_FILTER_LABEL, '--Не визначено--'].map((token) => token.toLocaleUpperCase('uk-UA')),
);

/** Free-entry value as stored in `location_v2`: trimmed uppercase; empty-location labels → ''. */
export function normalizeDutyLocationValue(value: string): string {
  const upper = value.trim().toLocaleUpperCase('uk-UA');
  return EMPTY_LOCATION_TOKENS.has(upper) ? '' : upper;
}

export function sortDutyLocations(locations: readonly AnalysisStatsLocation[]): string[] {
  const options = new Map<string, { value: string; label: string }>();
  for (const { location } of locations) {
    const value = normalizeDutyLocationValue(location);
    options.set(value, { value, label: value });
  }
  return sortLocationFilterOptions([...options.values()]).map((option) => option.value);
}

export function dutyLocationLabel(value: string): string {
  return normalizeFilterLabel(value);
}

export function mergeDutyLocationOptions(
  fetched: readonly string[],
  ...current: ReadonlyArray<readonly string[]>
): string[] {
  return [...new Set([...fetched, ...current.flat()])];
}
