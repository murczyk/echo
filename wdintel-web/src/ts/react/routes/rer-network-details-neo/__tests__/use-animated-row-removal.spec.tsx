/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ROW_REMOVAL_ANIMATION_MS, useAnimatedRowRemoval } from '../use-animated-row-removal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Row = { id: number };

const ROWS: Row[] = [{ id: 1 }, { id: 2 }, { id: 3 }];

let root: Root | null = null;
let latest: ReturnType<typeof useAnimatedRowRemoval<Row>> | null = null;

function Harness({ removedIds }: { removedIds: ReadonlySet<number> }) {
  latest = useAnimatedRowRemoval(ROWS, removedIds);
  return null;
}

function render(removedIds: ReadonlySet<number>) {
  act(() => {
    root?.render(createElement(Harness, { removedIds }));
  });
}

const remainingIds = () => latest?.remainingRows.map((row) => row.id);

beforeEach(() => {
  vi.useFakeTimers();
  root = createRoot(document.createElement('div'));
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  latest = null;
  vi.useRealTimers();
});

describe('useAnimatedRowRemoval', () => {
  it('keeps removed rows as exiting for one animation, then drops them', () => {
    render(new Set());
    render(new Set([2]));

    expect(remainingIds()).toEqual([1, 2, 3]);
    expect([...(latest?.exitingIds ?? [])]).toEqual([2]);

    act(() => {
      vi.advanceTimersByTime(ROW_REMOVAL_ANIMATION_MS);
    });

    expect(remainingIds()).toEqual([1, 3]);
    expect(latest?.exitingIds.size).toBe(0);
  });

  it('returns rows immediately when they stop being removed', () => {
    render(new Set([2]));
    act(() => {
      vi.advanceTimersByTime(ROW_REMOVAL_ANIMATION_MS);
    });

    render(new Set());

    expect(remainingIds()).toEqual([1, 2, 3]);
    expect(latest?.exitingIds.size).toBe(0);
  });

  it('does not animate rows again when an equal removal set arrives', () => {
    render(new Set([2]));
    act(() => {
      vi.advanceTimersByTime(ROW_REMOVAL_ANIMATION_MS);
    });

    render(new Set([2]));

    expect(remainingIds()).toEqual([1, 3]);
    expect(latest?.exitingIds.size).toBe(0);
  });
});
