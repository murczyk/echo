import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import {
  DUTY_FEED_IDLE_OFFLOAD_MS,
  DUTY_FEED_IDLE_OFFLOAD_OVERSCAN_PX,
  DUTY_FEED_IDLE_PLACEHOLDER_HEIGHT_PX,
} from './utils';

export type FeedIdleViewportOffload = {
  /** True when this feed has been idle long enough to drop off-viewport MessageCards. */
  offloadActive: boolean;
  /** When offload is active, only these ids keep a live MessageCard; others use placeholders. */
  mountedItemIds: Set<number> | null;
  placeholderHeightPx: (id: number) => number;
};

function measureViewportOffload(
  scroller: HTMLElement,
  overscanPx: number,
): { visibleIds: Set<number>; heights: Map<number, number> } {
  const scrollerRect = scroller.getBoundingClientRect();
  const top = scrollerRect.top - overscanPx;
  const bottom = scrollerRect.bottom + overscanPx;
  const visibleIds = new Set<number>();
  const heights = new Map<number, number>();
  const nodes = scroller.querySelectorAll<HTMLElement>('[data-duty-message-id]');
  for (const node of nodes) {
    const id = Number(node.dataset.dutyMessageId);
    if (!Number.isFinite(id)) continue;
    const height = node.offsetHeight;
    if (height > 0) heights.set(id, height);
    const rect = node.getBoundingClientRect();
    if (rect.bottom > top && rect.top < bottom) visibleIds.add(id);
  }
  return { visibleIds, heights };
}

/**
 * After {@link DUTY_FEED_IDLE_OFFLOAD_MS} without user interaction on a feed scroller,
 * keep only viewport(+overscan) MessageCards mounted; off-screen rows become height placeholders.
 * Pointer / wheel / touch wake the feed and remount the full window.
 * Programmatic scroll (follow / settle) does not count as interaction.
 */
export function useFeedIdleViewportOffload(options: {
  enabled: boolean;
  scrollerRef: RefObject<HTMLElement | null>;
  itemIds: number[];
  idleMs?: number;
  overscanPx?: number;
}): FeedIdleViewportOffload {
  const {
    enabled,
    scrollerRef,
    itemIds,
    idleMs = DUTY_FEED_IDLE_OFFLOAD_MS,
    overscanPx = DUTY_FEED_IDLE_OFFLOAD_OVERSCAN_PX,
  } = options;
  const [offloadActive, setOffloadActive] = useState(false);
  const [mountedItemIds, setMountedItemIds] = useState<Set<number> | null>(null);
  const heightByIdRef = useRef(new Map<number, number>());
  const idleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const offloadActiveRef = useRef(false);
  offloadActiveRef.current = offloadActive;

  const clearIdleTimeout = useCallback(() => {
    if (idleTimeoutRef.current === null) return;
    clearTimeout(idleTimeoutRef.current);
    idleTimeoutRef.current = null;
  }, []);

  const applyOffloadSnapshot = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !enabled) return;
    const { visibleIds, heights } = measureViewportOffload(scroller, overscanPx);
    for (const [id, height] of heights) heightByIdRef.current.set(id, height);
    // Always keep at least the tail when nothing intersects (empty metrics / mid-restore).
    if (visibleIds.size === 0 && itemIds.length > 0) {
      const tail = itemIds.at(-1);
      if (tail != null) visibleIds.add(tail);
    }
    setMountedItemIds(visibleIds);
    setOffloadActive(true);
  }, [enabled, itemIds, overscanPx, scrollerRef]);

  const scheduleIdleOffload = useCallback(() => {
    clearIdleTimeout();
    if (!enabled) return;
    idleTimeoutRef.current = setTimeout(() => {
      idleTimeoutRef.current = null;
      applyOffloadSnapshot();
    }, idleMs);
  }, [applyOffloadSnapshot, clearIdleTimeout, enabled, idleMs]);

  const wakeFromOffload = useCallback(() => {
    clearIdleTimeout();
    if (offloadActiveRef.current) {
      setOffloadActive(false);
      setMountedItemIds(null);
    }
    if (enabled) scheduleIdleOffload();
  }, [clearIdleTimeout, enabled, scheduleIdleOffload]);

  useEffect(() => {
    if (!enabled) {
      clearIdleTimeout();
      setOffloadActive(false);
      setMountedItemIds(null);
      return;
    }
    scheduleIdleOffload();
    return clearIdleTimeout;
  }, [clearIdleTimeout, enabled, scheduleIdleOffload]);

  useEffect(() => {
    if (!enabled) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const onUserInteract = () => wakeFromOffload();
    scroller.addEventListener('pointerdown', onUserInteract);
    scroller.addEventListener('wheel', onUserInteract, { passive: true });
    scroller.addEventListener('touchstart', onUserInteract, { passive: true });
    return () => {
      scroller.removeEventListener('pointerdown', onUserInteract);
      scroller.removeEventListener('wheel', onUserInteract);
      scroller.removeEventListener('touchstart', onUserInteract);
    };
  }, [enabled, itemIds.length, scrollerRef, wakeFromOffload]);

  // While offloaded, keep the mounted set aligned with the viewport after window trims / follow stick.
  useLayoutEffect(() => {
    if (!enabled || !offloadActive) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const { visibleIds, heights } = measureViewportOffload(scroller, overscanPx);
    for (const [id, height] of heights) heightByIdRef.current.set(id, height);
    if (visibleIds.size === 0 && itemIds.length > 0) {
      const tail = itemIds.at(-1);
      if (tail != null) visibleIds.add(tail);
    }
    setMountedItemIds((previous) => {
      if (previous && previous.size === visibleIds.size) {
        let same = true;
        for (const id of visibleIds) {
          if (!previous.has(id)) {
            same = false;
            break;
          }
        }
        if (same) return previous;
      }
      return visibleIds;
    });
  }, [enabled, itemIds, offloadActive, overscanPx, scrollerRef]);

  const placeholderHeightPx = useCallback((id: number) => {
    return heightByIdRef.current.get(id) ?? DUTY_FEED_IDLE_PLACEHOLDER_HEIGHT_PX;
  }, []);

  return {
    offloadActive,
    mountedItemIds: offloadActive ? mountedItemIds : null,
    placeholderHeightPx,
  };
}
