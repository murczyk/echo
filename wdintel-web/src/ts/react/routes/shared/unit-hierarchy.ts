import type { Unit } from '../../../../Bindings';
import type { UnitHierarchyFilter } from '../rer-callsigns-neo/types';

export const HIERARCHY_KEYS = [
  'armyRegion',
  'militaryDistrict',
  'army',
  'corps',
  'division',
  'brigade',
  'regiment',
  'battalion',
  'company',
  'platoon',
  'squad',
  'section',
  'teamOrCrew',
  'other',
] as const;

export type UnitHierarchyStat = Pick<Unit, (typeof HIERARCHY_KEYS)[number]> & {
  unitId: number;
  unitName: string;
  count: number;
};

export type TreeLeafNode = {
  kind: 'leaf';
  id: string;
  unitId: number;
  label: string;
  unitName: string;
  count: number;
};

type TreeGroupNode = {
  kind: 'group';
  id: string;
  label: string;
  count: number;
  hierarchy: UnitHierarchyFilter;
  children: TreeNode[];
};

export type TreeNode = TreeGroupNode | TreeLeafNode;

export function buildUnitHierarchyTree(stats: UnitHierarchyStat[]): TreeNode[] {
  const root: TreeNode[] = [];
  const groups = new Map<string, TreeGroupNode>();

  for (const row of stats) {
    const rawParts = [
      row.armyRegion,
      row.militaryDistrict,
      row.army,
      row.corps,
      row.division,
      row.brigade,
      row.regiment,
      row.battalion,
      row.company,
      row.platoon,
      row.squad,
      row.section,
      row.teamOrCrew,
      row.other,
    ];
    const firstVisibleLevel =
      row.armyRegion.trim() !== '' ? 0 : row.militaryDistrict.trim() !== '' ? 1 : 2;
    let parentChildren = root;
    let path: string[] = [];
    let rawPath: string[] = [];

    rawParts.forEach((part, level) => {
      if (level < firstVisibleLevel) return;
      const hasAnyDeeperPart = rawParts.slice(level).some((item) => item.trim() !== '');
      if (!hasAnyDeeperPart) return;

      const rawValue = part.trim();
      path = [...path, `${level}:${rawValue === '' ? '__EMPTY__' : rawValue}`];
      rawPath = [...rawPath];
      rawPath[level] = rawValue;
      if (rawValue === '') return;

      const id = `group:${path.join('|')}`;

      let group = groups.get(id);
      if (!group) {
        group = {
          kind: 'group',
          id,
          label: rawValue,
          count: 0,
          hierarchy: createHierarchyFilter(rawPath),
          children: [],
        };
        groups.set(id, group);
        parentChildren.push(group);
      }

      group.count += row.count;
      parentChildren = group.children;
    });

    parentChildren.push({
      kind: 'leaf',
      id: `unit:${row.unitId}`,
      unitId: row.unitId,
      label: row.unitName,
      unitName: row.unitName,
      count: row.count,
    });
  }

  return root;
}

function createHierarchyFilter(rawPath: string[]): UnitHierarchyFilter {
  return {
    armyRegion: rawPath[0] ?? null,
    militaryDistrict: rawPath[1] ?? null,
    army: rawPath[2] ?? null,
    corps: rawPath[3] ?? null,
    division: rawPath[4] ?? null,
    brigade: rawPath[5] ?? null,
    regiment: rawPath[6] ?? null,
    battalion: rawPath[7] ?? null,
    company: rawPath[8] ?? null,
    platoon: rawPath[9] ?? null,
    squad: rawPath[10] ?? null,
    section: rawPath[11] ?? null,
    teamOrCrew: rawPath[12] ?? null,
    other: rawPath[13] ?? null,
  };
}
