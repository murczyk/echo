import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useFeedScrollDiagnostics } from './internal/diagnostics';
import { useWindowedFeedScrollRefs } from './internal/refs';
import { useWindowedFeedScrollFollow } from './interaction/follow';
import { useMessageFeedInput } from './interaction/input';
import { useMessageFeedScrollEvents } from './interaction/scroll-events';
import { useWindowedFeedScrollTracking } from './interaction/tracking';
import { useWindowedFeedScrollAnchors } from './viewport/anchors';
import { useMessageFeedAnchorSettle } from './viewport/settle';
import { useMessageFeedLayout } from './viewport/layout';
import { useMessageFeedSpacer } from './viewport/spacer';
import { centeredItemScrollTop, getTargetCardElement, isItemFullyVisible } from './viewport/focus';
import { stabilizeMessageAtContainerTop, useMessageFeedViewport } from './viewport/preservation';
import {
  DEFAULT_AT_BOTTOM_THRESHOLD_PX,
  DEFAULT_BOTTOM_LOAD_BUFFER_PX,
  DEFAULT_TOP_LOAD_BUFFER_PX,
  nowMs,
} from './internal/scroll-math';
import type { ScrollStateOpts, TopStatus } from './internal/internal.types';
import {
  ScrollNavigationIntent,
  type UseWindowedFeedScrollOptions,
  type WindowedFeedScrollHandle,
} from './message-feed.types';

export type {
  UseWindowedFeedScrollOptions,
  WindowedFeedScrollHandle,
  WindowedFeedScrollItem,
} from './message-feed.types';

