import { describe, expect, it } from 'vitest';
import { markerSignature, planMarkerSync } from '../map-markers';

describe('#3064 marker sync', () => {
  it('updates only the marker whose SIDC changed', () => {
    const existing = new Map([
      ['alpha', markerSignature(['10031000001211020000', 47, 33, 'Альфа', false])],
      ['beta', markerSignature(['10061000001211020000', 47.1, 33.1, 'Бета', false])],
      ['gamma', markerSignature(['10041000001211020000', 47.2, 33.2, 'Гамма', false])],
    ]);
    const plan = planMarkerSync(existing, [
      { id: 'alpha', signature: markerSignature(['10032000001211020000', 47, 33, 'Альфа', false]) },
      { id: 'beta', signature: existing.get('beta')! },
      { id: 'gamma', signature: existing.get('gamma')! },
      { id: 'ghost:delta', signature: markerSignature(['remove', 47.3, 33.3, 'Дельта']) },
    ]);
    expect(plan.update).toEqual(['alpha']);
    expect(plan.keep).toEqual(['beta', 'gamma']);
    expect(plan.add).toEqual(['ghost:delta']);
    expect(plan.remove).toEqual([]);
  });
});
