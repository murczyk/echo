import { describe, expect, it } from 'vitest';

import { buildUnitTree } from '../UnitStatsSidebar';
import type { UnitStatView } from '../../types';

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
  });
});
