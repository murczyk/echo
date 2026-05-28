import type { Callsign, CallsignUnitStatRow, Source, Unit } from '../../../../Bindings';
import { isNullOrUndefined } from '../../utils/misc';
import { normalizeDuplicateLookupValue } from './helpers-core';
import type { BuildRowsResult, CallsignRowView, UnitStatView } from './types';

function compareStrings(left: string, right: string) {
  return left.localeCompare(right, 'uk', { sensitivity: 'base' });
}

function normalizeRadioFreq(value: string | null | undefined) {
  const normalized = value?.trim() ?? '';
  return normalized === '' ? '—' : normalized;
}

function sanitizeCallsignAdditionalSourceIds(callsignAdditionalSourceIds: number[], primarySourceId: number | null | undefined): number[] {
  const uniqueIds = Array.from(new Set(callsignAdditionalSourceIds.filter((item) => Number.isInteger(item) && item > 0))).sort(
    (left, right) => left - right,
  );
  if (isNullOrUndefined(primarySourceId)) return uniqueIds;
  return uniqueIds.filter((sourceId) => sourceId !== primarySourceId);
}

function compareUnitNames(left: Callsign, right: Callsign, unitsById: Map<number, Unit>) {
  const leftUnit = unitsById.get(left.unitId);
  const rightUnit = unitsById.get(right.unitId);
  const unitParts = ['army', 'division', 'regiment', 'battalion', 'company'] as const;

  for (const part of unitParts) {
    const leftValue = String(leftUnit?.[part] ?? '');
    const rightValue = String(rightUnit?.[part] ?? '');
    const result = compareStrings(leftValue, rightValue);
    if (result !== 0) return result;
  }

  return compareStrings(left.callsign, right.callsign);
}

export function mergeUnitStatsWithUnits(unitStats: CallsignUnitStatRow[], unitsById: Map<number, Unit>): UnitStatView[] {
  return unitStats
    .map((stat) => {
      const unit = unitsById.get(stat.unitId);
      if (!unit) {
        return null;
      }

      return {
        ...stat,
        unitName: unit.name,
        army: unit.army,
        division: unit.division,
        regiment: unit.regiment,
        battalion: unit.battalion,
      };
    })
    .filter((row): row is UnitStatView => row !== null)
    .sort((a, b) => b.count - a.count || a.unitName.localeCompare(b.unitName, 'uk'));
}

export function buildRowViews(callsigns: Callsign[], unitsById: Map<number, Unit>, sourcesById: Map<number, Source>): BuildRowsResult {
  const rows: CallsignRowView[] = callsigns.map((callsign) => {
    const callsignAdditionalSourceIds = sanitizeCallsignAdditionalSourceIds(callsign.callsignAdditionalSources, callsign.sourceId);
    const callsignAdditionalSourceNames = callsignAdditionalSourceIds
      .map((sourceId) => sourcesById.get(sourceId)?.name ?? `#${sourceId}`);

    return {
      ...callsign,
      callsignAdditionalSourceIds,
      callsignAdditionalSourceNames,
      unitName: unitsById.get(callsign.unitId)?.name ?? `#${callsign.unitId}`,
      sourceName: isNullOrUndefined(callsign.sourceId) ? '—' : (sourcesById.get(callsign.sourceId)?.name ?? `#${callsign.sourceId}`),
    };
  });

  return {
    rows,
    unitStats: [],
  };
}

export function createUnitsById(units: Unit[]): Map<number, Unit> {
  return new Map(units.map((unit) => [unit.id, unit]));
}

export function createSourcesById(sources: Source[]): Map<number, Source> {
  return new Map(sources.map((source) => [source.id, source]));
}

export function sortRowsClientSide(
  callsigns: Callsign[],
  sort: { column: 'callsign' | 'position' | 'fullName' | 'comment' | 'unit' | 'sourceName' | 'radioFreq' | 'createdAt'; direction: 'asc' | 'desc' },
  unitsById: Map<number, Unit>,
  sourcesById: Map<number, Source>,
): Callsign[] {
  const sorted = [...callsigns];
  sorted.sort((left, right) => {
    let result = 0;

    if (sort.column === 'callsign') {
      result = compareStrings(left.callsign, right.callsign);
    } else if (sort.column === 'position') {
      result = compareStrings(left.position, right.position);
    } else if (sort.column === 'fullName') {
      result = compareStrings(left.fullName, right.fullName);
    } else if (sort.column === 'comment') {
      result = compareStrings(left.comment, right.comment);
    } else if (sort.column === 'sourceName') {
      result = compareStrings(
        isNullOrUndefined(left.sourceId) ? '—' : (sourcesById.get(left.sourceId)?.name ?? `#${left.sourceId}`),
        isNullOrUndefined(right.sourceId) ? '—' : (sourcesById.get(right.sourceId)?.name ?? `#${right.sourceId}`),
      );
    } else if (sort.column === 'radioFreq') {
      result = compareStrings(normalizeRadioFreq(left.radioFreq), normalizeRadioFreq(right.radioFreq));
    } else if (sort.column === 'createdAt') {
      result = left.createdAt - right.createdAt;
    } else {
      result = compareUnitNames(left, right, unitsById);
    }

    if (result === 0) {
      result = left.id - right.id;
    }

    return sort.direction === 'asc' ? result : -result;
  });
  return sorted;
}
