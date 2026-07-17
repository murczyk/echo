import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

// Global manager to prevent creating 16,000+ IntersectionObservers and intervals
let globalObserver: IntersectionObserver | null = null;
const visibleElements = new Set<Element>();
const elementCallbacks = new Map<Element, () => void>();
let globalTickInterval: number | null = null;

function getObserver() {
  if (!globalObserver) {
    globalObserver = new IntersectionObserver(
      (entries) => {
        let changed = false;
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            visibleElements.add(entry.target);
            changed = true;
          } else {
            visibleElements.delete(entry.target);
          }
        });

        // Immediately update newly visible elements to ensure their time is accurate
        if (changed) {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              const cb = elementCallbacks.get(entry.target);
              if (cb) cb();
            }
          });
        }
      },
      { rootMargin: '200px' }, // Pre-load slightly off-screen
    );
  }
  return globalObserver;
}

function startGlobalTick() {
  if (globalTickInterval === null) {
    // Update visible elements every minute
    globalTickInterval = window.setInterval(() => {
      visibleElements.forEach((el) => {
        const cb = elementCallbacks.get(el);
        if (cb) cb();
      });
    }, 60000);
  }
}

/**
 * Returns a dynamically updating displayMs that only ticks when the message is visible.
 * This restores auto-updating relative times ("5хв назад") with virtually zero overhead.
 */
export function useRelativeTimeDisplayMs(
  referenceTimeMs: number | null,
  messageTimestamp: number | null | undefined,
): [RefObject<HTMLElement | null>, number | null] {
  const rootRef = useRef<HTMLElement | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || !messageTimestamp) return;

    startGlobalTick();
    const observer = getObserver();

    const cb = () => setTick((t) => t + 1);
    elementCallbacks.set(el, cb);
    observer.observe(el);

    return () => {
      elementCallbacks.delete(el);
      visibleElements.delete(el);
      observer.unobserve(el);
      if (elementCallbacks.size === 0) {
        if (globalTickInterval !== null) {
          window.clearInterval(globalTickInterval);
          globalTickInterval = null;
        }
        if (globalObserver !== null) {
          globalObserver.disconnect();
          globalObserver = null;
        }
      }
    };
  }, [messageTimestamp]);

  // Use Date.now() when ticked, otherwise stick to the stable referenceTimeMs
  const displayMs = tick > 0 ? Date.now() : referenceTimeMs;
  return [rootRef as any, displayMs];
}
