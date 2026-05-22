import { useEffect, useMemo, useRef, useState } from 'react';
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

function selectionSignature<T>(mode: FeedFilterMode, values: readonly T[]): string {
  return `${mode}:${JSON.stringify(values)}`;
}

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
  const pendingResyncRef = useRef<string | null>(null);

  const includeKey = useMemo(() => JSON.stringify(includeValues), [includeValues]);
  const excludeKey = useMemo(() => JSON.stringify(excludeValues), [excludeValues]);

  useEffect(() => {
    setMode((currentMode) => {
      const includeLen = includeValues.length;
      const excludeLen = excludeValues.length;
      if (currentMode === 'include' && includeLen === 0 && excludeLen > 0) return 'exclude';
      if (currentMode === 'exclude' && excludeLen === 0 && includeLen > 0) return 'include';
      return currentMode;
    });
  }, [includeKey, excludeKey, includeValues.length, excludeValues.length]);

  useEffect(() => {
    const activeValues = mode === 'include' ? includeValues : excludeValues;
    const nextLocalValues = toLocalValues(activeValues);
    setLocalValue((prev) => {
      if (sameSelection(prev, nextLocalValues)) return prev;
      pendingResyncRef.current = selectionSignature(mode, nextLocalValues);
      return nextLocalValues;
    });
  }, [excludeKey, includeKey, includeValues, excludeValues, mode, toLocalValues]);

  useEffect(() => {
    const nextSignature = selectionSignature(mode, localValue);
    if (pendingResyncRef.current === nextSignature) {
      pendingResyncRef.current = null;
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
