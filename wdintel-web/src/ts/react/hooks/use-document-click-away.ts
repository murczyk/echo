import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

type UseDocumentClickAwayParams = {
  enabled: boolean;
  refs: readonly RefObject<Element | null>[];
  onClickAway: () => void;
};

export function useDocumentClickAway({ enabled, refs, onClickAway }: UseDocumentClickAwayParams): void {
  const refsRef = useRef(refs);
  const onClickAwayRef = useRef(onClickAway);
  refsRef.current = refs;
  onClickAwayRef.current = onClickAway;

  useEffect(() => {
    if (!enabled) return;

    const handleDocumentMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (refsRef.current.some((ref) => ref.current?.contains(target))) return;
      onClickAwayRef.current();
    };

    document.addEventListener('mousedown', handleDocumentMouseDown, true);
    return () => {
      document.removeEventListener('mousedown', handleDocumentMouseDown, true);
    };
  }, [enabled]);
}
