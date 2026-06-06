import { describe, expect, it } from 'vitest';

import { buildPelengLabelGroups } from './peleng-label-groups';

type TestPoint = {
  id: number;
  lat: number;
  lng: number;
  freq?: string | null;
};

describe('buildPelengLabelGroups', () => {
  it('groups nearby same-frequency points into one label', () => {
    const points: TestPoint[] = [
      { id: 1, lat: 49, lng: 32, freq: '147.4750' },
      { id: 2, lat: 49.00001, lng: 32.00001, freq: '147.4750' },
    ];

    const groups = buildPelengLabelGroups(points, (point) => ({ x: point.lng * 1000, y: point.lat * 1000 }), 50);

    expect(groups).toHaveLength(1);
    expect(groups[0].displayLabel).toBe('147.4750 · 2');
    expect(groups[0].uniqueFreqs).toEqual(['147.4750']);
    expect(groups[0].points.map((point) => point.id)).toEqual([1, 2]);
  });

  it('groups nearby mixed-frequency points into a mixed label', () => {
    const points: TestPoint[] = [
      { id: 1, lat: 49, lng: 32, freq: '147.4750' },
      { id: 2, lat: 49.00001, lng: 32.00001, freq: '148.2000' },
      { id: 3, lat: 49.00002, lng: 32.00002, freq: '148.2000' },
    ];

    const groups = buildPelengLabelGroups(points, (point) => ({ x: point.lng * 1000, y: point.lat * 1000 }), 50);

    expect(groups).toHaveLength(1);
    expect(groups[0].displayLabel).toBe('2 частоти · 3');
    expect(groups[0].uniqueFreqs).toEqual(['147.4750', '148.2000']);
  });

  it('keeps distant points in separate labels', () => {
    const points: TestPoint[] = [
      { id: 1, lat: 49, lng: 32, freq: '147.4750' },
      { id: 2, lat: 49.1, lng: 32.1, freq: '147.4750' },
    ];

    const groups = buildPelengLabelGroups(points, (point) => ({ x: point.lng * 1000, y: point.lat * 1000 }), 10);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.displayLabel)).toEqual(['147.4750', '147.4750']);
  });

  it('handles empty and null frequency values conservatively', () => {
    const points: TestPoint[] = [
      { id: 1, lat: 49, lng: 32, freq: null },
      { id: 2, lat: 49.00001, lng: 32.00001, freq: '   ' },
    ];

    const groups = buildPelengLabelGroups(points, (point) => ({ x: point.lng * 1000, y: point.lat * 1000 }), 50);

    expect(groups).toHaveLength(1);
    expect(groups[0].displayLabel).toBe('— · 2');
    expect(groups[0].uniqueFreqs).toEqual(['—']);
  });

  it('respects the max distance threshold', () => {
    const points: TestPoint[] = [
      { id: 1, lat: 49, lng: 32, freq: '147.4750' },
      { id: 2, lat: 49.00002, lng: 32.00002, freq: '147.4750' },
    ];

    const grouped = buildPelengLabelGroups(points, (point) => ({ x: point.lng * 1000, y: point.lat * 1000 }), 100);
    const split = buildPelengLabelGroups(points, (point) => ({ x: point.lng * 1000, y: point.lat * 1000 }), 0.01);

    expect(grouped).toHaveLength(1);
    expect(split).toHaveLength(2);
  });

  it('splits labels when projected coordinates are farther apart', () => {
    const points: TestPoint[] = [
      { id: 1, lat: 49, lng: 32, freq: '147.4750' },
      { id: 2, lat: 49.00001, lng: 32.00001, freq: '147.4750' },
      { id: 3, lat: 49.002, lng: 32.002, freq: '147.4750' },
    ];

    const groups = buildPelengLabelGroups(points, (point) => ({ x: point.lng * 1000, y: point.lat * 1000 }), 0.5);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.displayLabel)).toEqual(['147.4750 · 2', '147.4750']);
  });

  it('does not merge a long transitive chain into one cluster', () => {
    const points: TestPoint[] = [
      { id: 1, lat: 49, lng: 32, freq: '147.4750' },
      { id: 2, lat: 49.00001, lng: 32.00001, freq: '147.4750' },
      { id: 3, lat: 49.00002, lng: 32.00002, freq: '147.4750' },
    ];

    const groups = buildPelengLabelGroups(points, (point) => ({ x: point.lng * 1000, y: point.lat * 1000 }), 0.02);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.points.map((point) => point.id))).toEqual([[1, 2], [3]]);
  });
});
