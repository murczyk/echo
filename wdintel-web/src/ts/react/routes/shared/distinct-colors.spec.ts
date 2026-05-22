import { describe, expect, it } from 'vitest';

import { buildDistinctColorPalette } from './distinct-colors';

describe('distinct colors', () => {
  it('builds a unique palette per requested count', () => {
    const colors = buildDistinctColorPalette(9);

    expect(colors).toHaveLength(9);
    expect(colors[0]).toBe('#d59a57');
    expect(colors[7]).toBe('#f29cc1');
    expect(colors[8]).toMatch(/^hsl\(\d+ \d+% \d+%\)$/);
    expect(new Set(colors).size).toBe(9);
  });

  it('returns an empty palette for a zero or negative count', () => {
    expect(buildDistinctColorPalette(0)).toEqual([]);
    expect(buildDistinctColorPalette(-1)).toEqual([]);
  });
});
