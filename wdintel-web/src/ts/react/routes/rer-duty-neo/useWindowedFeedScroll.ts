import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { RefObject, UIEventHandler } from 'react';

export type WindowedFeedScrollItem = { id: number };

function areNumberArraysEqual(a: readonly number[], b: readonly number[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  if (a.length === 0) return true;
  if (a[0] !== b[0] || a[a.length - 1] !== b[b.length - 1]) return false;
  for (let i = 1; i < a.length - 1; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

type VisibleAnchor = {
  id: number;
  index: number;
  offsetTop: number;
};

type AnchorSnapshot = {
  anchors: VisibleAnchor[];
};

export type UseWindowedFeedScrollOptions = {
  itemIds: readonly number[];
  loadingOlder: boolean;
  loadingNewer?: boolean;
  hasReachedStart: boolean;
  onLoadOlder: () => void;
  onLoadNewer?: () => void;
  onScrollToTop?: () => void;
  onReachedBottom?: () => void;
  onLeftBottom?: () => void;
  onNearBottomChange?: (near: boolean) => void;
  onAtBottomChange?: (atBottom: boolean) => void;
  onVisibleMessageIds?: (lastVisibleId: number, opts?: { atBottom?: boolean }) => void;
  topLoadBufferPx?: number;
  bottomLoadBufferPx?: number;
  atBottomThresholdPx?: number;
  resetKey?: string | number | null;
  isWatchMode?: boolean;
  enabled?: boolean;
};

export type WindowedFeedScrollHandle = {
  scrollerRef: RefObject<HTMLDivElement>;
  listRef: RefObject<HTMLDivElement>;
  handleScroll: UIEventHandler<HTMLDivElement>;
  setItemRef: (id: number) => (node: HTMLDivElement | null) => void;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
};

const DEFAULT_TOP_LOAD_BUFFER_PX = 160;
const DEFAULT_BOTTOM_LOAD_BUFFER_PX = 320;
const DEFAULT_AT_BOTTOM_THRESHOLD_PX = 25;
const INITIAL_BOTTOM_SETTLE_FRAMES = 12;
const INITIAL_BOTTOM_SETTLE_TIMEOUT_MS = 2000;

function distanceToBottom(el: HTMLElement): number {
  return Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop);
}

export function useWindowedFeedScroll({
  itemIds,
  loadingOlder,
  loadingNewer = false,
  hasReachedStart,
  onLoadOlder,
  onLoadNewer,
  onScrollToTop,
  onReachedBottom,
  onLeftBottom,
  onNearBottomChange,
  onAtBottomChange,
  onVisibleMessageIds,
  topLoadBufferPx = DEFAULT_TOP_LOAD_BUFFER_PX,
  bottomLoadBufferPx = DEFAULT_BOTTOM_LOAD_BUFFER_PX,
  atBottomThresholdPx = DEFAULT_AT_BOTTOM_THRESHOLD_PX,
  resetKey = null,
  isWatchMode = true,
  enabled = true,
}: UseWindowedFeedScrollOptions): WindowedFeedScrollHandle {
  const callbacksRef = useRef({
    onLoadOlder,
    onLoadNewer,
    onScrollToTop,
    onReachedBottom,
    onLeftBottom,
    onNearBottomChange,
    onAtBottomChange,
    onVisibleMessageIds,
  });
  useLayoutEffect(() => {
    callbacksRef.current = {
      onLoadOlder,
      onLoadNewer,
      onScrollToTop,
      onReachedBottom,
      onLeftBottom,
      onNearBottomChange,
      onAtBottomChange,
      onVisibleMessageIds,
    };
  });
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const itemRefsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const loadOlderTriggeredRef = useRef(false);
  const loadNewerTriggeredRef = useRef(false);
  const hasSeenNotAtBottomRef = useRef(false);
  const atBottomRef = useRef<boolean | null>(null);
  const previousScrollTopRef = useRef(0);
  const nearBottomRef = useRef<boolean | null>(null);
  const atTopRef = useRef<boolean | null>(null);
  const anchorSnapshotRef = useRef<AnchorSnapshot | null>(null);
  const hasInitialScrolledRef = useRef(false);
  const bottomSettleActiveRef = useRef(false);
  const bottomSettleFramesRemainingRef = useRef(0);
  const bottomSettleRafRef = useRef<number | null>(null);
  const bottomSettleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bottomSettleResizeObserverRef = useRef<ResizeObserver | null>(null);
  const previousItemIdsRef = useRef<readonly number[]>([]);
  const previousResetKeyRef = useRef<string | number | null>(resetKey);
  const isWatchModeRef = useRef<boolean>(isWatchMode);
  // Narrow-screen feeds remain mounted while hidden. Disabled tracking must not
  // report visibility, bottom state, loads, or read-state side effects.
  const enabledRef = useRef<boolean>(enabled);
  const enabledBeforeRender = enabledRef.current;
  isWatchModeRef.current = isWatchMode;
  const wasAtBottomBeforeRender = atBottomRef.current;

  const itemIdsRef = useRef<readonly number[]>(itemIds);
  itemIdsRef.current = itemIds;
  useLayoutEffect(() => {
    const activeIds = new Set(itemIds);
    for (const id of refCacheRef.current.keys()) {
      if (!activeIds.has(id)) refCacheRef.current.delete(id);
    }
    for (const id of itemRefsRef.current.keys()) {
      if (!activeIds.has(id)) itemRefsRef.current.delete(id);
    }
  }, [itemIds]);

  useEffect(() => {
    if (!loadingOlder) loadOlderTriggeredRef.current = false;
  }, [loadingOlder]);

  useEffect(() => {
    if (!loadingNewer) loadNewerTriggeredRef.current = false;
  }, [loadingNewer]);

  const collectVisibleAnchors = useCallback((): VisibleAnchor[] => {
    const scroller = scrollerRef.current;
    if (!scroller) return [];
    const scrollerRect = scroller.getBoundingClientRect();
    const scrollerTop = scrollerRect.top;
    const scrollerBottom = scrollerRect.bottom;
    const ids = itemIdsRef.current;
    if (ids.length === 0) return [];

    const getRect = (idx: number) => {
      const id = ids[idx];
      const node = itemRefsRef.current.get(id);
      return node ? node.getBoundingClientRect() : null;
    };

    let low = 0;
    let high = ids.length - 1;
    let firstVisibleIdx = -1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const rect = getRect(mid);

      if (!rect) {
        low = mid + 1;
        continue;
      }

      if (rect.bottom >= scrollerTop) {
        if (mid === 0) {
          firstVisibleIdx = mid;
          break;
        } else {
          const prevRect = getRect(mid - 1);
          if (!prevRect || prevRect.bottom < scrollerTop) {
            firstVisibleIdx = mid;
            break;
          } else {
            high = mid - 1;
          }
        }
      } else {
        low = mid + 1;
      }
    }

    if (firstVisibleIdx === -1) return [];

    const anchors: VisibleAnchor[] = [];
    for (let i = firstVisibleIdx; i < ids.length; i++) {
      const id = ids[i];
      const node = itemRefsRef.current.get(id);
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      if (rect.top > scrollerBottom) break;
      if (rect.bottom >= scrollerTop) {
        anchors.push({ id, index: i, offsetTop: rect.top - scrollerTop });
      }
    }

    return anchors;
  }, []);

  const captureAnchorSnapshot = useCallback(() => {
    const anchors = collectVisibleAnchors();
    anchorSnapshotRef.current = anchors.length > 0 ? { anchors } : null;
  }, [collectVisibleAnchors]);

  const reportVisibleMessageIdsRafRef = useRef<number | null>(null);
  const reportVisibleMessageIdsLastRunRef = useRef<number>(0);
  const reportVisibleMessageIdsLatestArgsRef = useRef<boolean>(false);
  const handleScrollRafRef = useRef<number | null>(null);

  const reportVisibleMessageIds = useCallback(
    (atBottom: boolean) => {
      if (!enabledRef.current) return;
      reportVisibleMessageIdsLatestArgsRef.current = atBottom;

      const run = () => {
        if (!enabledRef.current) return;
        reportVisibleMessageIdsLastRunRef.current = Date.now();
        const latestAtBottom = reportVisibleMessageIdsLatestArgsRef.current;
        const { onVisibleMessageIds } = callbacksRef.current;
        if (!onVisibleMessageIds || itemIdsRef.current.length === 0) return;
        if (latestAtBottom) {
          onVisibleMessageIds(itemIdsRef.current[itemIdsRef.current.length - 1], {
            atBottom: true,
          });
          return;
        }

        const anchors = collectVisibleAnchors();
        const lastVisibleIndex = anchors.reduce((max, anchor) => Math.max(max, anchor.index), -1);
        if (lastVisibleIndex < 0) return;
        onVisibleMessageIds(itemIdsRef.current[lastVisibleIndex], { atBottom: false });
      };

      const now = Date.now();
      if (now - reportVisibleMessageIdsLastRunRef.current > 200) {
        if (reportVisibleMessageIdsRafRef.current !== null) {
          window.clearTimeout(reportVisibleMessageIdsRafRef.current);
          reportVisibleMessageIdsRafRef.current = null;
        }
        run();
      } else {
        if (reportVisibleMessageIdsRafRef.current === null) {
          reportVisibleMessageIdsRafRef.current = window.setTimeout(() => {
            reportVisibleMessageIdsRafRef.current = null;
            if (!enabledRef.current) return;
            run();
          }, 200);
        }
      }
    },
    [collectVisibleAnchors],
  );

  const stopBottomSettle = useCallback(() => {
    bottomSettleActiveRef.current = false;
    if (bottomSettleRafRef.current !== null) {
      cancelAnimationFrame(bottomSettleRafRef.current);
      bottomSettleRafRef.current = null;
    }
    if (bottomSettleTimeoutRef.current !== null) {
      clearTimeout(bottomSettleTimeoutRef.current);
      bottomSettleTimeoutRef.current = null;
    }
    bottomSettleResizeObserverRef.current?.disconnect();
    bottomSettleResizeObserverRef.current = null;
  }, []);

  useEffect(() => stopBottomSettle, [stopBottomSettle]);

  const cancelPendingScrollProcessing = useCallback(() => {
    if (handleScrollRafRef.current !== null) {
      cancelAnimationFrame(handleScrollRafRef.current);
      handleScrollRafRef.current = null;
    }
    if (reportVisibleMessageIdsRafRef.current !== null) {
      window.clearTimeout(reportVisibleMessageIdsRafRef.current);
      reportVisibleMessageIdsRafRef.current = null;
    }
  }, []);

  useLayoutEffect(() => {
    enabledRef.current = enabled;

    if (enabledBeforeRender && !enabled) {
      cancelPendingScrollProcessing();
      stopBottomSettle();
      const { onAtBottomChange, onNearBottomChange } = callbacksRef.current;
      if (atBottomRef.current !== false) onAtBottomChange?.(false);
      if (nearBottomRef.current !== false) onNearBottomChange?.(false);
      atBottomRef.current = false;
      nearBottomRef.current = false;
      loadOlderTriggeredRef.current = false;
      loadNewerTriggeredRef.current = false;
    }
  }, [cancelPendingScrollProcessing, enabled, stopBottomSettle]);

  const updateScrollState = useCallback(
    (
      opts: { allowLoadOlder?: boolean; allowLoadNewer?: boolean; allowTopReached?: boolean } = {},
    ) => {
      if (!enabledRef.current) return;
      const scroller = scrollerRef.current;
      if (!scroller) return;

      const bottomDistance = distanceToBottom(scroller);
      const atBottom = bottomDistance <= atBottomThresholdPx;
      const nearBottom = bottomDistance <= bottomLoadBufferPx;
      const atTop = scroller.scrollTop <= 0;
      const wasAtBottom = atBottomRef.current;
      const currentScrollTop = scroller.scrollTop;
      const prevScrollTop = previousScrollTopRef.current;
      previousScrollTopRef.current = currentScrollTop;

      const {
        onNearBottomChange,
        onAtBottomChange,
        onLeftBottom,
        onReachedBottom,
        onScrollToTop,
        onLoadOlder,
        onLoadNewer,
      } = callbacksRef.current;

      if (nearBottomRef.current !== nearBottom) {
        nearBottomRef.current = nearBottom;
        onNearBottomChange?.(nearBottom);
      }

      if (bottomSettleActiveRef.current && !atBottom && opts.allowLoadOlder !== false) {
        stopBottomSettle();
      }

      if (wasAtBottom !== atBottom) {
        atBottomRef.current = atBottom;
        onAtBottomChange?.(atBottom);
      }
      if (!atBottom) hasSeenNotAtBottomRef.current = true;
      if (wasAtBottom === true && !atBottom) {
        const scrolledUp = currentScrollTop < prevScrollTop - 1;
        if (scrolledUp && !bottomSettleActiveRef.current) {
          onLeftBottom?.();
        }
      }
      if (atBottom && wasAtBottom === false && hasSeenNotAtBottomRef.current) onReachedBottom?.();

      if (opts.allowTopReached !== false && atTopRef.current !== atTop) {
        atTopRef.current = atTop;
        if (atTop) onScrollToTop?.();
      }

      reportVisibleMessageIds(atBottom);

      if (opts.allowLoadOlder !== false) {
        const shouldLoadOlder =
          scroller.scrollTop <= topLoadBufferPx && !loadingOlder && !hasReachedStart;
        if (shouldLoadOlder && !loadOlderTriggeredRef.current) {
          loadOlderTriggeredRef.current = true;
          onLoadOlder();
        } else if (scroller.scrollTop > topLoadBufferPx) {
          loadOlderTriggeredRef.current = false;
        }
      }

      if (opts.allowLoadNewer !== false) {
        const shouldLoadNewer = nearBottom && !loadingNewer && typeof onLoadNewer === 'function';
        if (shouldLoadNewer && !loadNewerTriggeredRef.current) {
          loadNewerTriggeredRef.current = true;
          onLoadNewer();
        } else if (!nearBottom) {
          loadNewerTriggeredRef.current = false;
        }
      }
    },
    [
      atBottomThresholdPx,
      bottomLoadBufferPx,
      hasReachedStart,
      loadingNewer,
      loadingOlder,
      reportVisibleMessageIds,
      stopBottomSettle,
      topLoadBufferPx,
    ],
  );

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'auto') => {
      if (!enabledRef.current) return;
      const scroller = scrollerRef.current;
      if (!scroller) return;
      if (behavior === 'smooth' && typeof scroller.scrollTo === 'function') {
        scroller.scrollTo({ top: scroller.scrollHeight, behavior });
      } else {
        scroller.scrollTop = scroller.scrollHeight;
      }
      previousScrollTopRef.current = scroller.scrollTop;
      const canScroll =
        scroller.scrollHeight > scroller.clientHeight || scroller.scrollHeight === 0;
      updateScrollState({
        allowLoadOlder: !canScroll,
        allowLoadNewer: false,
        allowTopReached: false,
      });
      captureAnchorSnapshot();
    },
    [captureAnchorSnapshot, updateScrollState],
  );

  const startBottomSettle = useCallback(() => {
    if (!enabledRef.current) return;
    stopBottomSettle();
    if (!scrollerRef.current) return;

    bottomSettleActiveRef.current = true;
    bottomSettleFramesRemainingRef.current = INITIAL_BOTTOM_SETTLE_FRAMES;

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        if (bottomSettleActiveRef.current) scrollToBottom('auto');
      });
      bottomSettleResizeObserverRef.current = observer;
      if (scrollerRef.current) observer.observe(scrollerRef.current);
      if (listRef.current) observer.observe(listRef.current);
    }

    bottomSettleTimeoutRef.current = setTimeout(stopBottomSettle, INITIAL_BOTTOM_SETTLE_TIMEOUT_MS);

    const settleFrame = () => {
      if (!bottomSettleActiveRef.current) {
        bottomSettleRafRef.current = null;
        return;
      }
      scrollToBottom('auto');
      bottomSettleFramesRemainingRef.current -= 1;
      if (bottomSettleFramesRemainingRef.current > 0) {
        bottomSettleRafRef.current = requestAnimationFrame(settleFrame);
        return;
      }
      bottomSettleRafRef.current = null;
    };
    bottomSettleRafRef.current = requestAnimationFrame(settleFrame);
  }, [scrollToBottom, stopBottomSettle]);

  const restoreAnchorAfterItemsChange = useCallback(() => {
    const scroller = scrollerRef.current;
    const snapshot = anchorSnapshotRef.current;
    if (!scroller || !snapshot) return false;

    const scrollerTop = scroller.getBoundingClientRect().top;
    for (const anchor of snapshot.anchors) {
      const node = itemRefsRef.current.get(anchor.id);
      if (!node) continue;
      const currentOffsetTop = node.getBoundingClientRect().top - scrollerTop;
      const delta = currentOffsetTop - anchor.offsetTop;
      if (Math.abs(delta) > 0.5) scroller.scrollTop += delta;
      return true;
    }
    return false;
  }, []);

  useLayoutEffect(() => {
    const resetChanged = previousResetKeyRef.current !== resetKey;
    if (resetChanged) {
      previousResetKeyRef.current = resetKey;
      hasInitialScrolledRef.current = false;
      anchorSnapshotRef.current = null;
      stopBottomSettle();
    }

    const currentItemIds = itemIdsRef.current;
    if (!enabled) {
      return;
    }
    if (currentItemIds.length === 0) {
      hasInitialScrolledRef.current = false;
      previousItemIdsRef.current = currentItemIds;
      stopBottomSettle();
      return;
    }

    if (!hasInitialScrolledRef.current) {
      scrollToBottom('auto');
      startBottomSettle();
      hasInitialScrolledRef.current = true;
      previousItemIdsRef.current = currentItemIds;
      return;
    }

    const itemsChanged = !areNumberArraysEqual(previousItemIdsRef.current, currentItemIds);
    if (itemsChanged) {
      if (wasAtBottomBeforeRender === true && isWatchModeRef.current !== false) {
        scrollToBottom('auto');
        startBottomSettle();
      } else {
        restoreAnchorAfterItemsChange();
      }
      updateScrollState({ allowLoadOlder: false, allowLoadNewer: false, allowTopReached: false });
      captureAnchorSnapshot();
      previousItemIdsRef.current = currentItemIds;
      return;
    }

    if (!enabledBeforeRender && enabled) {
      updateScrollState({
        allowLoadOlder: false,
        allowLoadNewer: false,
        allowTopReached: false,
      });
      captureAnchorSnapshot();
    }
  }, [
    captureAnchorSnapshot,
    enabledBeforeRender,
    enabled,
    resetKey,
    restoreAnchorAfterItemsChange,
    scrollToBottom,
    startBottomSettle,
    stopBottomSettle,
    updateScrollState,
    itemIds,
  ]);

  useEffect(() => {
    return () => {
      if (handleScrollRafRef.current !== null) {
        cancelAnimationFrame(handleScrollRafRef.current);
      }
    };
  }, []);

  const handleScroll = useCallback<UIEventHandler<HTMLDivElement>>(() => {
    if (!enabledRef.current) return;
    const scroller = scrollerRef.current;
    if (scroller && bottomSettleActiveRef.current) {
      const bottomDistance = distanceToBottom(scroller);
      const atBottom = bottomDistance <= atBottomThresholdPx;
      if (!atBottom) {
        stopBottomSettle();
      }
    }

    if (handleScrollRafRef.current !== null) return;
    handleScrollRafRef.current = requestAnimationFrame(() => {
      updateScrollState();
      captureAnchorSnapshot();
      handleScrollRafRef.current = null;
    });
  }, [captureAnchorSnapshot, updateScrollState, stopBottomSettle, atBottomThresholdPx]);

  const refCacheRef = useRef<Map<number, (node: HTMLDivElement | null) => void>>(new Map());

  const setItemRef = useCallback((id: number) => {
    let cb = refCacheRef.current.get(id);
    if (!cb) {
      cb = (node: HTMLDivElement | null) => {
        if (node) {
          itemRefsRef.current.set(id, node);
        } else {
          itemRefsRef.current.delete(id);
        }
      };
      refCacheRef.current.set(id, cb);
    }
    return cb;
  }, []);

  return {
    scrollerRef,
    listRef,
    handleScroll,
    setItemRef,
    scrollToBottom,
  };
}
