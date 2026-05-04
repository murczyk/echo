import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { isPresent } from '../../../utils/misc';


const RELATIVE_TIME_TICK_MS = 60_000;

/** While the card intersects the viewport, keep a live clock for `messageRenderDistance`; otherwise use `referenceTimeMs`. */
export function useRelativeTimeDisplayMs(
  referenceTimeMs: number | null,
  messageTimestamp: number | null | undefined,
): [RefObject<HTMLElement | null>, number | null] {
  const rootRef = useRef<HTMLElement | null>(null);
  const [inView, setInView] = useState(false);
  const [liveNowMs, setLiveNowMs] = useState<number | null>(null);

  const enabled = isPresent(messageTimestamp) && isPresent(referenceTimeMs) && !Number.isNaN(messageTimestamp);

  useEffect(() => {
    if (!enabled) {
      setInView(false);
      return;
    }
    const el = rootRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold: 0.01 });
    obs.observe(el);
    return () => obs.disconnect();
  }, [enabled]);

  useLayoutEffect(() => {
    if (!enabled) {
      setLiveNowMs(null);
      return;
    }
    if (!inView) {
      setLiveNowMs(null);
      return;
    }
    setLiveNowMs(Date.now());
    const id = window.setInterval(() => setLiveNowMs(Date.now()), RELATIVE_TIME_TICK_MS);
    return () => window.clearInterval(id);
  }, [enabled, inView, referenceTimeMs]);

  const displayMs = enabled ? (inView ? (liveNowMs ?? referenceTimeMs) : referenceTimeMs) : null;
  return [rootRef, displayMs];
}
