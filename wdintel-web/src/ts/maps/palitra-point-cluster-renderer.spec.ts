/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';

import type { Palitra, PalitraPoint } from './palitra-types';
import { resolvePalitraPointColor } from './palitra-point-cluster-renderer';

function palitra(color_hex: string): Palitra {
  return {
    id: 1,
    name: 'test',
    color_hex,
    geometry: null,
  };
}

function point(color?: string | null): PalitraPoint {
  return {
    coords: { lat: 47, lng: 36 },
    label: null,
    color,
  };
}

describe('resolvePalitraPointColor', () => {
  it('uses point color when backend provides geometry color', () => {
    expect(resolvePalitraPointColor(palitra('#00bcd4'), point('#ffff00'))).toBe('#ffff00');
  });

  it('falls back to palitra color when point color is absent', () => {
    expect(resolvePalitraPointColor(palitra('#00bcd4'), point(null))).toBe('#00bcd4');
  });
});
