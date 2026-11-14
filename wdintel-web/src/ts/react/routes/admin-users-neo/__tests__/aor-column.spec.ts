import { describe, expect, it } from 'vitest';

import type { AreaOfResponsibility, Login, Organism } from '../../../../../Bindings';
import { buildAorColumnLookup, organismAorLabels } from '../aor-column';

function aor(id: number, name: string): AreaOfResponsibility {
  return {
    id,
    name,
    description: null,
    isTopLevel: true,
    orderForReport: id,
    leftBound: 0,
    rightBound: 1,
    leftCoordinates: null,
    rightCoordinates: null,
    createdAt: 0,
  };
}

function organism(id: number, aorIds: number[]): Organism {
  return {
    id,
    parentId: null,
    name: `Організм ${id}`,
    createdAt: 0,
    roles: [],
    enabled: true,
    aorIds,
    loginsCount: 0,
  };
}

function login(organismId: number | null): Login {
  return { organismId } as Login;
}

const AORS = [aor(1, 'Північ'), aor(2, 'Схід'), aor(3, 'Північ')];
const ORGANISMS = [organism(10, [2, 1]), organism(11, [99]), organism(12, [])];

describe('admin users AOR column', () => {
  it("lists the organism's AORs and falls back to the ID for unknown ones", () => {
    const lookup = buildAorColumnLookup(ORGANISMS, AORS, true);

    expect(organismAorLabels(login(10), lookup)).toEqual(['Схід', 'Північ']);
    expect(organismAorLabels(login(11), lookup)).toEqual(['99']);
    expect(organismAorLabels(login(12), lookup)).toEqual([]);
    expect(organismAorLabels(login(null), lookup)).toEqual([]);
    expect(organismAorLabels(login(404), lookup)).toEqual([]);
  });

  it('shows no IDs while the AOR list is still loading', () => {
    const lookup = buildAorColumnLookup(ORGANISMS, [], false);

    expect(organismAorLabels(login(10), lookup)).toEqual([]);
  });

  it('offers each AOR name once, sorted, as a filter option', () => {
    const lookup = buildAorColumnLookup(ORGANISMS, AORS, true);

    expect(lookup.filterOptions).toEqual([
      { text: 'Північ', value: 'Північ' },
      { text: 'Схід', value: 'Схід' },
    ]);
  });
});