export function useWindowedFeedScroll({
  itemIds,
  diagnostics,
  policy,
  focus,
  navigationTarget,
  viewportPreservationKey,
  onViewportCaptureChange,
  onFirstVisibleMessage,
  onVisibleMessages,
  loadEdgesOnLayout = false,
  edgeLoadRetryKey,
  positionResetKey,
  preservePositionOnReset = false,
  initialAnchorSnapshot = null,
  onAnchorSnapshotChange,
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
  topLoadBufferPx = policy?.aboveLoadBufferPx ?? DEFAULT_TOP_LOAD_BUFFER_PX,
  bottomLoadBufferPx = policy?.belowLoadBufferPx ?? DEFAULT_BOTTOM_LOAD_BUFFER_PX,
  atBottomThresholdPx = policy?.atBottomThresholdPx ?? DEFAULT_AT_BOTTOM_THRESHOLD_PX,
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
  autoScrollAllowed = autoScrollAllowed && (policy?.followAtBottom ?? true);
  const initialPosition = policy?.initialPosition ?? 'end';
  const underfilledEdgeLoading = policy?.underfilledEdgeLoading ?? true;
  const immediateBelowLoad = policy?.belowLoadStrategy === 'immediate';
  const serializeEdgeLoads = policy?.serializeEdgeLoads ?? false;
  const expandBelowLoadBuffer = policy?.expandBelowLoadBuffer ?? true;
  const debugEnabled = diagnostics?.enabled ?? false;
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const releasedFocusRef = useRef<number | null>(null);
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
    loadingOlder,
    hasReachedStart,
    loadingNewer,
    unreadPrefetchNeeded,
    pendingNewerFlushNeeded,
    enabled,
  });
  refs.diagnosticsRef.current = diagnostics;
  const { event: recordScrollDebugEvent } = useFeedScrollDiagnostics(refs);
  const initialAnchorSnapshotRef = useRef(initialAnchorSnapshot);
  const enabledBeforeRender = refs.enabledRef.current;
  refs.isWatchModeRef.current = isWatchMode;
  refs.autoScrollAllowedRef.current = autoScrollAllowed;
  refs.loadingNewerRef.current = loadingNewer;
  refs.loadingOlderRef.current = loadingOlder;
  refs.hasReachedStartRef.current = hasReachedStart;
  refs.unreadPrefetchNeededRef.current = unreadPrefetchNeeded;
  refs.pendingNewerFlushNeededRef.current = pendingNewerFlushNeeded;

  useLayoutEffect(() => {
    refs.itemIdsRef.current = itemIds;
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
      onFirstVisibleMessage,
      onVisibleMessages,
    };
  });

  const refCacheRef = useRef<Map<number, (node: HTMLElement | null) => void>>(new Map());
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
    if (!serializeEdgeLoads && !loadingOlder) refs.loadOlderTriggeredRef.current = false;
  }, [loadingOlder, refs, serializeEdgeLoads]);

  const firstItemId = itemIds[0] ?? null;
  useEffect(() => {
    if (serializeEdgeLoads) refs.loadOlderTriggeredRef.current = false;
  }, [firstItemId, refs, serializeEdgeLoads]);

  const previousEdgeLoadRetryKeyRef = useRef(edgeLoadRetryKey);
  useEffect(() => {
    if (previousEdgeLoadRetryKeyRef.current === edgeLoadRetryKey) return;
    previousEdgeLoadRetryKeyRef.current = edgeLoadRetryKey;
    refs.loadOlderTriggeredRef.current = false;
    refs.loadNewerTriggeredRef.current = false;
  }, [edgeLoadRetryKey, refs]);

  const previousHasReachedStartRef = useRef(hasReachedStart);
  useEffect(() => {
    if (serializeEdgeLoads && previousHasReachedStartRef.current && !hasReachedStart) {
      refs.loadOlderTriggeredRef.current = false;
    }
    previousHasReachedStartRef.current = hasReachedStart;
  }, [hasReachedStart, refs, serializeEdgeLoads]);

  const anchors = useWindowedFeedScrollAnchors({
    refs,
    debugFeedId,
    topLoadBufferPx,
    bottomLoadBufferPx,
    atBottomThresholdPx,
    unreadPrefetchNeeded,
    onAnchorSnapshotChange,
  });
  const viewport = useMessageFeedViewport({
    refs,
    anchors,
    resetKey,
    viewportPreservationKey,
    onViewportCaptureChange,
  });

  useLayoutEffect(() => {
    const scroller = refs.scrollerRef.current;
    if (!debugEnabled || !enabled || !scroller) return;
    anchors.captureAnchorSnapshot();
    anchors.publishDebugMetrics(scroller, refs.previousScrollTopRef.current);
    recordScrollDebugEvent(debugFeedId, 'debug:attach');
  }, [anchors, debugEnabled, debugFeedId, enabled, refs]);

  const updateScrollStateRef = useRef<(opts?: ScrollStateOpts) => void>(() => undefined);
  const updateScrollStateStable = useCallback((opts?: ScrollStateOpts) => {
    updateScrollStateRef.current(opts);
  }, []);

  const capturePositionedAnchorSnapshot = useCallback(
    () => anchors.captureAnchorSnapshot(true),
    [anchors],
  );
  const follow = useWindowedFeedScrollFollow({
    refs,
    debugFeedId,
    captureAnchorSnapshot: capturePositionedAnchorSnapshot,
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
    immediateBelowLoad,
    serializeEdgeLoads,
    expandBelowLoadBuffer,
    captureAnchorSnapshot: anchors.captureAnchorSnapshot,
    publishDebugMetrics: anchors.publishDebugMetrics,
    reportVisibleMessageIds: anchors.reportVisibleMessageIds,
    stopBottomSettle: follow.stopBottomSettle,
    clearFollowScroll: follow.clearFollowScroll,
  });
  updateScrollStateRef.current = tracking.updateScrollState;

  const { pendingAnchorRestoreRafRef, stopPendingAnchorRestore, schedulePendingAnchorRestore } =
    useMessageFeedAnchorSettle({
      refs,
      anchors,
      tracking,
      debugFeedId,
    });

  const directItemTargetIdRef = useRef<number | null>(null);
  const directItemCenterRafRef = useRef<number | null>(null);
  const { bottomSpacerPx, bottomSpacerRef, setBottomSpacerPx, reconcileBottomSpacer } =
    useMessageFeedSpacer({ scrollerRef: refs.scrollerRef, directItemTargetIdRef, itemIds });

  const cancelDirectItemTracking = useCallback(() => {
    const wasActive =
      directItemTargetIdRef.current !== null || directItemCenterRafRef.current !== null;
    directItemTargetIdRef.current = null;
    if (directItemCenterRafRef.current !== null) {
      cancelAnimationFrame(directItemCenterRafRef.current);
      directItemCenterRafRef.current = null;
    }
    if (wasActive) recordScrollDebugEvent(debugFeedId, 'item-tracking:stop');
    return wasActive;
  }, [debugFeedId]);

  const stopDirectItemTracking = useCallback(() => {
    if (cancelDirectItemTracking()) anchors.setAnchorSnapshot(null);
  }, [anchors, cancelDirectItemTracking]);

  useEffect(
    () => () => {
      cancelDirectItemTracking();
    },
    [cancelDirectItemTracking],
  );

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
      const viewportRect = scroller.getBoundingClientRect();
      if (viewportRect.width <= 0 || viewportRect.height <= 0 || scroller.clientHeight <= 0)
        return null;

      const card = focusRef.current?.messageId === id ? getTargetCardElement(target) : target;
      const targetTop = Math.max(0, centeredItemScrollTop(scroller, card));
      const listRect = refs.listRef.current?.getBoundingClientRect();
      const scale = viewportRect.height / scroller.clientHeight;
      const contentHeight = listRect
        ? scroller.scrollTop + (listRect.bottom - viewportRect.top) / scale
        : scroller.scrollHeight - bottomSpacerRef.current;
      const missingSpace =
        targetTop > 0
          ? Math.max(0, Math.ceil(targetTop + scroller.clientHeight - contentHeight))
          : 0;
      setBottomSpacerPx((current) => (current === missingSpace ? current : missingSpace));
      scroller.scrollTop = targetTop;
      refs.restoredScrollTopRef.current = scroller.scrollTop;
      refs.previousScrollTopRef.current = scroller.scrollTop;
      anchors.captureAnchorSnapshot(true);
      recordScrollDebugEvent(
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
        recordScrollDebugEvent(
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
      recordScrollDebugEvent(
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

  const onReaderScrollStart = useCallback(() => {
    viewport.release();
    if (focusRef.current?.active && releasedFocusRef.current !== focusRef.current.messageId) {
      releasedFocusRef.current = focusRef.current.messageId;
      focusRef.current.onRelease?.();
    }
    stopDirectItemTracking();
    stopPendingAnchorRestore();
    anchors.captureAnchorSnapshot(true);
  }, [anchors, stopDirectItemTracking, stopPendingAnchorRestore, viewport]);
  useMessageFeedInput({
    refs,
    anchors,
    follow,
    enabled,
    resetKey,
    debugFeedId,
    underfilledEdgeLoading,
    serializeEdgeLoads,
    onReaderScrollStart,
    hasItems: itemIds.length > 0,
  });

  const clearReportedScrollTrackingStateRef = useRef(tracking.clearReportedScrollTrackingState);
  clearReportedScrollTrackingStateRef.current = tracking.clearReportedScrollTrackingState;

  useMessageFeedLayout({
    refs,
    anchors,
    follow,
    tracking,
    viewport,
    resetKey,
    enabled,
    enabledBeforeRender,
    topStatus,
    itemIds,
    initialPosition,
    initialPositioningReady,
    initialAnchorSnapshotRef,
    directItemTargetIdRef,
    releasedFocusRef,
    bottomSpacerPx,
    setBottomSpacerPx,
    centerTrackedItem,
    stopDirectItemTracking,
    stopPendingAnchorRestore,
    schedulePendingAnchorRestore,
    focus,
    debugFeedId,
    viewportPreservationKey,
    positionResetKey,
    preservePositionOnReset,
    deferResizeWhileLoadingBelow: policy?.deferResizeWhileLoadingBelow ?? true,
    reconcileBottomSpacer,
  });

  useLayoutEffect(() => {
    if (!navigationTarget || !enabled) return;
    const scroller = refs.scrollerRef.current;
    const target = refs.itemRefsRef.current.get(navigationTarget.messageId);
    if (!scroller || !target) return;
    viewport.release();
    stopDirectItemTracking();
    stopPendingAnchorRestore();
    follow.clearFollowScroll();
    return stabilizeMessageAtContainerTop(scroller, target, () => {
      anchors.captureAnchorSnapshot(true);
      navigationTarget.onAligned();
    });
  }, [
    navigationTarget,
    itemIds,
    enabled,
    resetKey,
    anchors,
    refs,
    viewport,
    stopDirectItemTracking,
    stopPendingAnchorRestore,
    follow,
  ]);

  useEffect(() => {
    if (
      loadEdgesOnLayout &&
      enabled &&
      itemIds.length > 0 &&
      (refs.scrollerRef.current?.clientHeight ?? 0) > 0
    )
      tracking.updateScrollState();
  }, [
    loadEdgesOnLayout,
    edgeLoadRetryKey,
    enabled,
    itemIds,
    loadingOlder,
    loadingNewer,
    hasReachedStart,
    tracking,
  ]);

  useEffect(() => {
    return () => {
      // Ref-stable: must not re-bind on helper identity changes or mid-life clears fire while mounted.
      clearReportedScrollTrackingStateRef.current('unmount');
    };
  }, []);

  const handleScroll = useMessageFeedScrollEvents({
    refs,
    anchors,
    follow,
    tracking,
    pendingAnchorRestoreRafRef,
    initialPositioningReady,
    directItemTargetIdRef,
    scheduleTrackedItemCenter,
    debugFeedId,
    topLoadBufferPx,
    bottomLoadBufferPx,
    immediateBelowLoad,
    reconcileBottomSpacer,
  });

  const setItemRef = useCallback(
    (id: number) => {
      let cb = refCacheRef.current.get(id);
      if (!cb) {
        cb = (node: HTMLElement | null) => {
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
      stopPendingAnchorRestore();
      viewport.release();
      if (intent === ScrollNavigationIntent.Explicit) refs.hasInitialScrolledRef.current = true;
      follow.scrollToBottom(behavior, intent, undefined, navigation);
    },
    [follow, refs, stopDirectItemTracking, stopPendingAnchorRestore, viewport],
  );
  const getItemElement = useCallback(
    (id: number) => refs.itemRefsRef.current.get(id) ?? null,
    [refs],
  );

  return {
    bottomSpacerPx,
    getItemElement,
    scrollerRef: refs.scrollerRef,
    listRef: refs.listRef,
    handleScroll,
    setItemRef,
    scrollToBottom,
    scrollToItem,
  };
}
