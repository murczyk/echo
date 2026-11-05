import type { Unit } from '../../../../Bindings';

export function reportParentContext(unit: Partial<Unit> & { id: number }): string {
  const path = [
    unit.armyRegion,
    unit.militaryDistrict,
    unit.army,
    unit.corps,
    unit.division,
    unit.brigade,
    unit.regiment,
    unit.battalion,
    unit.company,
    unit.platoon,
    unit.squad,
    unit.section,
    unit.teamOrCrew,
    unit.other,
  ].map((value) => value?.trim() ?? '');
  const level = [2, 4, 6, 7, 8].find((index) => path[index]) ?? path.findIndex(Boolean);
  return JSON.stringify(level < 0 ? [] : path.slice(0, level + 1));
}
