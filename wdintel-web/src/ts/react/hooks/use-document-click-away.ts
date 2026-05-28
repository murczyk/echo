import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

type UseDocumentClickAwayParams = {
  enabled: boolean;
  refs: readonly RefObject<Element | null>[];
  ignoreSelectors?: readonly string[];
  /** When false, the outside click is ignored and panels stay open. */
  shouldDismiss?: (event: MouseEvent) => boolean;
  onClickAway: () => void;
};

export function useDocumentClickAway({
  enabled,
  refs,
  ignoreSelectors = [],
  shouldDismiss,
  onClickAway,
}: UseDocumentClickAwayParams): void {
  const refsRef = useRef(refs);
  const ignoreSelectorsRef = useRef(ignoreSelectors);
  const shouldDismissRef = useRef(shouldDismiss);
  const onClickAwayRef = useRef(onClickAway);
  refsRef.current = refs;
  ignoreSelectorsRef.current = ignoreSelectors;
  shouldDismissRef.current = shouldDismiss;
  onClickAwayRef.current = onClickAway;

  useEffect(() => {
    if (!enabled) return;

    const handleDocumentMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (refsRef.current.some((ref) => ref.current?.contains(target))) return;
      if (
        target instanceof Element &&
        ignoreSelectorsRef.current.some((selector) => Boolean(target.closest(selector)))
      ) {
        return;
      }
      if (shouldDismissRef.current && !shouldDismissRef.current(event)) return;
      onClickAwayRef.current();
    };

    document.addEventListener('mousedown', handleDocumentMouseDown, true);
    return () => {
      document.removeEventListener('mousedown', handleDocumentMouseDown, true);
    };
  }, [enabled]);
}
