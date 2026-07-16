import { describe, expect, it } from 'vitest';

import { parseCoordinateInput } from './coordinate-search';

describe('parseCoordinateInput', () => {
  it('parses copied WGS84 decimal coordinates', () => {
    expect(parseCoordinateInput('47.42135, 35.62197')).toEqual({
      lat: 47.42135,
      lng: 35.62197,
    });
  });

  it('parses WGS84 coordinates in lng, lat order when only that ordering is valid', () => {
    expect(parseCoordinateInput('120.50000 47.42135')).toEqual({
      lat: 47.42135,
      lng: 120.5,
    });
  });

  it('parses copied MGRS coordinates with spaces', () => {
    const parsed = parseCoordinateInput('37U DQ 15402 40987');

    expect(parsed).not.toBeNull();
    expect(parsed!.lat).toBeGreaterThan(0);
    expect(parsed!.lng).toBeGreaterThan(0);
  });

  it('parses MGRS coordinates used in analysis search', () => {
    const parsed = parseCoordinateInput('11T XT 11111 11111');

    expect(parsed).not.toBeNull();
    expect(parsed!.lat).toBeGreaterThanOrEqual(-90);
    expect(parsed!.lat).toBeLessThanOrEqual(90);
    expect(parsed!.lng).toBeGreaterThanOrEqual(-180);
    expect(parsed!.lng).toBeLessThanOrEqual(180);
  });

  it('parses UTM coordinates with zone, band, easting and northing', () => {
    const parsed = parseCoordinateInput('33T 292332 4642055');

    expect(parsed).not.toBeNull();
    expect(parsed!.lat).toBeGreaterThanOrEqual(-90);
    expect(parsed!.lat).toBeLessThanOrEqual(90);
    expect(parsed!.lng).toBeGreaterThanOrEqual(-180);
    expect(parsed!.lng).toBeLessThanOrEqual(180);
  });
});
