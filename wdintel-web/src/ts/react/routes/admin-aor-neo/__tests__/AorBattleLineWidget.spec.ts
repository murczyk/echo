/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest';

import type { AreaOfResponsibility } from '../../../../../Bindings';

vi.mock('../../../../maps/leaflet-markercluster', () => ({ L: {} }));
vi.mock('../../../../web-components/analysis-map/tile-layers', () => ({ getTileLayers: vi.fn() }));
vi.mock('../../admin-battle-line/BattleLineMap', () => ({ aorColor: () => '#123456' }));

import { buildBoundaryUpdates, initialBoundaryDrafts } from '.././AorBattleLineWidget';

function aor(id: number, withBoundaries: boolean): AreaOfResponsibility {
  return {
    id,
    name: `AOR ${id}`,
    description: null,
    isTopLevel: true,
    orderForReport: id,
    leftBound: 0,
    rightBound: 0,
    leftCoordinates: withBoundaries ? { latitude: 49, longitude: 36, settlement: null } : null,
    rightCoordinates: withBoundaries ? { latitude: 49, longitude: 37, settlement: null } : null,
    createdAt: 0,
  };
}
describe('AOR BattleLine boundary drafts', () => {
  it('saves only added or moved complete boundary pairs', () => {
    const aors = [aor(1, true), aor(2, false)];
    const drafts = initialBoundaryDrafts(aors);
    expect(buildBoundaryUpdates(aors, drafts)).toEqual([]);

    drafts.set(1, { left: { lat: 49.1, lon: 36 }, right: { lat: 49, lon: 37 } });
    drafts.set(2, { left: { lat: 48, lon: 35 }, right: { lat: 48, lon: 35.1 } });

    expect(buildBoundaryUpdates(aors, drafts)).toEqual([
      {
        id: 1,
        leftCoordinates: { latitude: 49.1, longitude: 36, settlement: null },
        rightCoordinates: { latitude: 49, longitude: 37, settlement: null },
      },
      {
        id: 2,
        leftCoordinates: { latitude: 48, longitude: 35, settlement: null },
        rightCoordinates: { latitude: 48, longitude: 35.1, settlement: null },
      },
    ]);
  });
});
