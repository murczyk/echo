import { describe, expect, it } from 'vitest';
import { mergeMessageWindow } from '../windowing';

const getId = (item: { id: number }) => item.id;
const ids = (items: readonly { id: number }[]) => items.map(getId);
const items = (...values: number[]) => values.map((id) => ({ id }));

describe('mergeMessageWindow', () => {
  it('keeps the newest 40 after a below load and evicts the opposite edge', () => {
    const first = mergeMessageWindow(
      items(...Array.from({ length: 20 }, (_, i) => i + 1)),
      items(...Array.from({ length: 20 }, (_, i) => i + 21)),
      'below',
      { limit: 40, getId },
    );
    const next = mergeMessageWindow(
      first.items,
      items(...Array.from({ length: 20 }, (_, i) => i + 41)),
      'below',
      { limit: 40, getId },
    );

    expect(ids(next.items)).toEqual(Array.from({ length: 40 }, (_, i) => i + 21));
    expect(ids(next.addedItems)).toEqual(Array.from({ length: 20 }, (_, i) => i + 41));
    expect(ids(next.removedItems)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('retains an above page and evicts from below with a custom limit', () => {
    const result = mergeMessageWindow(items(3, 4, 5), items(1, 2), 'above', { limit: 3, getId });

    expect(ids(result.items)).toEqual([1, 2, 3]);
    expect(ids(result.addedItems)).toEqual([1, 2]);
    expect(ids(result.removedItems)).toEqual([4, 5]);
  });

  it('preserves existing duplicates and does not evict when an overlapping page adds nothing', () => {
    const existing = items(1, 2, 3);
    const result = mergeMessageWindow(existing, [{ id: 3 }, { id: 3 }, { id: 2 }], 'below', {
      limit: 3,
      getId,
    });

    expect(result.items).toEqual(existing);
    expect(result.items[2]).toBe(existing[2]);
    expect(result.addedItems).toEqual([]);
    expect(result.removedItems).toEqual([]);
  });

  it('deduplicates the first incoming occurrence and orders before trimming', () => {
    const result = mergeMessageWindow(
      items(2),
      [{ id: 4 }, { id: 1 }, { id: 4 }, { id: 3 }],
      'below',
      {
        limit: 3,
        getId,
        order: (values) => values.sort((a, b) => a.id - b.id),
      },
    );

    expect(ids(result.items)).toEqual([2, 3, 4]);
    expect(ids(result.addedItems)).toEqual([4, 1, 3]);
    expect(ids(result.removedItems)).toEqual([1]);
  });
});
