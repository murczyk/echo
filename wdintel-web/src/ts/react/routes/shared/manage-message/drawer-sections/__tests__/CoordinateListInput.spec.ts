import { describe, expect, it } from 'vitest';

import { parseCoordinateBlock } from '../../../../../../maps/coordinate-parser.ts';
import { mergeCoordinateInput } from '../CoordinateListInput.tsx';

describe('CoordinateListInput helpers', () => {
  // @test-scope parser: coordinate paste fixture accepts operational coordinate formats.
  it('adds every coordinate from pasted text without manual separators', () => {
    const result = mergeCoordinateInput(
      '49.12345, 37.12345',
      '37U DR 05997 22279\nСК-42: X=5215227.19, Y=6548668.84',
    );

    expect(result.added).toBe(2);
    expect(result.fullyParsed).toBe(true);
    expect(parseCoordinateBlock(result.value).map(({ format }) => format)).toEqual([
      'wgs84',
      'wgs84',
      'wgs84',
    ]);
    expect(result.value).not.toContain('37U DR');
    expect(result.value).not.toContain('СК-42');
  });

  // @test-scope parser: malformed pasted coordinates are atomically rejected.
  it('rejects the entire input when a coordinate is not parsed', () => {
    const currentValue = '50.12345, 38.12345';
    const result = mergeCoordinateInput(currentValue, '49.12345, 37.12345\nunsupported coordinate');

    expect(result.fullyParsed).toBe(false);
    expect(result.parsed).toBe(1);
    expect(result.added).toBe(0);
    expect(result.value).toBe(currentValue);
  });

  // @test-scope safeguard: prevents duplicate-coordinate insertion from creating duplicate map points.
  it('does not add the same point twice', () => {
    const result = mergeCoordinateInput('49.12345, 37.12345', '49.1234500 37.1234500');

    expect(result.parsed).toBe(1);
    expect(result.added).toBe(0);
    expect(parseCoordinateBlock(result.value)).toHaveLength(1);
  });

  // @test-scope parser: one-line multi-coordinate paste fixture.
  it('extracts multiple coordinates pasted on one line', () => {
    const result = mergeCoordinateInput('', '49.12345, 37.12345; 50.12345, 38.12345');

    expect(result.added).toBe(2);
    expect(parseCoordinateBlock(result.value)).toHaveLength(2);
  });
});
