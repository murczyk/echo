import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { RefObject, UIEventHandler } from 'react';

export type WindowedFeedScrollItem = { id: number };

type VisibleAnchor = {
  id: number;
  index: number;
  offsetTop: number;
};

type AnchorSnapshot = {
  anchors: VisibleAnchor[];
};

export type UseWindowedFeedScrollOptions = {
  items: readonly WindowedFeedScrollItem[];
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
  onVisibleMessageIds?: (ids: number[], opts?: { atBottom?: boolean }) => void;
  topLoadBufferPx?: number;
  bottomLoadBufferPx?: number;
  atBottomThresholdPx?: number;
  resetKey?: string | number | null;
};

export type WindowedFeedScrollHandle = {
  scrollerRef: RefObject<HTMLDivElement>;
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
  items,
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
}: UseWindowedFeedScrollOptions): WindowedFeedScrollHandle {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const itemRefsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const loadOlderTriggeredRef = useRef(false);
  const loadNewerTriggeredRef = useRef(false);
  const hasSeenNotAtBottomRef = useRef(false);
  const atBottomRef = useRef<boolean | null>(null);
  const nearBottomRef = useRef<boolean | null>(null);
  const atTopRef = useRef<boolean | null>(null);
  const anchorSnapshotRef = useRef<AnchorSnapshot | null>(null);
  const hasInitialScrolledRef = useRef(false);
  const bottomSettleActiveRef = useRef(false);
  const bottomSettleFramesRemainingRef = useRef(0);
  const bottomSettleRafRef = useRef<number | null>(null);
  const bottomSettleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bottomSettleResizeObserverRef = useRef<ResizeObserver | null>(null);
  const previousItemsKeyRef = useRef('');
  const previousResetKeyRef = useRef<string | number | null>(resetKey);

  const itemIds = useMemo(() => items.map(({ id }) => id), [items]);
  const itemIdsRef = useRef<number[]>(itemIds);
  itemIdsRef.current = itemIds;
  const itemsKey = useMemo(() => itemIds.join(','), [itemIds]);

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

    return itemIdsRef.current.flatMap((id, index) => {
      const node = itemRefsRef.current.get(id);
      if (!node) return [];
      const rect = node.getBoundingClientRect();
      if (rect.bottom < scrollerTop || rect.top > scrollerBottom) return [];
      return [{ id, index, offsetTop: rect.top - scrollerTop }];
    });
  }, []);

  const captureAnchorSnapshot = useCallback(() => {
    const anchors = collectVisibleAnchors();
    anchorSnapshotRef.current = anchors.length > 0 ? { anchors } : null;
  }, [collectVisibleAnchors]);

  const reportVisibleMessageIds = useCallback(
    (atBottom: boolean) => {
      if (!onVisibleMessageIds || itemIdsRef.current.length === 0) return;
      if (atBottom) {
        onVisibleMessageIds(itemIdsRef.current, { atBottom: true });
        return;
      }

      const anchors = collectVisibleAnchors();
      const lastVisibleIndex = anchors.reduce(
        (max, anchor) => Math.max(max, anchor.index),
        -1,
      );
      if (lastVisibleIndex < 0) return;
      onVisibleMessageIds(itemIdsRef.current.slice(0, lastVisibleIndex + 1), { atBottom: false });
    },
    [collectVisibleAnchors, onVisibleMessageIds],
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

  const updateScrollState = useCallback(
    (opts: { allowLoadOlder?: boolean; allowTopReached?: boolean } = {}) => {
      const scroller = scrollerRef.current;
      if (!scroller) return;

      const bottomDistance = distanceToBottom(scroller);
      const atBottom = bottomDistance <= atBottomThresholdPx;
      const nearBottom = bottomDistance <= bottomLoadBufferPx;
      const atTop = scroller.scrollTop <= 0;
      const wasAtBottom = atBottomRef.current;

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
      if (wasAtBottom === true && !atBottom) onLeftBottom?.();
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
      onAtBottomChange,
      onLeftBottom,
      onLoadNewer,
      onLoadOlder,
      onNearBottomChange,
      onReachedBottom,
      onScrollToTop,
      reportVisibleMessageIds,
      stopBottomSettle,
      topLoadBufferPx,
    ],
  );

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'auto') => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      if (behavior === 'smooth' && typeof scroller.scrollTo === 'function') {
        scroller.scrollTo({ top: scroller.scrollHeight, behavior });
      } else {
        scroller.scrollTop = scroller.scrollHeight;
      }
      updateScrollState({ allowLoadOlder: false, allowTopReached: false });
      captureAnchorSnapshot();
    },
    [captureAnchorSnapshot, updateScrollState],
  );

  const startBottomSettle = useCallback(() => {
    stopBottomSettle();
    if (!scrollerRef.current) return;

    bottomSettleActiveRef.current = true;
    bottomSettleFramesRemainingRef.current = INITIAL_BOTTOM_SETTLE_FRAMES;

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        if (bottomSettleActiveRef.current) scrollToBottom('auto');
      });
      bottomSettleResizeObserverRef.current = observer;
      observer.observe(scrollerRef.current);
      itemRefsRef.current.forEach((node) => observer.observe(node));
    }

    bottomSettleTimeoutRef.current = setTimeout(
      stopBottomSettle,
      INITIAL_BOTTOM_SETTLE_TIMEOUT_MS,
    );

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

    if (itemIdsRef.current.length === 0) {
      hasInitialScrolledRef.current = false;
      previousItemsKeyRef.current = itemsKey;
      stopBottomSettle();
      return;
    }

    if (!hasInitialScrolledRef.current) {
      scrollToBottom('auto');
      startBottomSettle();
      hasInitialScrolledRef.current = true;
      previousItemsKeyRef.current = itemsKey;
      return;
    }

    if (previousItemsKeyRef.current !== itemsKey) {
      restoreAnchorAfterItemsChange();
      updateScrollState({ allowLoadOlder: false, allowTopReached: false });
      captureAnchorSnapshot();
      previousItemsKeyRef.current = itemsKey;
    }
  }, [
    captureAnchorSnapshot,
    itemsKey,
    resetKey,
    restoreAnchorAfterItemsChange,
    scrollToBottom,
    startBottomSettle,
    stopBottomSettle,
    updateScrollState,
  ]);

  const handleScroll = useCallback<UIEventHandler<HTMLDivElement>>(() => {
    updateScrollState();
    captureAnchorSnapshot();
  }, [captureAnchorSnapshot, updateScrollState]);

  const setItemRef = useCallback(
    (id: number) => (node: HTMLDivElement | null) => {
      if (node) {
        itemRefsRef.current.set(id, node);
        return;
      }
      itemRefsRef.current.delete(id);
    },
    [],
  );

  return {
    scrollerRef,
    handleScroll,
    setItemRef,
    scrollToBottom,
  };
}
