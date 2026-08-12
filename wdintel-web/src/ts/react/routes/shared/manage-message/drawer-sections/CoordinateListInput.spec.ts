import { describe, expect, it } from 'vitest';

import { parseCoordinateBlock } from '../../../../../maps/coordinate-parser';
import {
  duplicateCoordinateHint,
  matchingCoordinateKeys,
  mergeCoordinateInput,
  removeCoordinateAt,
} from './CoordinateListInput';

describe('CoordinateListInput helpers', () => {
  it('adds every coordinate from pasted text without manual separators', () => {
    const result = mergeCoordinateInput(
      '49.12345, 37.12345',
      '37U DR 05997 22279\nСК-42: X=5215227.19, Y=6548668.84',
    );

    expect(result.added).toBe(2);
    expect(parseCoordinateBlock(result.value).map(({ format }) => format)).toEqual([
      'wgs84',
      'wgs84',
      'wgs84',
    ]);
    expect(result.value).not.toContain('37U DR');
    expect(result.value).not.toContain('СК-42');
  });

  it('does not add the same point twice', () => {
    const result = mergeCoordinateInput('49.12345, 37.12345', '49.1234500 37.1234500');

    expect(result.parsed).toBe(1);
    expect(result.added).toBe(0);
    expect(parseCoordinateBlock(result.value)).toHaveLength(1);
  });

  it('detects an existing coordinate directly from the current input', () => {
    expect(duplicateCoordinateHint('49.123457, 37.234568', '49.12346, 37.23457')).toBe(
      'Координата вже є у списку',
    );
  });

  it('does not add a coordinate copied from the rounded list display', () => {
    const result = mergeCoordinateInput('49.123457, 37.234568', '49.12346, 37.23457');

    expect(result.added).toBe(0);
    expect(parseCoordinateBlock(result.value)).toHaveLength(1);
  });

  it('matches an existing coordinate entered in a different format', () => {
    const mgrs = '37U DR 05997 22279';
    const [point] = parseCoordinateBlock(mgrs);
    const currentValue = `${point.lat}, ${point.lng}`;

    expect(matchingCoordinateKeys(currentValue, mgrs)).toEqual(
      new Set([`${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`]),
    );
  });

  it('extracts multiple coordinates pasted on one line', () => {
    const result = mergeCoordinateInput('', '49.12345, 37.12345; 50.12345, 38.12345');

    expect(result.added).toBe(2);
    expect(parseCoordinateBlock(result.value)).toHaveLength(2);
  });

  it('removes only the selected coordinate', () => {
    const value = '49.12345, 37.12345\n50.12345, 38.12345';

    expect(parseCoordinateBlock(removeCoordinateAt(value, 0))).toEqual([
      expect.objectContaining({ lat: 50.12345, lng: 38.12345 }),
    ]);
  });
});
