import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFeedScrollDiagnostics } from '../internal/diagnostics';
import {
  distanceToBottom,
  effectiveBottomLoadBufferPx,
  FLUSH_PENDING_SCROLL_IDLE_MS,
  isAtPhysicalBottom,
  LOAD_NEWER_SCROLL_IDLE_MS,
} from '../internal/scroll-math';
import type { ScrollStateOpts, WindowedFeedScrollRefs } from '../internal/internal.types';

function edgeSkeletonVisible(scroller: HTMLElement, position: 'above' | 'below'): boolean | null {
  const skeleton = scroller.querySelector<HTMLElement>(
    `[data-message-feed-skeleton="${position}"]`,
  );
  if (!skeleton) return null;
  const viewport = scroller.getBoundingClientRect();
  const edge = skeleton.getBoundingClientRect();
  return edge.bottom > viewport.top && edge.top < viewport.bottom;
}

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
  immediateBelowLoad: boolean;
  expandBelowLoadBuffer: boolean;
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
    immediateBelowLoad,
    expandBelowLoadBuffer,
    captureAnchorSnapshot,
    publishDebugMetrics,
    reportVisibleMessageIds,
    stopBottomSettle,
    clearFollowScroll,
  } = args;

  const { event: recordScrollDebugEvent } = useFeedScrollDiagnostics(refs);
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
    (onLoadNewer: () => void | Promise<unknown>) => {
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
        recordScrollDebugEvent(
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
      recordScrollDebugEvent(
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
      recordScrollDebugEvent(
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
      if (!scroller || scroller.clientHeight <= 0) return;

      const bottomDistance = distanceToBottom(scroller);
      const atBottom = bottomDistance <= atBottomThresholdPx;
      const physicallyAtBottom = isAtPhysicalBottom(scroller);
      const bottomBufferPx = expandBelowLoadBuffer
        ? effectiveBottomLoadBufferPx(scroller, bottomLoadBufferPx, unreadPrefetchNeeded)
        : bottomLoadBufferPx;
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
        recordScrollDebugEvent(
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
            recordScrollDebugEvent(
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
        recordScrollDebugEvent(
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
        recordScrollDebugEvent(
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
          recordScrollDebugEvent(
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
        const aboveSkeletonVisible = edgeSkeletonVisible(scroller, 'above');
        const reachedAbove = aboveSkeletonVisible ?? scroller.scrollTop <= topLoadBufferPx;
        const shouldLoadOlder = reachedAbove && !loadingOlder && !hasReachedStart;
        if (shouldLoadOlder && !refs.loadOlderTriggeredRef.current) {
          refs.loadOlderTriggeredRef.current = true;
          captureAnchorSnapshot();
          recordScrollDebugEvent(
            debugFeedId,
            'load-older:trigger',
            `scrollTop=${scroller.scrollTop.toFixed(1)}; buffer=${topLoadBufferPx}`,
          );
          onLoadOlder();
        } else if (!reachedAbove) {
          refs.loadOlderTriggeredRef.current = false;
        }
      }

      if (opts.allowLoadNewer !== false) {
        const belowSkeletonVisible = edgeSkeletonVisible(scroller, 'below');
        const reachedBelow = belowSkeletonVisible ?? nearBottom;
        const shouldLoadNewer =
          reachedBelow &&
          unreadPrefetchNeeded &&
          !loadingNewer &&
          typeof onLoadNewer === 'function';
        if (shouldLoadNewer && !refs.loadNewerTriggeredRef.current) {
          refs.loadNewerTriggeredRef.current = true;
          captureAnchorSnapshot();
          recordScrollDebugEvent(
            debugFeedId,
            'load-newer:trigger',
            `distance=${bottomDistance.toFixed(1)}; buffer=${bottomBufferPx}; physical=${physicallyAtBottom}; prefetch=${unreadPrefetchNeeded}; idle=${!physicallyAtBottom}`,
          );
          // A visible edge skeleton or the physical end loads immediately. Otherwise
          // wait for scroll idle so a mid-fling commit does not teleport the viewport.
          if (belowSkeletonVisible || physicallyAtBottom || immediateBelowLoad) {
            cancelLoadNewerIdle();
            onLoadNewer();
          } else {
            scheduleLoadNewerIdle(onLoadNewer);
          }
        } else if (shouldLoadNewer && refs.loadNewerIdleTimeoutRef.current != null) {
          // Still scrolling in the zone — keep deferring until idle.
          scheduleLoadNewerIdle(onLoadNewer);
        } else if (!reachedBelow || !unreadPrefetchNeeded) {
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
          recordScrollDebugEvent(debugFeedId, 'pending-newer:physical-flush', '');
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
      immediateBelowLoad,
      expandBelowLoadBuffer,
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
