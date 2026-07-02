import { describe, it, expect } from 'vitest';
import {
  truncateToMaxRendered,
  cullSearchResultsToViewport,
  type SearchResultChunk,
  type BoundsLike,
} from '../utils/palitra-render-utils';
import type { PalitraPoint } from '../palitra-types';

function point(lat: number, lng: number, label: string | null = null): PalitraPoint {
  return { coords: { lat, lng }, label };
}

describe('truncateToMaxRendered', () => {
  it('returns all points when under maxPoints', () => {
    const data: SearchResultChunk[] = [
      { palitra_id: 1, points: [point(0, 0), point(1, 1)] },
      { palitra_id: 2, points: [point(2, 2)] },
    ];
    expect(truncateToMaxRendered(data, 10)).toEqual(data);
  });

  it('caps total points at maxPoints (first points across palitras)', () => {
    const data: SearchResultChunk[] = [
      { palitra_id: 1, points: [point(0, 0), point(1, 1), point(2, 2)] },
      { palitra_id: 2, points: [point(3, 3), point(4, 4)] },
    ];
    const out = truncateToMaxRendered(data, 3);
    const total = out.reduce((acc, item) => acc + item.points.length, 0);
    expect(total).toBe(3);
    expect(out).toHaveLength(1);
    expect(out[0].palitra_id).toBe(1);
    expect(out[0].points).toHaveLength(3);
  });

  it('preserves palitra structure and order', () => {
    const data: SearchResultChunk[] = [
      { palitra_id: 1, points: [point(0, 0, 'a'), point(1, 1, 'b')] },
      { palitra_id: 2, points: [point(2, 2, 'c')] },
    ];
    const out = truncateToMaxRendered(data, 2);
    expect(out).toHaveLength(1);
    expect(out[0].palitra_id).toBe(1);
    expect(out[0].points).toHaveLength(2);
    expect(out[0].points[0].label).toBe('a');
    expect(out[0].points[1].label).toBe('b');
  });
});

describe('cullSearchResultsToViewport', () => {
  const bounds: BoundsLike = {
    contains([lat, lng]: [number, number]) {
      return lat >= 1 && lat <= 3 && lng >= 1 && lng <= 3;
    },
  };

  it('filters out points outside bounds', () => {
    const data: SearchResultChunk[] = [
      {
        palitra_id: 1,
        points: [point(0, 0), point(1, 1), point(2, 2), point(4, 4)],
      },
    ];
    const out = cullSearchResultsToViewport(data, bounds);
    expect(out).toHaveLength(1);
    expect(out[0].points).toHaveLength(2);
    expect(out[0].points.map((p) => [p.coords.lat, p.coords.lng])).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  it('keeps all points when all inside bounds', () => {
    const data: SearchResultChunk[] = [{ palitra_id: 1, points: [point(1, 1), point(2, 2)] }];
    const out = cullSearchResultsToViewport(data, bounds);
    expect(out[0].points).toHaveLength(2);
  });

  it('returns empty points list for a palitra when none in bounds', () => {
    const data: SearchResultChunk[] = [{ palitra_id: 1, points: [point(0, 0), point(5, 5)] }];
    const out = cullSearchResultsToViewport(data, bounds);
    expect(out[0].points).toHaveLength(0);
  });

  it('preserves palitra_id for each chunk', () => {
    const data: SearchResultChunk[] = [
      { palitra_id: 10, points: [point(2, 2)] },
      { palitra_id: 20, points: [point(1, 1)] },
    ];
    const out = cullSearchResultsToViewport(data, bounds);
    expect(out.map((c) => c.palitra_id)).toEqual([10, 20]);
  });
});
