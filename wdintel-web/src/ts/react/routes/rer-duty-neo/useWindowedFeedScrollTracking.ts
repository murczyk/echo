import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { recordDutyScrollDebugEvent } from './duty-scroll-debug';
import {
  distanceToBottom,
  effectiveBottomLoadBufferPx,
  FLUSH_PENDING_SCROLL_IDLE_MS,
  LOAD_NEWER_SCROLL_IDLE_MS,
  type ScrollStateOpts,
  type WindowedFeedScrollRefs,
} from './windowed-feed-scroll-shared';

export function useWindowedFeedScrollTracking(args: {
  refs: WindowedFeedScrollRefs;
  debugFeedId?: string;
  enabled: boolean;
  enabledBeforeRender: boolean;
  topLoadBufferPx: number;
  bottomLoadBufferPx: number;
  atBottomThresholdPx: number;
  loadingOlder: boolean;
  loadingNewer: boolean;
  hasReachedStart: boolean;
  unreadPrefetchNeeded: boolean;
  pendingNewerFlushNeeded: boolean;
  captureAnchorSnapshot: () => void;
  publishDebugMetrics: (scroller: HTMLDivElement, previousScrollTop: number) => void;
  reportVisibleMessageIds: (atBottom: boolean) => void;
  stopBottomSettle: () => void;
  clearFollowScroll: () => void;
}) {
  const {
    refs,
    debugFeedId,
    enabled,
    enabledBeforeRender,
    topLoadBufferPx,
    bottomLoadBufferPx,
    atBottomThresholdPx,
    loadingOlder,
    loadingNewer,
    hasReachedStart,
    unreadPrefetchNeeded,
    pendingNewerFlushNeeded,
    captureAnchorSnapshot,
    publishDebugMetrics,
    reportVisibleMessageIds,
    stopBottomSettle,
    clearFollowScroll,
  } = args;

  const cancelPendingScrollProcessing = useCallback(() => {
    if (refs.handleScrollRafRef.current !== null) {
      cancelAnimationFrame(refs.handleScrollRafRef.current);
      refs.handleScrollRafRef.current = null;
    }
    if (refs.reportVisibleMessageIdsRafRef.current !== null) {
      window.clearTimeout(refs.reportVisibleMessageIdsRafRef.current);
      refs.reportVisibleMessageIdsRafRef.current = null;
    }
    if (refs.loadNewerIdleTimeoutRef.current !== null) {
      clearTimeout(refs.loadNewerIdleTimeoutRef.current);
      refs.loadNewerIdleTimeoutRef.current = null;
    }
    if (refs.flushPendingIdleTimeoutRef.current !== null) {
      clearTimeout(refs.flushPendingIdleTimeoutRef.current);
      refs.flushPendingIdleTimeoutRef.current = null;
    }
  }, [refs]);

  const cancelLoadNewerIdle = useCallback(() => {
    if (refs.loadNewerIdleTimeoutRef.current !== null) {
      clearTimeout(refs.loadNewerIdleTimeoutRef.current);
      refs.loadNewerIdleTimeoutRef.current = null;
    }
  }, [refs]);

  const cancelFlushPendingIdle = useCallback(() => {
    if (refs.flushPendingIdleTimeoutRef.current !== null) {
      clearTimeout(refs.flushPendingIdleTimeoutRef.current);
      refs.flushPendingIdleTimeoutRef.current = null;
    }
  }, [refs]);

  const scheduleLoadNewerIdle = useCallback(
    (onLoadNewer: () => void) => {
      cancelLoadNewerIdle();
      refs.loadNewerIdleTimeoutRef.current = setTimeout(() => {
        refs.loadNewerIdleTimeoutRef.current = null;
        if (!refs.enabledRef.current) return;
        if (refs.loadingNewerRef.current) return;
        if (!refs.unreadPrefetchNeededRef.current) {
          refs.loadNewerTriggeredRef.current = false;
          return;
        }
        if (refs.nearBottomRef.current !== true) {
          refs.loadNewerTriggeredRef.current = false;
          return;
        }
        captureAnchorSnapshot();
        recordDutyScrollDebugEvent(
          debugFeedId,
          'load-newer:idle-fire',
          `idleMs=${LOAD_NEWER_SCROLL_IDLE_MS}`,
        );
        onLoadNewer();
      }, LOAD_NEWER_SCROLL_IDLE_MS);
    },
    [cancelLoadNewerIdle, captureAnchorSnapshot, debugFeedId, refs],
  );

  const scheduleFlushPendingIdle = useCallback(() => {
    cancelFlushPendingIdle();
    refs.flushPendingIdleTimeoutRef.current = setTimeout(() => {
      refs.flushPendingIdleTimeoutRef.current = null;
      if (!refs.enabledRef.current) return;
      if (!refs.pendingNewerFlushNeededRef.current) return;
      if (refs.nearBottomRef.current !== true) return;
      const onFlushPendingNewer = refs.callbacksRef.current.onFlushPendingNewer;
      if (typeof onFlushPendingNewer !== 'function') return;
      captureAnchorSnapshot();
      recordDutyScrollDebugEvent(
        debugFeedId,
        'pending-newer:idle-flush',
        `idleMs=${FLUSH_PENDING_SCROLL_IDLE_MS}`,
      );
      onFlushPendingNewer({
        physicallyAtBottom: refs.physicallyAtBottomRef.current === true,
        visibleAnchorIds: refs.anchorSnapshotRef.current?.anchors.map((anchor) => anchor.id) ?? [],
      });
    }, FLUSH_PENDING_SCROLL_IDLE_MS);
  }, [cancelFlushPendingIdle, captureAnchorSnapshot, debugFeedId, refs]);

  const clearReportedScrollTrackingState = useCallback(
    (reason: 'disable' | 'unmount') => {
      recordDutyScrollDebugEvent(
        debugFeedId,
        reason === 'disable' ? 'tracking:disable' : 'tracking:unmount',
      );
      cancelPendingScrollProcessing();
      stopBottomSettle();
      clearFollowScroll();
      const { onAtBottomChange, onNearBottomChange, onPhysicalBottomChange } =
        refs.callbacksRef.current;
      if (refs.atBottomRef.current !== false) onAtBottomChange?.(false);
      if (refs.nearBottomRef.current !== false) onNearBottomChange?.(false);
      if (refs.physicallyAtBottomRef.current !== false) onPhysicalBottomChange?.(false);
      refs.atBottomRef.current = false;
      refs.physicallyAtBottomRef.current = false;
      refs.nearBottomRef.current = false;
      refs.liveBottomFollowRef.current = false;
      refs.preserveBottomAnchorRef.current = false;
      refs.loadOlderTriggeredRef.current = false;
      refs.loadNewerTriggeredRef.current = false;
    },
    [cancelPendingScrollProcessing, clearFollowScroll, debugFeedId, refs, stopBottomSettle],
  );

  useLayoutEffect(() => {
    refs.enabledRef.current = enabled;

    if (enabledBeforeRender && !enabled) {
      clearReportedScrollTrackingState('disable');
    }
  }, [clearReportedScrollTrackingState, enabled, enabledBeforeRender, refs]);

  const updateScrollState = useCallback(
    (opts: ScrollStateOpts = {}) => {
      if (!refs.enabledRef.current) return;
      const scroller = refs.scrollerRef.current;
      if (!scroller) return;

      const bottomDistance = distanceToBottom(scroller);
      const atBottom = bottomDistance <= atBottomThresholdPx;
      const physicallyAtBottom = bottomDistance <= 1;
      const bottomBufferPx = effectiveBottomLoadBufferPx(
        scroller,
        bottomLoadBufferPx,
        unreadPrefetchNeeded,
      );
      const nearBottom = bottomDistance <= bottomBufferPx;
      const atTop = scroller.scrollTop <= 0;
      const wasAtBottom = refs.atBottomRef.current;
      const currentScrollTop = scroller.scrollTop;
      const prevScrollTop = refs.previousScrollTopRef.current;
      refs.previousScrollTopRef.current = currentScrollTop;

      const {
        onNearBottomChange,
        onAtBottomChange,
        onLeftBottom,
        onReachedBottom,
        onScrollToTop,
        onLoadOlder,
        onLoadNewer,
      } = refs.callbacksRef.current;

      if (refs.physicallyAtBottomRef.current !== physicallyAtBottom) {
        const wasPhysicallyAtBottom = refs.physicallyAtBottomRef.current;
        refs.physicallyAtBottomRef.current = physicallyAtBottom;
        refs.callbacksRef.current.onPhysicalBottomChange?.(physicallyAtBottom);
        recordDutyScrollDebugEvent(
          debugFeedId,
          'state:physical-bottom',
          `${wasPhysicallyAtBottom ?? '—'}→${physicallyAtBottom}; distance=${bottomDistance.toFixed(1)}`,
        );
        if (physicallyAtBottom && wasPhysicallyAtBottom !== true) {
          if (!refs.autoScrollAllowedRef.current) {
            refs.liveBottomFollowRef.current = false;
          } else {
            const shouldFollow =
              onReachedBottom?.({
                hasSeenNotAtBottom: refs.hasSeenNotAtBottomRef.current,
                navigationIntent: opts.navigationIntent ?? null,
              }) !== false;
            refs.liveBottomFollowRef.current = shouldFollow;
            refs.preserveBottomAnchorRef.current =
              !shouldFollow && opts.navigationIntent === undefined;
            recordDutyScrollDebugEvent(
              debugFeedId,
              shouldFollow ? 'follow:enable' : 'follow:blocked',
              `physical bottom reached; returned=${refs.hasSeenNotAtBottomRef.current}`,
            );
          }
        } else {
          refs.preserveBottomAnchorRef.current = false;
        }
      }

      if (refs.nearBottomRef.current !== nearBottom) {
        const previousNearBottom = refs.nearBottomRef.current;
        refs.nearBottomRef.current = nearBottom;
        onNearBottomChange?.(nearBottom);
        recordDutyScrollDebugEvent(
          debugFeedId,
          'state:near-bottom',
          `${previousNearBottom ?? '—'}→${nearBottom}; distance=${bottomDistance.toFixed(1)}; buffer=${bottomBufferPx}`,
        );
      }

      if (refs.bottomSettleActiveRef.current && !atBottom && opts.allowLoadOlder !== false) {
        stopBottomSettle();
      }

      if (wasAtBottom !== atBottom) {
        refs.atBottomRef.current = atBottom;
        onAtBottomChange?.(atBottom);
        recordDutyScrollDebugEvent(
          debugFeedId,
          'state:at-bottom',
          `${wasAtBottom ?? '—'}→${atBottom}; distance=${bottomDistance.toFixed(1)}; threshold=${atBottomThresholdPx}`,
        );
      }
      if (!atBottom) refs.hasSeenNotAtBottomRef.current = true;
      if (wasAtBottom === true && !atBottom) {
        const scrolledUp = currentScrollTop < prevScrollTop - 1;
        if (scrolledUp) {
          refs.liveBottomFollowRef.current = false;
          recordDutyScrollDebugEvent(
            debugFeedId,
            'follow:disable',
            `upward scroll ${prevScrollTop.toFixed(1)}→${currentScrollTop.toFixed(1)}`,
          );
          onLeftBottom?.();
        }
      }

      if (opts.allowTopReached !== false && refs.atTopRef.current !== atTop) {
        refs.atTopRef.current = atTop;
        if (atTop) onScrollToTop?.();
      }

      reportVisibleMessageIds(atBottom);

      if (opts.allowLoadOlder !== false) {
        const shouldLoadOlder =
          scroller.scrollTop <= topLoadBufferPx && !loadingOlder && !hasReachedStart;
        if (shouldLoadOlder && !refs.loadOlderTriggeredRef.current) {
          refs.loadOlderTriggeredRef.current = true;
          captureAnchorSnapshot();
          recordDutyScrollDebugEvent(
            debugFeedId,
            'load-older:trigger',
            `scrollTop=${scroller.scrollTop.toFixed(1)}; buffer=${topLoadBufferPx}`,
          );
          onLoadOlder();
        } else if (scroller.scrollTop > topLoadBufferPx) {
          refs.loadOlderTriggeredRef.current = false;
        }
      }

      if (opts.allowLoadNewer !== false) {
        const shouldLoadNewer =
          nearBottom && unreadPrefetchNeeded && !loadingNewer && typeof onLoadNewer === 'function';
        if (shouldLoadNewer && !refs.loadNewerTriggeredRef.current) {
          refs.loadNewerTriggeredRef.current = true;
          captureAnchorSnapshot();
          recordDutyScrollDebugEvent(
            debugFeedId,
            'load-newer:trigger',
            `distance=${bottomDistance.toFixed(1)}; buffer=${bottomBufferPx}; physical=${physicallyAtBottom}; prefetch=${unreadPrefetchNeeded}; idle=${!physicallyAtBottom}`,
          );
          // At the physical end, load immediately. Otherwise wait for scroll idle so a
          // mid-fling newer commit does not freeze the main thread / teleport the viewport.
          if (physicallyAtBottom) {
            cancelLoadNewerIdle();
            onLoadNewer();
          } else {
            scheduleLoadNewerIdle(onLoadNewer);
          }
        } else if (shouldLoadNewer && refs.loadNewerIdleTimeoutRef.current != null) {
          // Still scrolling in the zone — keep deferring until idle.
          scheduleLoadNewerIdle(onLoadNewer);
        } else if (!nearBottom || !unreadPrefetchNeeded) {
          cancelLoadNewerIdle();
          refs.loadNewerTriggeredRef.current = false;
        }
      }

      // Push buffered newer pages into the window after scroll settles near the live edge.
      // At the physical bottom, flush immediately — idle deferral left pending stuck off-DOM.
      const shouldFlushPending =
        nearBottom &&
        pendingNewerFlushNeeded &&
        (opts.allowPendingFlush === true ||
          refs.autoScrollAllowedRef.current ||
          physicallyAtBottom) &&
        typeof refs.callbacksRef.current.onFlushPendingNewer === 'function';
      if (shouldFlushPending) {
        if (physicallyAtBottom) {
          cancelFlushPendingIdle();
          captureAnchorSnapshot();
          recordDutyScrollDebugEvent(debugFeedId, 'pending-newer:physical-flush', '');
          refs.callbacksRef.current.onFlushPendingNewer?.({
            physicallyAtBottom: true,
            visibleAnchorIds:
              refs.anchorSnapshotRef.current?.anchors.map((anchor) => anchor.id) ?? [],
          });
        } else if (!physicallyAtBottom) {
          scheduleFlushPendingIdle();
        } else {
          cancelFlushPendingIdle();
        }
      } else {
        cancelFlushPendingIdle();
      }

      publishDebugMetrics(scroller, prevScrollTop);
    },
    [
      atBottomThresholdPx,
      bottomLoadBufferPx,
      captureAnchorSnapshot,
      cancelFlushPendingIdle,
      cancelLoadNewerIdle,
      debugFeedId,
      hasReachedStart,
      loadingNewer,
      loadingOlder,
      pendingNewerFlushNeeded,
      publishDebugMetrics,
      refs,
      reportVisibleMessageIds,
      scheduleFlushPendingIdle,
      scheduleLoadNewerIdle,
      stopBottomSettle,
      topLoadBufferPx,
      unreadPrefetchNeeded,
    ],
  );

  const prevUnreadPrefetchNeededRef = useRef(unreadPrefetchNeeded);
  const prevPendingNewerFlushNeededRef = useRef(pendingNewerFlushNeeded);

  useEffect(() => {
    const wasNeeded = prevUnreadPrefetchNeededRef.current;
    prevUnreadPrefetchNeededRef.current = unreadPrefetchNeeded;
    if (!unreadPrefetchNeeded) {
      // A concurrent physical-bottom / onReachedBottom load may have already filled
      // the runway while a near-bottom idle timer was still armed.
      cancelLoadNewerIdle();
      refs.loadNewerTriggeredRef.current = false;
      return;
    }
    if (!refs.enabledRef.current) return;
    refs.loadNewerTriggeredRef.current = false;
    // Only re-evaluate when prefetch becomes needed again — not on the initial mount
    // (initial bottom pin intentionally suppresses load-newer).
    if (!wasNeeded) {
      updateScrollState({ allowLoadOlder: false, allowTopReached: false });
    }
  }, [cancelLoadNewerIdle, refs, unreadPrefetchNeeded, updateScrollState]);

  useEffect(() => {
    const wasNeeded = prevPendingNewerFlushNeededRef.current;
    prevPendingNewerFlushNeededRef.current = pendingNewerFlushNeeded;
    if (!pendingNewerFlushNeeded) {
      cancelFlushPendingIdle();
      return;
    }
    if (!refs.enabledRef.current) return;
    // Pending arrived while already near-bottom / idle — arm the flush timer.
    if (!wasNeeded) {
      updateScrollState({ allowLoadOlder: false, allowLoadNewer: false, allowTopReached: false });
    }
  }, [cancelFlushPendingIdle, pendingNewerFlushNeeded, refs, updateScrollState]);

  return useMemo(
    () => ({ updateScrollState, clearReportedScrollTrackingState }),
    [clearReportedScrollTrackingState, updateScrollState],
  );
}
