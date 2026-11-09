import { useEffect, type RefObject } from 'react';

export function useFocusWhenEnabled(
  targetRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled) return;
    const frameId = window.requestAnimationFrame(() => targetRef.current?.focus());
    return () => window.cancelAnimationFrame(frameId);
  }, [enabled, targetRef]);
}
