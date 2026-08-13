import { describe, expect, it } from 'vitest';

import { getCoordinateText } from './coordinate-format';
import { isCoordinateBlockFullyParsed, parseCoordinateBlock } from './coordinate-parser';

describe('parseCoordinateBlock', () => {
  it('parses mixed coordinate formats and keeps every point', () => {
    const points = parseCoordinateBlock(`
49.12345, 37.12345
37U DR 05997 22279
36U 350000 5500000
52-20714 65-51696
`);

    expect(points).toHaveLength(4);
    expect(points.map(({ format }) => format)).toEqual(['wgs84', 'mgrs', 'utm', 'usk2000']);
    expect(points.every(({ lat, lng }) => Number.isFinite(lat) && Number.isFinite(lng))).toBe(true);
  });

  it('groups a multiline grid pair into one coordinate', () => {
    const points = parseCoordinateBlock('52-20714\n65-51696');

    expect(points).toHaveLength(1);
    expect(points[0]?.format).toBe('usk2000');
  });

  it('preserves coordinate order across different input formats', () => {
    const points = parseCoordinateBlock(`
49.12345, 37.12345
37U DR 05997 22279
СК-42: X=5215227.19, Y=6548668.84
`);

    expect(points.map(({ format }) => format)).toEqual(['wgs84', 'mgrs', 'sk42']);
  });

  it('uses the true SK-42 projection for explicitly labelled input', () => {
    const [point] = parseCoordinateBlock('СК-42: X=5215227.19, Y=6548668.84');

    expect(point?.format).toBe('sk42');
    expect(point?.lat).toBeCloseTo(47.069, 3);
    expect(point?.lng).toBeCloseTo(33.639, 3);
    const formatted = getCoordinateText('sk42', point!);
    expect(formatted).toMatch(/^СК-42: X=5215\d{3}, Y=6548\d{3}$/);
    expect(parseCoordinateBlock(formatted)[0]?.format).toBe('sk42');
  });

  it('parses WGS-84 DMS input', () => {
    const [point] = parseCoordinateBlock(`47°14'31.4"N 33°35'57.8"E`);

    expect(point?.format).toBe('dms');
    expect(point?.lat).toBeCloseTo(47.242056, 5);
    expect(point?.lng).toBeCloseTo(33.599389, 5);
  });

  it('round-trips УСК-2000 coordinates in western projection zones', () => {
    const formatted = getCoordinateText('usk2000', { lat: 49, lng: 24 });
    const [point] = parseCoordinateBlock(formatted);

    expect(formatted).toMatch(/^УСК-2000: X=\d{7}, Y=4\d{6}$/);
    expect(point?.format).toBe('usk2000');
    expect(point?.lat).toBeCloseTo(49, 4);
    expect(point?.lng).toBeCloseTo(24, 4);
  });

  it('accepts fully parsed mixed coordinate blocks', () => {
    expect(
      isCoordinateBlockFullyParsed(`
49.12345, 37.12345
37U DR 05997 22279
36U 350000 5500000
СК-42: X=5215227.19, Y=6548668.84
УСК-2000: X=5420714, Y=4551696
47°14'31.4"N 33°35'57.8"E
52-20714
65-51696
`),
    ).toBe(true);
  });

  it('rejects a coordinate block with unparsed input', () => {
    expect(isCoordinateBlockFullyParsed('49.12345, 37.12345\nunsupported coordinate')).toBe(false);
    expect(isCoordinateBlockFullyParsed('49.12345, 37.12345 typo')).toBe(false);
  });

  it('accepts repeated valid entries separated by a semicolon', () => {
    expect(isCoordinateBlockFullyParsed('49.12345, 37.12345; 49.12345, 37.12345')).toBe(true);
  });
});
