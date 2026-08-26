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
  /**
   * Remount the full window and re-arm idle. For user gestures outside the scroller
   * (e.g. scroll FAB). Programmatic follow/settle must not call this.
   */
  wakeFromOffload: () => void;
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

function sameIdSet(previous: Set<number> | null, next: Set<number>): boolean {
  if (!previous || previous.size !== next.size) return false;
  for (const id of next) {
    if (!previous.has(id)) return false;
  }
  return true;
}

/**
 * After {@link DUTY_FEED_IDLE_OFFLOAD_MS} without user interaction on a feed scroller,
 * keep only viewport(+overscan) MessageCards mounted; off-screen rows become height placeholders.
 * Pointer / wheel / touch wake the feed and remount the full window.
 * Programmatic scroll (follow / settle) does not wake, but must still refresh which ids stay
 * mounted — otherwise stick-bottom restore/ease leaves the viewport on placeholders (black gap).
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
  const itemIdsRef = useRef(itemIds);
  const scrollSyncRafRef = useRef<number | null>(null);
  offloadActiveRef.current = offloadActive;
  itemIdsRef.current = itemIds;

  const clearIdleTimeout = useCallback(() => {
    if (idleTimeoutRef.current === null) return;
    clearTimeout(idleTimeoutRef.current);
    idleTimeoutRef.current = null;
  }, []);

  const syncMountedToViewport = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !enabled) return;
    const ids = itemIdsRef.current;
    const { visibleIds, heights } = measureViewportOffload(scroller, overscanPx);
    for (const [id, height] of heights) heightByIdRef.current.set(id, height);
    // Always keep at least the tail when nothing intersects (empty metrics / mid-restore).
    if (visibleIds.size === 0 && ids.length > 0) {
      const tail = ids.at(-1);
      if (tail != null) visibleIds.add(tail);
    }
    setMountedItemIds((previous) => (sameIdSet(previous, visibleIds) ? previous : visibleIds));
  }, [enabled, overscanPx, scrollerRef]);

  const applyOffloadSnapshot = useCallback(() => {
    if (!enabled) return;
    syncMountedToViewport();
    setOffloadActive(true);
  }, [enabled, syncMountedToViewport]);

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
    syncMountedToViewport();
  }, [enabled, itemIds, offloadActive, syncMountedToViewport]);

  // Programmatic follow/catch-up ease moves scrollTop without waking; refresh mounts on scroll.
  useEffect(() => {
    if (!enabled || !offloadActive) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const onScroll = () => {
      if (scrollSyncRafRef.current !== null) return;
      scrollSyncRafRef.current = requestAnimationFrame(() => {
        scrollSyncRafRef.current = null;
        if (!offloadActiveRef.current) return;
        syncMountedToViewport();
      });
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      if (scrollSyncRafRef.current !== null) {
        cancelAnimationFrame(scrollSyncRafRef.current);
        scrollSyncRafRef.current = null;
      }
    };
  }, [enabled, offloadActive, scrollerRef, syncMountedToViewport]);

  const placeholderHeightPx = useCallback((id: number) => {
    return heightByIdRef.current.get(id) ?? DUTY_FEED_IDLE_PLACEHOLDER_HEIGHT_PX;
  }, []);

  return {
    offloadActive,
    mountedItemIds: offloadActive ? mountedItemIds : null,
    placeholderHeightPx,
    wakeFromOffload,
  };
}
