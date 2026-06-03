import { describe, expect, it } from 'vitest';

import type { NetworkPoint } from '../../../../../Bindings';
import { NO_DATA_LABEL } from '../../../utils/misc';
import {
  buildPelengationLabelGroups,
  filterPelengationPoints,
  getPelengationFrequencies,
  normalizePelengationFrequency,
} from './NetworkDetailsPelengationMap.shared';

const points: NetworkPoint[] = [
  { id: 1, lat: 49.1, lng: 32.1, body: 'one', freq: '146.5000' },
  { id: 2, lat: 49.2, lng: 32.2, body: 'two', freq: ' 146.7500 ' },
  { id: 3, lat: 49.3, lng: 32.3, body: 'three', freq: '149.0000' },
  { id: 4, lat: 49.4, lng: 32.4, body: 'four', freq: '   ' },
];

describe('NetworkDetailsPelengationMap.shared', () => {
  it('normalizes frequency text', () => {
    expect(normalizePelengationFrequency(' 146.5000 ')).toBe('146.5000');
    expect(normalizePelengationFrequency('   ')).toBe(NO_DATA_LABEL);
  });

  it('collects distinct sorted frequencies', () => {
    expect(getPelengationFrequencies(points)).toEqual(['146.5000', '146.7500', '149.0000', NO_DATA_LABEL]);
  });

  it('filters points by search and enabled frequencies', () => {
    expect(filterPelengationPoints(points, '750', [NO_DATA_LABEL, '146.5000', '146.7500', '149.0000'])).toEqual([
      { id: 2, lat: 49.2, lng: 32.2, body: 'two', freq: ' 146.7500 ' },
    ]);
    expect(filterPelengationPoints(points, '', [NO_DATA_LABEL, '149.0000'])).toEqual([
      { id: 3, lat: 49.3, lng: 32.3, body: 'three', freq: '149.0000' },
      { id: 4, lat: 49.4, lng: 32.4, body: 'four', freq: '   ' },
    ]);
  });

  it('groups nearby same-frequency points into a single label cluster', () => {
    const clustered = buildPelengationLabelGroups(
      [
        { id: 1, lat: 49.1, lng: 32.1, body: 'one', freq: '146.5000' },
        { id: 2, lat: 49.10005, lng: 32.10005, body: 'two', freq: '146.5000' },
        { id: 3, lat: 49.5, lng: 32.5, body: 'three', freq: '146.5000' },
        { id: 4, lat: 49.50005, lng: 32.50005, body: 'four', freq: '149.0000' },
      ],
      (point) => ({ x: point.lng * 1000, y: point.lat * 1000 }),
      50,
    );

    expect(clustered.map((group) => group.label)).toEqual(['146.5000 · 2', '146.5000', '149.0000']);
    expect(clustered[0].points).toHaveLength(2);
  });
});
