import { useCallback, useRef, useState } from 'react';

export function useImageEditorRasterQueue() {
  const queueRef = useRef(Promise.resolve());
  const busyRef = useRef(false);
  const [pending, setPending] = useState(0);
  const enqueue = useCallback(<T>(operation: () => Promise<T>) => {
    busyRef.current = true;
    setPending((value) => value + 1);
    const result = queueRef.current.then(operation);
    queueRef.current = result.catch(() => undefined).then(() => undefined);
    return result.finally(() =>
      setPending((value) => {
        const next = value - 1;
        if (next === 0) busyRef.current = false;
        return next;
      }),
    );
  }, []);
  const flush = useCallback(() => queueRef.current, []);
  const isBusy = useCallback(() => busyRef.current, []);
  return { enqueue, flush, isBusy, pending: pending > 0 };
}
