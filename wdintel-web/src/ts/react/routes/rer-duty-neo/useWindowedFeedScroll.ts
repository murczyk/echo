import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { RefObject, UIEventHandler } from 'react';
import {
  isDutyScrollDebugEnabled,
  recordDutyScrollDebugEvent,
  recordDutyScrollDebugMetrics,
  useDutyScrollDebugEnabled,
} from './duty-scroll-debug';

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

type TopStatus = 'loading' | 'reached-start' | 'none';

export type UseWindowedFeedScrollOptions = {
  itemIds: readonly number[];
  loadingOlder: boolean;
  loadingNewer?: boolean;
  hasReachedStart: boolean;
  onLoadOlder: () => void;
  onLoadNewer?: () => void;
  onScrollToTop?: () => void;
  onReachedBottom?: (context: { hasSeenNotAtBottom: boolean }) => boolean | void;
  onLeftBottom?: () => void;
  onNearBottomChange?: (near: boolean) => void;
  onAtBottomChange?: (atBottom: boolean) => void;
  onPhysicalBottomChange?: (atBottom: boolean) => void;
  onVisibleMessageIds?: (lastVisibleId: number, opts?: { atBottom?: boolean }) => void;
  topLoadBufferPx?: number;
  bottomLoadBufferPx?: number;
  atBottomThresholdPx?: number;
  resetKey?: string | number | null;
  isWatchMode?: boolean;
  enabled?: boolean;
  debugFeedId?: string;
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
  onPhysicalBottomChange,
  onVisibleMessageIds,
  topLoadBufferPx = DEFAULT_TOP_LOAD_BUFFER_PX,
  bottomLoadBufferPx = DEFAULT_BOTTOM_LOAD_BUFFER_PX,
  atBottomThresholdPx = DEFAULT_AT_BOTTOM_THRESHOLD_PX,
  resetKey = null,
  isWatchMode = true,
  enabled = true,
  debugFeedId,
}: UseWindowedFeedScrollOptions): WindowedFeedScrollHandle {
  const debugEnabled = useDutyScrollDebugEnabled();
  const callbacksRef = useRef({
    onLoadOlder,
    onLoadNewer,
    onScrollToTop,
    onReachedBottom,
    onLeftBottom,
    onNearBottomChange,
    onAtBottomChange,
    onPhysicalBottomChange,
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
      onPhysicalBottomChange,
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
  const physicallyAtBottomRef = useRef<boolean | null>(null);
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
  const liveBottomFollowRef = useRef(false);
  const previousItemIdsRef = useRef<readonly number[]>([]);
  const previousResetKeyRef = useRef<string | number | null>(resetKey);
  const topStatus: TopStatus = loadingOlder
    ? 'loading'
    : hasReachedStart
      ? 'reached-start'
      : 'none';
  const previousTopStatusRef = useRef<TopStatus>(topStatus);
  const isWatchModeRef = useRef<boolean>(isWatchMode);
  // Narrow-screen feeds remain mounted while hidden. Disabled tracking must not
  // report visibility, bottom state, loads, or read-state side effects.
  const enabledRef = useRef<boolean>(enabled);
  const enabledBeforeRender = enabledRef.current;
  isWatchModeRef.current = isWatchMode;

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

  const publishDebugMetrics = useCallback(
    (scroller: HTMLDivElement, previousScrollTop: number) => {
      if (!isDutyScrollDebugEnabled() || !debugFeedId) return;
      const bottomDistance = distanceToBottom(scroller);
      const anchors = collectVisibleAnchors();
      const anchor = anchorSnapshotRef.current?.anchors[0] ?? null;
      const computedStyle = window.getComputedStyle(scroller);
      recordDutyScrollDebugMetrics(debugFeedId, {
        capturedAtMs: Date.now(),
        scrollTop: scroller.scrollTop,
        previousScrollTop,
        scrollDelta: scroller.scrollTop - previousScrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        bottomDistance,
        topLoadBufferPx,
        bottomLoadBufferPx,
        atBottomThresholdPx,
        atTop: scroller.scrollTop <= 0,
        atBottom: bottomDistance <= atBottomThresholdPx,
        physicallyAtBottom: bottomDistance <= 1,
        nearBottom: bottomDistance <= bottomLoadBufferPx,
        liveBottomFollow: liveBottomFollowRef.current,
        bottomSettleActive: bottomSettleActiveRef.current,
        loadOlderTriggered: loadOlderTriggeredRef.current,
        loadNewerTriggered: loadNewerTriggeredRef.current,
        visibleAnchorCount: anchors.length,
        firstVisibleId: anchors[0]?.id ?? null,
        lastVisibleId: anchors.at(-1)?.id ?? null,
        anchorId: anchor?.id ?? null,
        anchorOffsetTop: anchor?.offsetTop ?? null,
        itemCount: itemIdsRef.current.length,
        firstItemId: itemIdsRef.current[0] ?? null,
        lastItemId: itemIdsRef.current.at(-1) ?? null,
        enabled: enabledRef.current,
        isWatchMode: isWatchModeRef.current,
        overflowAnchor: computedStyle.overflowAnchor,
        scrollBehavior: computedStyle.scrollBehavior,
      });
    },
    [atBottomThresholdPx, bottomLoadBufferPx, collectVisibleAnchors, debugFeedId, topLoadBufferPx],
  );

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!debugEnabled || !enabled || !scroller) return;
    captureAnchorSnapshot();
    publishDebugMetrics(scroller, previousScrollTopRef.current);
    recordDutyScrollDebugEvent(debugFeedId, 'debug:attach');
  }, [captureAnchorSnapshot, debugEnabled, debugFeedId, enabled, publishDebugMetrics]);

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
    const wasActive = bottomSettleActiveRef.current;
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
    if (wasActive) recordDutyScrollDebugEvent(debugFeedId, 'settle:stop');
  }, [debugFeedId]);

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
      recordDutyScrollDebugEvent(debugFeedId, 'tracking:disable');
      cancelPendingScrollProcessing();
      stopBottomSettle();
      const { onAtBottomChange, onNearBottomChange, onPhysicalBottomChange } = callbacksRef.current;
      if (atBottomRef.current !== false) onAtBottomChange?.(false);
      if (nearBottomRef.current !== false) onNearBottomChange?.(false);
      if (physicallyAtBottomRef.current !== false) onPhysicalBottomChange?.(false);
      atBottomRef.current = false;
      physicallyAtBottomRef.current = false;
      nearBottomRef.current = false;
      liveBottomFollowRef.current = false;
      loadOlderTriggeredRef.current = false;
      loadNewerTriggeredRef.current = false;
    }
  }, [cancelPendingScrollProcessing, debugFeedId, enabled, stopBottomSettle]);

  const updateScrollState = useCallback(
    (
      opts: { allowLoadOlder?: boolean; allowLoadNewer?: boolean; allowTopReached?: boolean } = {},
    ) => {
      if (!enabledRef.current) return;
      const scroller = scrollerRef.current;
      if (!scroller) return;

      const bottomDistance = distanceToBottom(scroller);
      const atBottom = bottomDistance <= atBottomThresholdPx;
      const physicallyAtBottom = bottomDistance <= 1;
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

      if (physicallyAtBottomRef.current !== physicallyAtBottom) {
        const wasPhysicallyAtBottom = physicallyAtBottomRef.current;
        physicallyAtBottomRef.current = physicallyAtBottom;
        callbacksRef.current.onPhysicalBottomChange?.(physicallyAtBottom);
        recordDutyScrollDebugEvent(
          debugFeedId,
          'state:physical-bottom',
          `${wasPhysicallyAtBottom ?? '—'}→${physicallyAtBottom}; distance=${bottomDistance.toFixed(1)}`,
        );
        if (physicallyAtBottom && wasPhysicallyAtBottom !== true) {
          const shouldFollow =
            onReachedBottom?.({ hasSeenNotAtBottom: hasSeenNotAtBottomRef.current }) !== false;
          liveBottomFollowRef.current = shouldFollow;
          recordDutyScrollDebugEvent(
            debugFeedId,
            shouldFollow ? 'follow:enable' : 'follow:blocked',
            `physical bottom reached; returned=${hasSeenNotAtBottomRef.current}`,
          );
        }
      }

      if (nearBottomRef.current !== nearBottom) {
        const previousNearBottom = nearBottomRef.current;
        nearBottomRef.current = nearBottom;
        onNearBottomChange?.(nearBottom);
        recordDutyScrollDebugEvent(
          debugFeedId,
          'state:near-bottom',
          `${previousNearBottom ?? '—'}→${nearBottom}; distance=${bottomDistance.toFixed(1)}; buffer=${bottomLoadBufferPx}`,
        );
      }

      if (bottomSettleActiveRef.current && !atBottom && opts.allowLoadOlder !== false) {
        stopBottomSettle();
      }

      if (wasAtBottom !== atBottom) {
        atBottomRef.current = atBottom;
        onAtBottomChange?.(atBottom);
        recordDutyScrollDebugEvent(
          debugFeedId,
          'state:at-bottom',
          `${wasAtBottom ?? '—'}→${atBottom}; distance=${bottomDistance.toFixed(1)}; threshold=${atBottomThresholdPx}`,
        );
      }
      if (!atBottom) hasSeenNotAtBottomRef.current = true;
      if (wasAtBottom === true && !atBottom) {
        const scrolledUp = currentScrollTop < prevScrollTop - 1;
        if (scrolledUp) {
          liveBottomFollowRef.current = false;
          recordDutyScrollDebugEvent(
            debugFeedId,
            'follow:disable',
            `upward scroll ${prevScrollTop.toFixed(1)}→${currentScrollTop.toFixed(1)}`,
          );
          onLeftBottom?.();
        }
      }

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
          recordDutyScrollDebugEvent(
            debugFeedId,
            'load-older:trigger',
            `scrollTop=${scroller.scrollTop.toFixed(1)}; buffer=${topLoadBufferPx}`,
          );
          onLoadOlder();
        } else if (scroller.scrollTop > topLoadBufferPx) {
          loadOlderTriggeredRef.current = false;
        }
      }

      if (opts.allowLoadNewer !== false) {
        const shouldLoadNewer = nearBottom && !loadingNewer && typeof onLoadNewer === 'function';
        if (shouldLoadNewer && !loadNewerTriggeredRef.current) {
          loadNewerTriggeredRef.current = true;
          recordDutyScrollDebugEvent(
            debugFeedId,
            'load-newer:trigger',
            `distance=${bottomDistance.toFixed(1)}; buffer=${bottomLoadBufferPx}; physical=${physicallyAtBottom}`,
          );
          onLoadNewer();
        } else if (!nearBottom) {
          loadNewerTriggeredRef.current = false;
        }
      }
      publishDebugMetrics(scroller, prevScrollTop);
    },
    [
      atBottomThresholdPx,
      bottomLoadBufferPx,
      debugFeedId,
      hasReachedStart,
      loadingNewer,
      loadingOlder,
      reportVisibleMessageIds,
      publishDebugMetrics,
      stopBottomSettle,
      topLoadBufferPx,
    ],
  );

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'auto', debugReason = 'imperative') => {
      if (!enabledRef.current) return;
      const scroller = scrollerRef.current;
      if (!scroller) return;
      if (behavior === 'smooth' && typeof scroller.scrollTo === 'function') {
        scroller.scrollTo({ top: scroller.scrollHeight, behavior });
      } else {
        scroller.scrollTop = scroller.scrollHeight;
      }
      previousScrollTopRef.current = scroller.scrollTop;
      liveBottomFollowRef.current = true;
      const canScroll =
        scroller.scrollHeight > scroller.clientHeight || scroller.scrollHeight === 0;
      updateScrollState({
        allowLoadOlder: !canScroll,
        allowLoadNewer: false,
        allowTopReached: false,
      });
      captureAnchorSnapshot();
      if (!debugReason.startsWith('settle:')) {
        recordDutyScrollDebugEvent(
          debugFeedId,
          'scroll-to-bottom',
          `${debugReason}; behavior=${behavior}; top=${scroller.scrollTop.toFixed(1)}; height=${scroller.scrollHeight.toFixed(1)}`,
        );
      }
    },
    [captureAnchorSnapshot, debugFeedId, updateScrollState],
  );

  const startBottomSettle = useCallback(() => {
    if (!enabledRef.current) return;
    stopBottomSettle();
    if (!scrollerRef.current) return;

    bottomSettleActiveRef.current = true;
    bottomSettleFramesRemainingRef.current = INITIAL_BOTTOM_SETTLE_FRAMES;
    recordDutyScrollDebugEvent(
      debugFeedId,
      'settle:start',
      `frames=${INITIAL_BOTTOM_SETTLE_FRAMES}; timeout=${INITIAL_BOTTOM_SETTLE_TIMEOUT_MS}`,
    );

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        if (bottomSettleActiveRef.current) scrollToBottom('auto', 'settle:resize');
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
      scrollToBottom('auto', 'settle:frame');
      bottomSettleFramesRemainingRef.current -= 1;
      if (bottomSettleFramesRemainingRef.current > 0) {
        bottomSettleRafRef.current = requestAnimationFrame(settleFrame);
        return;
      }
      bottomSettleRafRef.current = null;
    };
    bottomSettleRafRef.current = requestAnimationFrame(settleFrame);
  }, [debugFeedId, scrollToBottom, stopBottomSettle]);

  const restoreAnchorPosition = useCallback(() => {
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
      recordDutyScrollDebugEvent(
        debugFeedId,
        'anchor:restore',
        `id=${anchor.id}; offset=${anchor.offsetTop.toFixed(1)}; current=${currentOffsetTop.toFixed(1)}; delta=${delta.toFixed(1)}`,
      );
      return true;
    }
    recordDutyScrollDebugEvent(
      debugFeedId,
      'anchor:missing',
      `candidates=${snapshot.anchors.map((anchor) => anchor.id).join(',')}`,
    );
    return false;
  }, [debugFeedId]);

  useLayoutEffect(() => {
    const resetChanged = previousResetKeyRef.current !== resetKey;
    if (resetChanged) {
      recordDutyScrollDebugEvent(
        debugFeedId,
        'feed:reset',
        `${String(previousResetKeyRef.current)}→${String(resetKey)}`,
      );
      previousResetKeyRef.current = resetKey;
      hasInitialScrolledRef.current = false;
      hasSeenNotAtBottomRef.current = false;
      anchorSnapshotRef.current = null;
      stopBottomSettle();
    }

    const currentItemIds = itemIdsRef.current;
    const topStatusChanged = previousTopStatusRef.current !== topStatus;
    if (!enabled) {
      return;
    }
    previousTopStatusRef.current = topStatus;
    if (currentItemIds.length === 0) {
      hasInitialScrolledRef.current = false;
      hasSeenNotAtBottomRef.current = false;
      previousItemIdsRef.current = currentItemIds;
      stopBottomSettle();
      return;
    }

    if (!hasInitialScrolledRef.current) {
      scrollToBottom('auto', 'initial render');
      startBottomSettle();
      liveBottomFollowRef.current = true;
      hasInitialScrolledRef.current = true;
      previousItemIdsRef.current = currentItemIds;
      return;
    }

    const itemsChanged = !areNumberArraysEqual(previousItemIdsRef.current, currentItemIds);
    if (itemsChanged || topStatusChanged) {
      if (
        liveBottomFollowRef.current &&
        physicallyAtBottomRef.current === true &&
        isWatchModeRef.current !== false
      ) {
        recordDutyScrollDebugEvent(
          debugFeedId,
          'items:follow-bottom',
          `${previousItemIdsRef.current.length}→${currentItemIds.length}; watch=${isWatchModeRef.current}`,
        );
        scrollToBottom('auto', 'items changed while following');
        startBottomSettle();
      } else {
        recordDutyScrollDebugEvent(
          debugFeedId,
          'items:preserve-anchor',
          `${previousItemIdsRef.current[0] ?? '—'}→${previousItemIdsRef.current.at(-1) ?? '—'} becomes ${currentItemIds[0] ?? '—'}→${currentItemIds.at(-1) ?? '—'}; follow=${liveBottomFollowRef.current}; physical=${physicallyAtBottomRef.current}; watch=${isWatchModeRef.current}`,
        );
        restoreAnchorPosition();
      }
      updateScrollState({ allowLoadOlder: false, allowLoadNewer: false, allowTopReached: false });
      captureAnchorSnapshot();
      previousItemIdsRef.current = currentItemIds;
      return;
    }

    if (!enabledBeforeRender && enabled) {
      recordDutyScrollDebugEvent(debugFeedId, 'tracking:enable');
      updateScrollState({
        allowLoadOlder: false,
        allowLoadNewer: false,
        allowTopReached: false,
      });
      captureAnchorSnapshot();
    }
  }, [
    captureAnchorSnapshot,
    debugFeedId,
    enabledBeforeRender,
    enabled,
    resetKey,
    restoreAnchorPosition,
    scrollToBottom,
    startBottomSettle,
    stopBottomSettle,
    topStatus,
    updateScrollState,
    itemIds,
  ]);

  useLayoutEffect(() => {
    if (!enabled || itemIds.length === 0 || typeof ResizeObserver === 'undefined') return;
    const list = listRef.current;
    if (!list) return;

    const observer = new ResizeObserver(() => {
      if (!enabledRef.current || bottomSettleActiveRef.current) return;
      if (
        liveBottomFollowRef.current &&
        physicallyAtBottomRef.current === true &&
        isWatchModeRef.current !== false
      ) {
        recordDutyScrollDebugEvent(debugFeedId, 'resize:follow-bottom');
        scrollToBottom('auto', 'list resized while following');
        return;
      }
      recordDutyScrollDebugEvent(debugFeedId, 'resize:preserve-anchor');
      restoreAnchorPosition();
      updateScrollState({ allowLoadOlder: false, allowLoadNewer: false, allowTopReached: false });
      captureAnchorSnapshot();
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [
    captureAnchorSnapshot,
    debugFeedId,
    enabled,
    itemIds.length,
    resetKey,
    restoreAnchorPosition,
    scrollToBottom,
    updateScrollState,
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
    if (scroller && scroller.scrollTop < previousScrollTopRef.current - 1) {
      previousScrollTopRef.current = scroller.scrollTop;
      stopBottomSettle();
      if (liveBottomFollowRef.current) {
        liveBottomFollowRef.current = false;
        recordDutyScrollDebugEvent(
          debugFeedId,
          'follow:disable',
          `immediate upward scroll to ${scroller.scrollTop.toFixed(1)}`,
        );
        callbacksRef.current.onLeftBottom?.();
      }
    } else if (scroller && distanceToBottom(scroller) <= 0.5) {
      liveBottomFollowRef.current = true;
    }
    if (scroller && bottomSettleActiveRef.current) {
      const bottomDistance = distanceToBottom(scroller);
      const physicallyAtBottom = bottomDistance <= 1;
      if (!physicallyAtBottom) {
        stopBottomSettle();
      }
    }

    captureAnchorSnapshot();
    if (handleScrollRafRef.current !== null) return;
    handleScrollRafRef.current = requestAnimationFrame(() => {
      updateScrollState();
      handleScrollRafRef.current = null;
    });
  }, [captureAnchorSnapshot, debugFeedId, updateScrollState, stopBottomSettle]);

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
