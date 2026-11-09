import { useEffect, useMemo, useState } from 'react';

export const ROW_REMOVAL_ANIMATION_MS = 220;

const NO_ROW_IDS: ReadonlySet<number> = new Set();

/**
 * Keeps rows listed in `removedIds` for one animation, reporting them as
 * exiting, then drops them. Rows leaving `removedIds` return immediately.
 */
export function useAnimatedRowRemoval<T extends { id: number }>(
  rows: T[],
  removedIds: ReadonlySet<number>,
): { remainingRows: T[]; exitingIds: ReadonlySet<number> } {
  const [settledIds, setSettledIds] = useState<ReadonlySet<number>>(NO_ROW_IDS);

  useEffect(() => {
    const timer = window.setTimeout(() => setSettledIds(removedIds), ROW_REMOVAL_ANIMATION_MS);
    return () => window.clearTimeout(timer);
  }, [removedIds]);

  return useMemo(() => {
    const remainingRows = rows.filter((row) => !(removedIds.has(row.id) && settledIds.has(row.id)));
    const exitingIds = new Set(
      remainingRows.filter((row) => removedIds.has(row.id)).map((row) => row.id),
    );
    return { remainingRows, exitingIds };
  }, [removedIds, rows, settledIds]);
}
