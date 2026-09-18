import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { UIEventHandler } from 'react';
import { recordDutyScrollDebugEvent, useDutyScrollDebugEnabled } from './duty-scroll-debug';
import { useWindowedFeedScrollAnchors } from './useWindowedFeedScrollAnchors';
import { useWindowedFeedScrollRefs } from './useWindowedFeedScrollRefs';
import { useWindowedFeedScrollFollow } from './useWindowedFeedScrollFollow';
import { useWindowedFeedScrollTracking } from './useWindowedFeedScrollTracking';
import {
  areNumberArraysEqual,
  DEFAULT_AT_BOTTOM_THRESHOLD_PX,
  DEFAULT_BOTTOM_LOAD_BUFFER_PX,
  DEFAULT_TOP_LOAD_BUFFER_PX,
  distanceToBottom,
  nowMs,
  ScrollNavigationIntent,
  type ScrollStateOpts,
  type TopStatus,
  type UseWindowedFeedScrollOptions,
  type WindowedFeedScrollHandle,
} from './windowed-feed-scroll-shared';

export type {
  UseWindowedFeedScrollOptions,
  WindowedFeedScrollHandle,
  WindowedFeedScrollItem,
} from './windowed-feed-scroll-shared';

const ANCHOR_RESTORE_LAYOUT_STABLE_FRAMES = 3;

function centeredItemScrollTop(scroller: HTMLElement, target: HTMLElement): number {
  const scrollerRect = scroller.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const renderedScale =
    scroller.clientHeight > 0 && scrollerRect.height > 0
      ? scrollerRect.height / scroller.clientHeight
      : 1;
  const currentOffset = targetRect.top - scrollerRect.top;
  const centeredOffset = (scrollerRect.height - targetRect.height) / 2;
  return scroller.scrollTop + (currentOffset - centeredOffset) / renderedScale;
}

