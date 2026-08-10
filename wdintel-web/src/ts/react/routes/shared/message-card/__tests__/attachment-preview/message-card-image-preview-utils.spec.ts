import { describe, expect, it } from 'vitest';

import {
  getNextWheelZoom,
  normalizeWheelDeltaY,
  ZOOM_MAX,
  ZOOM_MIN,
} from '../../message-card-image-preview-utils';
import { clampPan } from '../../message-card-image-utils';

describe('message-card-image-preview-utils', () => {
  it('normalizes wheel pixels, lines, and pages', () => {
    expect(normalizeWheelDeltaY(2, 0, 800)).toBe(2);
    expect(normalizeWheelDeltaY(2, 1, 800)).toBe(32);
    expect(normalizeWheelDeltaY(2, 2, 800)).toBe(1600);
  });

  it('calculates continuous monotonic wheel zoom within bounds', () => {
    const first = getNextWheelZoom(ZOOM_MIN, -10, 0, 800);
    const second = getNextWheelZoom(first, -10, 0, 800);

    expect(first).toBeGreaterThan(ZOOM_MIN);
    expect(second).toBeGreaterThan(first);
    expect(first - ZOOM_MIN).toBeLessThan(25);
    expect(getNextWheelZoom(ZOOM_MAX, -10000, 0, 800)).toBe(ZOOM_MAX);
    expect(getNextWheelZoom(ZOOM_MIN, 10000, 0, 800)).toBe(ZOOM_MIN);
  });

  it('clamps pan against fitted image dimensions', () => {
    expect(clampPan({ x: 500, y: 500 }, 800, 400, 800, 600, 200)).toEqual({ x: 500, y: 300 });
    expect(clampPan({ x: 100, y: 100 }, 300, 400, 800, 600, 150)).toEqual({ x: 50, y: 100 });
  });
});
