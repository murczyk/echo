import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

// Global manager to prevent creating 16,000+ IntersectionObservers and timers
let globalObserver: IntersectionObserver | null = null;
const visibleElements = new Set<Element>();
const elementEntries = new Map<
  Element,
  { callback: () => void; messageTimestamp: number; nextUpdateMs: number }
>();
let globalTickTimeout: number | null = null;
const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MAX_TIMER_DELAY_MS = 2_147_000_000;

function isSameLocalDay(firstMs: number, secondMs: number): boolean {
  const first = new Date(firstMs);
  const second = new Date(secondMs);
  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  );
}

function nextLocalMidnightMs(nowMs: number): number {
  const nextMidnight = new Date(nowMs);
  nextMidnight.setHours(24, 0, 0, 0);
  return nextMidnight.getTime();
}

function nextDisplayBoundaryMs(messageTimestamp: number, nowMs: number): number {
  const elapsedMs = nowMs - messageTimestamp;
  if (elapsedMs < 5 * SECOND_MS) return messageTimestamp + 5 * SECOND_MS;
  if (elapsedMs < MINUTE_MS) {
    return messageTimestamp + (Math.floor(elapsedMs / SECOND_MS) + 1) * SECOND_MS;
  }
  if (elapsedMs < HOUR_MS) {
    return messageTimestamp + (Math.floor(elapsedMs / MINUTE_MS) + 1) * MINUTE_MS;
  }
  const nextHourMs = messageTimestamp + (Math.floor(elapsedMs / HOUR_MS) + 1) * HOUR_MS;
  if (elapsedMs < DAY_MS) return nextHourMs;
  if (isSameLocalDay(messageTimestamp, nowMs)) {
    return Math.min(nextHourMs, nextLocalMidnightMs(nowMs));
  }
  return messageTimestamp + (Math.floor(elapsedMs / DAY_MS) + 1) * DAY_MS;
}

function stopGlobalTick() {
  if (globalTickTimeout === null) return;
  window.clearTimeout(globalTickTimeout);
  globalTickTimeout = null;
}

function scheduleGlobalTick() {
  stopGlobalTick();
  const nowMs = Date.now();
  let nextUpdateMs = Number.POSITIVE_INFINITY;
  visibleElements.forEach((element) => {
    const entry = elementEntries.get(element);
    if (!entry) return;
    entry.nextUpdateMs = nextDisplayBoundaryMs(entry.messageTimestamp, nowMs);
    nextUpdateMs = Math.min(nextUpdateMs, entry.nextUpdateMs);
  });
  if (!Number.isFinite(nextUpdateMs)) return;

  globalTickTimeout = window.setTimeout(
    () => {
      globalTickTimeout = null;
      const tickMs = Date.now();
      visibleElements.forEach((element) => {
        const entry = elementEntries.get(element);
        if (entry && entry.nextUpdateMs <= tickMs) entry.callback();
      });
      scheduleGlobalTick();
    },
    Math.min(MAX_TIMER_DELAY_MS, Math.max(0, nextUpdateMs - nowMs)),
  );
}

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
              elementEntries.get(entry.target)?.callback();
            }
          });
        }
        scheduleGlobalTick();
      },
      { rootMargin: '200px' }, // Pre-load slightly off-screen
    );
  }
  return globalObserver;
}

/**
 * Returns a dynamically updating displayMs that only ticks when the message is visible.
 * A single global timer updates relative times for visible cards.
 */
export function useRelativeTimeDisplayMs(
  referenceTimeMs: number | null,
  messageTimestamp: number | null | undefined,
): [RefObject<HTMLElement | null>, number | null] {
  const rootRef = useRef<HTMLElement | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || messageTimestamp == null) return;

    const observer = getObserver();

    const cb = () => setTick((t) => t + 1);
    elementEntries.set(el, {
      callback: cb,
      messageTimestamp,
      nextUpdateMs: Number.POSITIVE_INFINITY,
    });
    observer.observe(el);

    return () => {
      elementEntries.delete(el);
      visibleElements.delete(el);
      observer.unobserve(el);
      scheduleGlobalTick();
      if (elementEntries.size === 0) {
        stopGlobalTick();
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
