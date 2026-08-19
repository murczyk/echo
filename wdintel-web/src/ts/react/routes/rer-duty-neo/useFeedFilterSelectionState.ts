import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

export type FeedFilterMode = 'include' | 'exclude';

type UseFeedFilterSelectionStateParams<TLocal> = {
  includeValues: readonly string[];
  excludeValues: readonly string[];
  onIncludeChange: (next: string[]) => void;
  onExcludeChange: (next: string[]) => void;
  toLocalValues: (values: readonly string[]) => TLocal[];
  toParentValues: (values: readonly TLocal[]) => string[];
};

type SelectionStateResult<TLocal> = {
  mode: FeedFilterMode;
  localValue: TLocal[];
  setLocalValue: Dispatch<SetStateAction<TLocal[]>>;
  setMode: (mode: FeedFilterMode) => void;
};

function sameSelection<T>(a: readonly T[], b: readonly T[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function useFeedFilterSelectionState<TLocal>({
  includeValues,
  excludeValues,
  onIncludeChange,
  onExcludeChange,
  toLocalValues,
  toParentValues,
}: UseFeedFilterSelectionStateParams<TLocal>): SelectionStateResult<TLocal> {
  const initialMode: FeedFilterMode = excludeValues.length > 0 ? 'exclude' : 'include';
  const [mode, setMode] = useState<FeedFilterMode>(initialMode);
  const [localValue, setLocalValue] = useState<TLocal[]>(() =>
    toLocalValues(initialMode === 'include' ? includeValues : excludeValues),
  );
  const skipWritebackRef = useRef(false);
  const pendingModeTransferRef = useRef<{
    mode: FeedFilterMode;
    values: string[];
  } | null>(null);
  const previousSelectionKeyRef = useRef<string | null>(null);
  const includeKey = useMemo(() => JSON.stringify(includeValues), [includeValues]);
  const excludeKey = useMemo(() => JSON.stringify(excludeValues), [excludeValues]);

  useLayoutEffect(() => {
    const pendingTransfer = pendingModeTransferRef.current;
    if (pendingTransfer != null && mode === pendingTransfer.mode) {
      const transferredValues = pendingTransfer.values;
      const activeValues = mode === 'include' ? includeValues : excludeValues;
      const opposingValues = mode === 'include' ? excludeValues : includeValues;
      if (sameSelection(activeValues, transferredValues) && opposingValues.length === 0) {
        pendingModeTransferRef.current = null;
        previousSelectionKeyRef.current = `${mode}:${mode === 'include' ? includeKey : excludeKey}`;
      }
      return;
    }
    const nextMode: FeedFilterMode =
      mode === 'include'
        ? includeValues.length === 0 && excludeValues.length > 0
          ? 'exclude'
          : 'include'
        : excludeValues.length === 0 && includeValues.length > 0
          ? 'include'
          : 'exclude';
    const activeValues = nextMode === 'include' ? includeValues : excludeValues;
    const nextLocalValues = toLocalValues(activeValues);
    const selectionKey = `${nextMode}:${nextMode === 'include' ? includeKey : excludeKey}`;
    const selectionChanged = previousSelectionKeyRef.current !== selectionKey;
    const localStillMatchesParent = sameSelection(toParentValues(localValue), activeValues);
    const shouldRefreshLocal = selectionChanged || localStillMatchesParent;
    if (selectionChanged && shouldRefreshLocal) {
      skipWritebackRef.current = true;
    }
    if (nextMode !== mode) setMode(nextMode);
    if (shouldRefreshLocal) {
      setLocalValue((prev) => (sameSelection(prev, nextLocalValues) ? prev : nextLocalValues));
    }
    previousSelectionKeyRef.current = selectionKey;
  }, [
    excludeKey,
    includeKey,
    includeValues,
    excludeValues,
    localValue,
    mode,
    toLocalValues,
    toParentValues,
  ]);

  useEffect(() => {
    if (skipWritebackRef.current) {
      skipWritebackRef.current = false;
      return;
    }
    const currentValues = mode === 'include' ? includeValues : excludeValues;
    const nextParentValues = toParentValues(localValue);
    if (sameSelection(currentValues, nextParentValues)) return;
    if (mode === 'include') onIncludeChange(nextParentValues);
    else onExcludeChange(nextParentValues);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only on localValue so writeback runs after resync
  }, [
    excludeKey,
    includeKey,
    includeValues,
    excludeValues,
    localValue,
    mode,
    onExcludeChange,
    onIncludeChange,
    toParentValues,
  ]);

  return {
    mode,
    localValue,
    setLocalValue,
    setMode: (nextMode) => {
      if (nextMode === mode) return;
      const transferredValues = toParentValues(localValue);
      pendingModeTransferRef.current = { mode: nextMode, values: transferredValues };
      skipWritebackRef.current = true;
      setMode(nextMode);
      if (
        transferredValues.length === 0 &&
        includeValues.length === 0 &&
        excludeValues.length === 0
      ) {
        return;
      }
      if (nextMode === 'include') {
        onIncludeChange(transferredValues);
        onExcludeChange([]);
      } else {
        onExcludeChange(transferredValues);
        onIncludeChange([]);
      }
    },
  };
}