function isItemFullyVisible(scroller: HTMLElement, target: HTMLElement): boolean {
  const scrollerRect = scroller.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  return targetRect.top >= scrollerRect.top - 1 && targetRect.bottom <= scrollerRect.bottom + 1;
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
  autoScrollAllowed = true,
  initialPositioningReady = true,
  enabled = true,
  debugFeedId,
  unreadPrefetchNeeded = true,
  pendingNewerFlushNeeded = false,
  onFlushPendingNewer,
}: UseWindowedFeedScrollOptions): WindowedFeedScrollHandle {
  const debugEnabled = useDutyScrollDebugEnabled();
  const topStatus: TopStatus = loadingOlder
    ? 'loading'
    : hasReachedStart
      ? 'reached-start'
      : 'none';
  const refs = useWindowedFeedScrollRefs({
    resetKey,
    topStatus,
    isWatchMode,
    autoScrollAllowed,
    loadingNewer,
    unreadPrefetchNeeded,
    pendingNewerFlushNeeded,
    enabled,
  });
  const enabledBeforeRender = refs.enabledRef.current;
  refs.isWatchModeRef.current = isWatchMode;
  refs.autoScrollAllowedRef.current = autoScrollAllowed;
  refs.loadingNewerRef.current = loadingNewer;
  refs.unreadPrefetchNeededRef.current = unreadPrefetchNeeded;
  refs.pendingNewerFlushNeededRef.current = pendingNewerFlushNeeded;
  refs.itemIdsRef.current = itemIds;

  useLayoutEffect(() => {
    refs.callbacksRef.current = {
      onLoadOlder,
      onLoadNewer,
      onFlushPendingNewer,
      onScrollToTop,
      onReachedBottom,
      onLeftBottom,
      onNearBottomChange,
      onAtBottomChange,
      onPhysicalBottomChange,
      onVisibleMessageIds,
    };
  });

  const refCacheRef = useRef<Map<number, (node: HTMLDivElement | null) => void>>(new Map());
  useLayoutEffect(() => {
    const activeIds = new Set(itemIds);
    for (const id of refCacheRef.current.keys()) {
      if (!activeIds.has(id)) refCacheRef.current.delete(id);
    }
    for (const id of refs.itemRefsRef.current.keys()) {
      if (!activeIds.has(id)) refs.itemRefsRef.current.delete(id);
    }
  }, [itemIds, refs]);

  useEffect(() => {
    if (!loadingOlder) refs.loadOlderTriggeredRef.current = false;
  }, [loadingOlder, refs]);

  useEffect(() => {
    if (!loadingNewer) refs.loadNewerTriggeredRef.current = false;
  }, [loadingNewer, refs]);

  const lastItemId = itemIds.length > 0 ? itemIds[itemIds.length - 1] : null;
  useEffect(() => {
    refs.loadNewerTriggeredRef.current = false;
  }, [lastItemId, refs]);

  const anchors = useWindowedFeedScrollAnchors({
    refs,
    debugFeedId,
    topLoadBufferPx,
    bottomLoadBufferPx,
    atBottomThresholdPx,
    unreadPrefetchNeeded,
  });

  useLayoutEffect(() => {
    const scroller = refs.scrollerRef.current;
    if (!debugEnabled || !enabled || !scroller) return;
    anchors.captureAnchorSnapshot();
    anchors.publishDebugMetrics(scroller, refs.previousScrollTopRef.current);
    recordDutyScrollDebugEvent(debugFeedId, 'debug:attach');
  }, [anchors, debugEnabled, debugFeedId, enabled, refs]);

  const updateScrollStateRef = useRef<(opts?: ScrollStateOpts) => void>(() => undefined);
  const updateScrollStateStable = useCallback((opts?: ScrollStateOpts) => {
    updateScrollStateRef.current(opts);
  }, []);

  const follow = useWindowedFeedScrollFollow({
    refs,
    debugFeedId,
    captureAnchorSnapshot: anchors.captureAnchorSnapshot,
    updateScrollState: updateScrollStateStable,
  });

  const tracking = useWindowedFeedScrollTracking({
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
    captureAnchorSnapshot: anchors.captureAnchorSnapshot,
    publishDebugMetrics: anchors.publishDebugMetrics,
    reportVisibleMessageIds: anchors.reportVisibleMessageIds,
    stopBottomSettle: follow.stopBottomSettle,
    clearFollowScroll: follow.clearFollowScroll,
  });
  updateScrollStateRef.current = tracking.updateScrollState;

  const pendingAnchorRestoreRafRef = useRef<number | null>(null);
  const stopPendingAnchorRestore = useCallback(() => {
    if (pendingAnchorRestoreRafRef.current === null) return;
    cancelAnimationFrame(pendingAnchorRestoreRafRef.current);
    pendingAnchorRestoreRafRef.current = null;
  }, []);
  const schedulePendingAnchorRestore = useCallback(() => {
    stopPendingAnchorRestore();
    const scroller = refs.scrollerRef.current;
    if (!refs.enabledRef.current || !scroller) return;
    let lastHeight = scroller.scrollHeight;
    let stableFrames = 0;

    const tick = () => {
      pendingAnchorRestoreRafRef.current = null;
      const active = refs.scrollerRef.current;
      if (!refs.enabledRef.current || !active) return;
      if (Math.abs(active.scrollHeight - lastHeight) <= 0.5) {
        stableFrames += 1;
      } else {
        lastHeight = active.scrollHeight;
        stableFrames = 0;
      }
      if (stableFrames < ANCHOR_RESTORE_LAYOUT_STABLE_FRAMES) {
        pendingAnchorRestoreRafRef.current = requestAnimationFrame(tick);
        return;
      }

      const restoreOutcome = anchors.restoreAnchorPosition({
        settleSynchronousLayout: true,
        settleUpperClamp: true,
      });
      if (restoreOutcome === 'pending') {
        lastHeight = active.scrollHeight;
        stableFrames = 0;
        pendingAnchorRestoreRafRef.current = requestAnimationFrame(tick);
        return;
      }
      tracking.updateScrollState({
        allowLoadOlder: false,
        allowLoadNewer: false,
        allowTopReached: false,
      });
      anchors.captureAnchorSnapshot();
      recordDutyScrollDebugEvent(
        debugFeedId,
        'anchor:settle-complete',
        `height=${active.scrollHeight.toFixed(1)}; frames=${stableFrames}`,
      );
    };

    pendingAnchorRestoreRafRef.current = requestAnimationFrame(tick);
  }, [anchors, debugFeedId, refs, stopPendingAnchorRestore, tracking]);
  useEffect(() => stopPendingAnchorRestore, [stopPendingAnchorRestore]);

  const directItemTargetIdRef = useRef<number | null>(null);
  const directItemCenterRafRef = useRef<number | null>(null);

  const stopDirectItemTracking = useCallback(() => {
    const wasActive =
      directItemTargetIdRef.current !== null || directItemCenterRafRef.current !== null;
    directItemTargetIdRef.current = null;
    if (directItemCenterRafRef.current !== null) {
      cancelAnimationFrame(directItemCenterRafRef.current);
      directItemCenterRafRef.current = null;
    }
    if (wasActive) refs.anchorSnapshotRef.current = null;
    if (wasActive) recordDutyScrollDebugEvent(debugFeedId, 'item-tracking:stop');
  }, [debugFeedId, refs]);

  useEffect(() => stopDirectItemTracking, [stopDirectItemTracking]);

  useEffect(() => {
    const targetId = directItemTargetIdRef.current;
    if (targetId !== null && !itemIds.includes(targetId)) {
      stopDirectItemTracking();
    }
  }, [itemIds, stopDirectItemTracking]);

  const centerTrackedItem = useCallback(
    (reason: string): HTMLElement | null => {
      const id = directItemTargetIdRef.current;
      const scroller = refs.scrollerRef.current;
      const target = id == null ? null : refs.itemRefsRef.current.get(id);
      if (!refs.enabledRef.current || !scroller || !target) return null;

      scroller.scrollTop = Math.max(0, centeredItemScrollTop(scroller, target));
      refs.previousScrollTopRef.current = scroller.scrollTop;
      anchors.captureAnchorSnapshot();
      recordDutyScrollDebugEvent(
        debugFeedId,
        'item-tracking:center',
        `id=${id}; reason=${reason}; top=${scroller.scrollTop.toFixed(1)}`,
      );
      return target;
    },
    [anchors, debugFeedId, refs],
  );

  const scheduleTrackedItemCenter = useCallback(
    (reason: string) => {
      if (directItemTargetIdRef.current === null || directItemCenterRafRef.current !== null) return;
      directItemCenterRafRef.current = requestAnimationFrame(() => {
        directItemCenterRafRef.current = null;
        centerTrackedItem(reason);
      });
    },
    [centerTrackedItem],
  );

  const scrollToItem = useCallback(
    (id: number, behavior: ScrollBehavior = 'auto') => {
      if (!refs.enabledRef.current) return null;
      const scroller = refs.scrollerRef.current;
      const target = refs.itemRefsRef.current.get(id);
      if (!scroller || !target) return null;

      refs.hasInitialScrolledRef.current = true;
      stopDirectItemTracking();
      if (isItemFullyVisible(scroller, target)) {
        recordDutyScrollDebugEvent(
          debugFeedId,
          'scroll-to-item:already-visible',
          `id=${id}; top=${scroller.scrollTop.toFixed(1)}`,
        );
        return target;
      }

      follow.stopBottomSettle();
      directItemTargetIdRef.current = id;
      refs.liveBottomFollowRef.current = false;
      refs.physicallyAtBottomRef.current = false;
      refs.callbacksRef.current.onPhysicalBottomChange?.(false);

      if (behavior === 'smooth' && typeof scroller.scrollTo === 'function') {
        const targetTop = Math.max(0, centeredItemScrollTop(scroller, target));
        scroller.scrollTo({ top: targetTop, behavior });
      } else {
        centerTrackedItem('imperative');
      }
      refs.previousScrollTopRef.current = scroller.scrollTop;
      tracking.updateScrollState({
        allowLoadOlder: false,
        allowLoadNewer: false,
        allowTopReached: false,
      });
      anchors.captureAnchorSnapshot();
      recordDutyScrollDebugEvent(
        debugFeedId,
        'scroll-to-item',
        `id=${id}; behavior=${behavior}; top=${scroller.scrollTop.toFixed(1)}`,
      );
      scheduleTrackedItemCenter('next-frame');
      return target;
    },
    [
      anchors,
      centerTrackedItem,
      debugFeedId,
      follow,
      refs,
      scheduleTrackedItemCenter,
      stopDirectItemTracking,
      tracking,
    ],
  );

  useEffect(() => {
    if (!enabled) return;
    const scroller = refs.scrollerRef.current;
    if (!scroller) return;
    const stopTrackingForUserInteraction = () => {
      stopDirectItemTracking();
      stopPendingAnchorRestore();
    };
    scroller.addEventListener('wheel', stopTrackingForUserInteraction, { passive: true });
    scroller.addEventListener('touchstart', stopTrackingForUserInteraction, { passive: true });
    scroller.addEventListener('pointerdown', stopTrackingForUserInteraction);
    scroller.addEventListener('keydown', stopTrackingForUserInteraction);
    return () => {
      scroller.removeEventListener('wheel', stopTrackingForUserInteraction);
      scroller.removeEventListener('touchstart', stopTrackingForUserInteraction);
      scroller.removeEventListener('pointerdown', stopTrackingForUserInteraction);
      scroller.removeEventListener('keydown', stopTrackingForUserInteraction);
    };
  }, [enabled, refs, stopDirectItemTracking, stopPendingAnchorRestore]);

  const clearReportedScrollTrackingStateRef = useRef(tracking.clearReportedScrollTrackingState);
  clearReportedScrollTrackingStateRef.current = tracking.clearReportedScrollTrackingState;

  useLayoutEffect(() => {
    const resetChanged = refs.previousResetKeyRef.current !== resetKey;
    if (resetChanged) {
      stopPendingAnchorRestore();
      recordDutyScrollDebugEvent(
        debugFeedId,
        'feed:reset',
        `${String(refs.previousResetKeyRef.current)}→${String(resetKey)}`,
      );
      refs.previousResetKeyRef.current = resetKey;
      refs.hasInitialScrolledRef.current = false;
      refs.hasSeenNotAtBottomRef.current = false;
      refs.anchorSnapshotRef.current = null;
      refs.preserveBottomAnchorRef.current = false;
      follow.stopBottomSettle();
      // A wait/ease armed for the previous feed would land on the reset result and
      // fight its initial positioning.
      follow.clearFollowScroll();
      stopDirectItemTracking();
    }

    const currentItemIds = refs.itemIdsRef.current;
    const topStatusChanged = refs.previousTopStatusRef.current !== topStatus;
    if (!enabled) {
      stopPendingAnchorRestore();
      follow.stopBottomSettle();
      follow.clearFollowScroll();
      return;
    }
    refs.previousTopStatusRef.current = topStatus;
    if (currentItemIds.length === 0) {
      stopPendingAnchorRestore();
      refs.hasInitialScrolledRef.current = false;
      refs.hasSeenNotAtBottomRef.current = false;
      refs.previousItemIdsRef.current = currentItemIds;
      refs.preserveBottomAnchorRef.current = false;
      follow.stopBottomSettle();
      follow.clearFollowScroll();
      stopDirectItemTracking();
      return;
    }

    if (!refs.hasInitialScrolledRef.current) {
      stopPendingAnchorRestore();
      refs.previousItemIdsRef.current = currentItemIds;
      if (!initialPositioningReady) {
        anchors.captureAnchorSnapshot();
        return;
      }
      refs.hasInitialScrolledRef.current = true;
      follow.scrollToBottom('auto', ScrollNavigationIntent.Initial, {
        enableFollow: refs.autoScrollAllowedRef.current,
      });
      if (refs.autoScrollAllowedRef.current) {
        follow.startBottomSettle();
      }
      anchors.captureAnchorSnapshot();
      return;
    }

    const itemsChanged = !areNumberArraysEqual(refs.previousItemIdsRef.current, currentItemIds);
    if (itemsChanged || topStatusChanged) {
      stopPendingAnchorRestore();
      if (directItemTargetIdRef.current !== null) {
        centerTrackedItem('items-changed');
      } else if (
        refs.liveBottomFollowRef.current &&
        refs.physicallyAtBottomRef.current === true &&
        refs.isWatchModeRef.current !== false
      ) {
        recordDutyScrollDebugEvent(
          debugFeedId,
          'items:follow-bottom',
          `${refs.previousItemIdsRef.current.length}→${currentItemIds.length}; watch=${refs.isWatchModeRef.current}`,
        );
        // Window start-trim would yank the viewport if scrollTop stayed put; restore first so
        // only the newly appended height stays below the fold for the deferred follow scroll.
        anchors.restoreAnchorPosition();
        follow.scheduleFollowScrollWhenStable(
          'items changed while following',
          ScrollNavigationIntent.AutomaticFollow,
        );
        refs.previousItemIdsRef.current = currentItemIds;
        anchors.captureAnchorSnapshot();
        return;
      } else if (
        !refs.preserveBottomAnchorRef.current &&
        refs.physicallyAtBottomRef.current === true &&
        refs.isWatchModeRef.current === false &&
        refs.autoScrollAllowedRef.current
      ) {
        // Watch off / disableAutoScroll: still append at the live edge so catch-up can
        // continue, but ease like Elm instead of instant pin + settle (teleport).
        recordDutyScrollDebugEvent(
          debugFeedId,
          'items:stick-bottom',
          `${refs.previousItemIdsRef.current.length}→${currentItemIds.length}; watch=false`,
        );
        anchors.restoreAnchorPosition();
        follow.scheduleFollowScrollWhenStable(
          'items changed while catching up at bottom',
          ScrollNavigationIntent.AutomaticFollow,
          { enableFollow: false },
        );
        refs.previousItemIdsRef.current = currentItemIds;
        anchors.captureAnchorSnapshot();
        return;
      }
      recordDutyScrollDebugEvent(
        debugFeedId,
        'items:preserve-anchor',
        `${refs.previousItemIdsRef.current[0] ?? '—'}→${refs.previousItemIdsRef.current.at(-1) ?? '—'} becomes ${currentItemIds[0] ?? '—'}→${currentItemIds.at(-1) ?? '—'}; follow=${refs.liveBottomFollowRef.current}; physical=${refs.physicallyAtBottomRef.current}; watch=${refs.isWatchModeRef.current}`,
      );
      const previousIds = refs.previousItemIdsRef.current;
      const isPureAppend =
        currentItemIds.length >= previousIds.length &&
        previousIds.every((id, index) => currentItemIds[index] === id);
      // A pure append does not move any existing row; restoring a stale measured
      // anchor here can itself create the prohibited watch-off navigation.
      const restoreOutcome =
        !itemsChanged || !isPureAppend
          ? anchors.restoreAnchorPosition({ settleSynchronousLayout: true })
          : 'restored';
      if (itemsChanged) refs.preserveBottomAnchorRef.current = false;
      refs.previousItemIdsRef.current = currentItemIds;
      if (restoreOutcome === 'pending') {
        recordDutyScrollDebugEvent(debugFeedId, 'items:anchor-retry-pending');
        schedulePendingAnchorRestore();
        return;
      }
      anchors.captureAnchorSnapshot();
      // Re-check near-bottom so catch-up can arm another newer load.
      tracking.updateScrollState({ allowLoadOlder: false, allowTopReached: false });
      return;
    }

    if (!enabledBeforeRender && enabled) {
      recordDutyScrollDebugEvent(debugFeedId, 'tracking:enable');
      tracking.updateScrollState({
        allowLoadOlder: false,
        allowLoadNewer: false,
        allowTopReached: false,
      });
      anchors.captureAnchorSnapshot();
    }
  }, [
    anchors,
    centerTrackedItem,
    debugFeedId,
    enabled,
    enabledBeforeRender,
    follow,
    refs,
    resetKey,
    schedulePendingAnchorRestore,
    stopDirectItemTracking,
    stopPendingAnchorRestore,
    topStatus,
    tracking,
    itemIds,
    initialPositioningReady,
  ]);

  useLayoutEffect(() => {
    if (!enabled || itemIds.length === 0 || typeof ResizeObserver === 'undefined') return;
    const list = refs.listRef.current;
    if (!list) return;

    const observer = new ResizeObserver(() => {
      if (!refs.enabledRef.current || refs.bottomSettleActiveRef.current) return;
      if (directItemTargetIdRef.current !== null) {
        centerTrackedItem('resize');
        return;
      }
      // Newer appends reflow cards for a while; restoring on every resize freezes scroll.
      if (refs.loadingNewerRef.current) return;
      const now = nowMs();
      // Instant snaps cancel in-flight smooth follow; wait for the trailing pin instead.
      if (now < refs.smoothFollowUntilMsRef.current) {
        recordDutyScrollDebugEvent(debugFeedId, 'resize:follow-bottom-deferred');
        return;
      }
      if (
        refs.liveBottomFollowRef.current &&
        refs.physicallyAtBottomRef.current === true &&
        refs.isWatchModeRef.current !== false &&
        refs.autoScrollAllowedRef.current
      ) {
        recordDutyScrollDebugEvent(debugFeedId, 'resize:follow-bottom');
        follow.scrollToBottom('auto', ScrollNavigationIntent.AutomaticFollow);
        return;
      }
      recordDutyScrollDebugEvent(debugFeedId, 'resize:preserve-anchor');
      const restoreOutcome = anchors.restoreAnchorPosition();
      if (restoreOutcome === 'pending') {
        recordDutyScrollDebugEvent(debugFeedId, 'resize:anchor-retry-pending');
        schedulePendingAnchorRestore();
        return;
      }
      stopPendingAnchorRestore();
      tracking.updateScrollState({
        allowLoadOlder: false,
        allowLoadNewer: false,
        allowTopReached: false,
      });
      anchors.captureAnchorSnapshot();
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [
    anchors,
    centerTrackedItem,
    debugFeedId,
    enabled,
    follow,
    itemIds.length,
    refs,
    resetKey,
    schedulePendingAnchorRestore,
    stopPendingAnchorRestore,
    tracking,
  ]);

  useEffect(() => {
    return () => {
      // Ref-stable: must not re-bind on helper identity changes or mid-life clears fire while mounted.
      clearReportedScrollTrackingStateRef.current('unmount');
    };
  }, []);

  const handleScroll = useCallback<UIEventHandler<HTMLDivElement>>(() => {
    if (!refs.enabledRef.current) return;
    if (refs.isRestoringAnchorRef.current) return;
    if (pendingAnchorRestoreRafRef.current !== null) return;
    if (!initialPositioningReady && !refs.hasInitialScrolledRef.current) {
      refs.hasInitialScrolledRef.current = true;
    }
    if (directItemTargetIdRef.current !== null) {
      scheduleTrackedItemCenter('scroll');
    }
    const scroller = refs.scrollerRef.current;
    if (refs.followAnimatingRef.current) {
      if (!scroller) return;
      // Programmatic ease only increases scrollTop; an upward delta is user input.
      if (scroller.scrollTop >= refs.previousScrollTopRef.current - 1) {
        refs.previousScrollTopRef.current = scroller.scrollTop;
        return;
      }
      follow.clearFollowScroll();
      recordDutyScrollDebugEvent(
        debugFeedId,
        'follow:ease-cancel',
        `upward scroll to ${scroller.scrollTop.toFixed(1)}`,
      );
    }
    if (scroller && scroller.scrollTop < refs.previousScrollTopRef.current - 1) {
      refs.previousScrollTopRef.current = scroller.scrollTop;
      const leftPhysicalBottom = distanceToBottom(scroller) > 1;
      // Ignore tiny settle jitter while still on the live edge; a real scroll-away cancels follow.
      if (refs.bottomSettleActiveRef.current && !leftPhysicalBottom) {
        // no-op
      } else {
        follow.stopBottomSettle();
        // Watch-off catch-up waits with enableFollow=false; follow-mode alone cannot cancel them.
        // Drop the deferred ease as soon as the user scrolls away from the tail.
        if (leftPhysicalBottom && refs.followScrollWaitRef.current !== null) {
          follow.clearFollowScroll();
          recordDutyScrollDebugEvent(
            debugFeedId,
            'follow:wait-cancel',
            `upward scroll to ${scroller.scrollTop.toFixed(1)}`,
          );
        }
        if (refs.liveBottomFollowRef.current) {
          refs.liveBottomFollowRef.current = false;
          recordDutyScrollDebugEvent(
            debugFeedId,
            'follow:disable',
            `immediate upward scroll to ${scroller.scrollTop.toFixed(1)}`,
          );
          refs.callbacksRef.current.onLeftBottom?.();
        }
        if (leftPhysicalBottom && refs.physicallyAtBottomRef.current !== false) {
          refs.physicallyAtBottomRef.current = false;
          refs.callbacksRef.current.onPhysicalBottomChange?.(false);
        }
      }
    } else if (scroller && distanceToBottom(scroller) <= 0.5) {
      refs.liveBottomFollowRef.current = true;
    }
    if (scroller && refs.bottomSettleActiveRef.current) {
      const bottomDistance = distanceToBottom(scroller);
      const physicallyAtBottom = bottomDistance <= 1;
      if (!physicallyAtBottom) {
        follow.stopBottomSettle();
      }
    }

    // Sync-capture so an in-flight newer commit before the next frame can restore.
    // Full offsets near load edges, or while newer is in flight (mid-list may still trim).
    // Otherwise visible-only to avoid measuring the whole 40-item window on every scroll.
    const latest = refs.scrollerRef.current;
    if (latest) {
      const bottomDistance = distanceToBottom(latest);
      const nearLoadEdge =
        latest.scrollTop <= topLoadBufferPx * 2 || bottomDistance <= bottomLoadBufferPx * 2;
      if (nearLoadEdge || refs.loadingNewerRef.current) anchors.captureAnchorSnapshot();
      else anchors.captureVisibleAnchorSnapshot();
    }
    if (refs.handleScrollRafRef.current !== null) return;
    refs.handleScrollRafRef.current = requestAnimationFrame(() => {
      tracking.updateScrollState({ allowPendingFlush: true });
      refs.handleScrollRafRef.current = null;
    });
  }, [
    anchors,
    bottomLoadBufferPx,
    debugFeedId,
    follow,
    initialPositioningReady,
    refs,
    scheduleTrackedItemCenter,
    topLoadBufferPx,
    tracking,
  ]);

  const setItemRef = useCallback(
    (id: number) => {
      let cb = refCacheRef.current.get(id);
      if (!cb) {
        cb = (node: HTMLDivElement | null) => {
          if (node) {
            refs.itemRefsRef.current.set(id, node);
          } else {
            refs.itemRefsRef.current.delete(id);
          }
        };
        refCacheRef.current.set(id, cb);
      }
      return cb;
    },
    [refs],
  );

  const scrollToBottom = useCallback<WindowedFeedScrollHandle['scrollToBottom']>(
    (behavior, intent, navigation) => {
      stopDirectItemTracking();
      if (intent === ScrollNavigationIntent.Explicit) refs.hasInitialScrolledRef.current = true;
      follow.scrollToBottom(behavior, intent, undefined, navigation);
    },
    [follow, refs, stopDirectItemTracking],
  );

  return {
    scrollerRef: refs.scrollerRef,
    listRef: refs.listRef,
    handleScroll,
    setItemRef,
    scrollToBottom,
    scrollToItem,
  };
}
