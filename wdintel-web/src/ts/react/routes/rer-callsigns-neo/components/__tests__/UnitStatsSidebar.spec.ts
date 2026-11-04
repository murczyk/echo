import { describe, expect, it } from 'vitest';

import { buildUnitTree } from '../UnitStatsSidebar';
import type { UnitStatView } from '../../types';
import { readUnitHierarchyTree } from '../../../shared/unit-hierarchy';

const EMPTY_UNIT_HIERARCHY = {
  armyRegion: '',
  militaryDistrict: '',
  army: '',
  corps: '',
  division: '',
  brigade: '',
  regiment: '',
  battalion: '',
  company: '',
  platoon: '',
  squad: '',
  section: '',
  teamOrCrew: '',
  other: '',
} as const;
describe('UnitStatsSidebar hierarchy', () => {
  it('separates same-named armies by their full regional path', () => {
    const stats: UnitStatView[] = [
      {
        ...EMPTY_UNIT_HIERARCHY,
        unitId: 1,
        count: 2,
        unitName: 'A D1 R1',
        armyRegion: 'R1',
        militaryDistrict: 'D1',
        army: 'A',
      },
      {
        ...EMPTY_UNIT_HIERARCHY,
        unitId: 2,
        count: 3,
        unitName: 'A D1 R2',
        armyRegion: 'R2',
        militaryDistrict: 'D1',
        army: 'A',
      },
    ];

    expect(buildUnitTree(stats).map((node) => node.label)).toEqual(['R1', 'R2']);
    const tree = readUnitHierarchyTree({
      revision: '3527',
      groups: [
        { id: 'group:0:R1', label: 'R1', level: 0, parentIndex: null },
        { id: 'group:0:R1|1:D1', label: 'D1', level: 1, parentIndex: 0 },
        { id: 'group:0:R1|1:D1|2:A', label: 'A', level: 2, parentIndex: 1 },
        { id: 'group:0:R2', label: 'R2', level: 0, parentIndex: null },
        { id: 'group:0:R2|1:D1', label: 'D1', level: 1, parentIndex: 3 },
        { id: 'group:0:R2|1:D1|2:A', label: 'A', level: 2, parentIndex: 4 },
      ],
      units: stats.map((row, index) => ({
        id: row.unitId,
        name: row.unitName,
        groupIndex: index * 3 + 2,
      })),
    });
    expect(buildUnitTree(stats, tree)).toEqual(buildUnitTree(stats));
    expect(buildUnitTree(stats.slice(1), tree).map((node) => node.label)).toEqual(['R2']);
  });
});
