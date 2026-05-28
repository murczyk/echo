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
  const previousSelectionKeysRef = useRef<{ includeKey: string; excludeKey: string } | null>(null);
  const includeKey = useMemo(() => JSON.stringify(includeValues), [includeValues]);
  const excludeKey = useMemo(() => JSON.stringify(excludeValues), [excludeValues]);

  useLayoutEffect(() => {
    const nextMode: FeedFilterMode =
      mode === 'include'
        ? includeValues.length === 0 && excludeValues.length > 0
          ? 'exclude'
          : 'include'
        : excludeValues.length === 0 && includeValues.length > 0
          ? 'include'
          : 'exclude';
    const nextLocalValues = toLocalValues(nextMode === 'include' ? includeValues : excludeValues);
    const selectionKeysChanged =
      previousSelectionKeysRef.current == null ||
      previousSelectionKeysRef.current.includeKey !== includeKey ||
      previousSelectionKeysRef.current.excludeKey !== excludeKey;
    if (selectionKeysChanged && (nextMode !== mode || !sameSelection(localValue, nextLocalValues))) {
      skipWritebackRef.current = true;
    }
    if (nextMode !== mode) setMode(nextMode);
    setLocalValue((prev) => (sameSelection(prev, nextLocalValues) ? prev : nextLocalValues));
    previousSelectionKeysRef.current = { includeKey, excludeKey };
  }, [excludeKey, includeKey, includeValues, excludeValues, mode, toLocalValues]);

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
  }, [excludeKey, includeKey, includeValues, excludeValues, localValue, mode, onExcludeChange, onIncludeChange, toParentValues]);

  return {
    mode,
    localValue,
    setLocalValue,
    setMode: (nextMode) => {
      setMode(nextMode);
      setLocalValue([]);
      if (nextMode === 'include') {
        onExcludeChange([]);
      } else {
        onIncludeChange([]);
      }
    },
  };
}
