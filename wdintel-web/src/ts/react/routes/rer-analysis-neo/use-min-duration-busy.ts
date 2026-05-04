import { useEffect, useRef, useState } from 'react';
import { isNullOrUndefined } from '../../utils/misc';


export function useMinDurationBusy(active: boolean, minDurationMs = 400): boolean {
  const [visible, setVisible] = useState(active);
  const startedAtRef = useRef<number | null>(active ? Date.now() : null);

  useEffect(() => {
    if (active) {
      startedAtRef.current = Date.now();
      setVisible(true);
      return;
    }

    if (!visible) {
      startedAtRef.current = null;
      return;
    }

    const elapsed = isNullOrUndefined(startedAtRef.current) ? minDurationMs : Date.now() - startedAtRef.current;
    const timeoutId = window.setTimeout(() => {
      startedAtRef.current = null;
      setVisible(false);
    }, Math.max(0, minDurationMs - elapsed));

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [active, minDurationMs, visible]);

  return visible;
}
