import { describe, expect, it } from 'vitest';

import { sortAndTakeTopAnalysisCountItems } from './count-items';

describe('sortAndTakeTopAnalysisCountItems', () => {
  it('sorts by message count descending and then by key', () => {
    expect(
      sortAndTakeTopAnalysisCountItems([
        { key: 'Янтарне', count: 3 },
        { key: 'Байцури', count: 44 },
        { key: 'Амбарне', count: 44 },
        { key: 'Іванівка', count: 22 },
      ]),
    ).toEqual([
      { key: 'Амбарне', count: 44 },
      { key: 'Байцури', count: 44 },
      { key: 'Іванівка', count: 22 },
      { key: 'Янтарне', count: 3 },
    ]);
  });

  it('keeps all items after sorting', () => {
    const items = Array.from({ length: 14 }, (_value, index) => ({
      key: `key-${index}`,
      count: index,
    }));

    const result = sortAndTakeTopAnalysisCountItems(items);

    expect(result).toHaveLength(14);
    expect(result[0]).toEqual({ key: 'key-13', count: 13 });
    expect(result[13]).toEqual({ key: 'key-0', count: 0 });
  });

  it('keeps the summary item first and preserves all sorted details after it', () => {
    const items = [
      { key: '   ', count: 162 },
      ...Array.from({ length: 14 }, (_value, index) => ({
        key: `key-${index}`,
        count: 100 - index,
      })),
    ];

    const result = sortAndTakeTopAnalysisCountItems(items);

    expect(result).toHaveLength(15);
    expect(result[0]).toEqual({ key: '   ', count: 162 });
    expect(result[1]).toEqual({ key: 'key-0', count: 100 });
    expect(result[12]).toEqual({ key: 'key-11', count: 89 });
    expect(result[14]).toEqual({ key: 'key-13', count: 87 });
  });
});
