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
  const level = [4, 5].find((index) => path[index]);
  return JSON.stringify(level === undefined ? [] : path.slice(0, level + 1));
}
