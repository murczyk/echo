import { useLayoutEffect, useRef } from 'react';
import { areNumberArraysEqual, hasViewportSizeChanged, nowMs } from '../internal/scroll-math';
import type { FeedLayoutOptions } from '../internal/internal.types';
import { useFeedScrollDiagnostics } from '../internal/diagnostics';
import { ScrollNavigationIntent } from '../message-feed.types';

export function useMessageFeedLayout(options: FeedLayoutOptions) {
  const {
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
    deferResizeWhileLoadingBelow,
    reconcileBottomSpacer,
  } = options;
  const { event: recordScrollDebugEvent } = useFeedScrollDiagnostics(refs);
  const { positionResetKey, preservePositionOnReset } = options;
  const previousPositionKeyRef = useRef(positionResetKey);
  useLayoutEffect(() => {
    const positionChanged = previousPositionKeyRef.current !== positionResetKey;
    previousPositionKeyRef.current = positionResetKey;
    if (positionChanged && !preservePositionOnReset) {
      viewport.release();
      refs.hasInitialScrolledRef.current = false;
      anchors.setAnchorSnapshot(null);
      stopDirectItemTracking();
      stopPendingAnchorRestore();
      follow.clearFollowScroll();
    }
    const resetChanged = refs.previousResetKeyRef.current !== resetKey;
    if (resetChanged) {
      stopPendingAnchorRestore();
      recordScrollDebugEvent(
        debugFeedId,
        'feed:reset',
        `${String(refs.previousResetKeyRef.current)}→${String(resetKey)}`,
      );
      refs.previousResetKeyRef.current = resetKey;
      refs.hasInitialScrolledRef.current = false;
      refs.hasSeenNotAtBottomRef.current = false;
      anchors.setAnchorSnapshot(null);
      refs.preserveBottomAnchorRef.current = false;
      follow.stopBottomSettle();
      // A wait/ease armed for the previous feed would land on the reset result and
      // fight its initial positioning.
      follow.clearFollowScroll();
      stopDirectItemTracking();
      releasedFocusRef.current = null;
      setBottomSpacerPx(0);
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

    if (viewport.restore()) {
      refs.hasInitialScrolledRef.current = true;
      refs.previousItemIdsRef.current = currentItemIds;
      return;
    }
    if (
      focus?.active &&
      releasedFocusRef.current !== focus.messageId &&
      refs.itemRefsRef.current.has(focus.messageId)
    ) {
      refs.hasInitialScrolledRef.current = true;
      follow.stopBottomSettle();
      follow.clearFollowScroll();
      refs.liveBottomFollowRef.current = false;
      directItemTargetIdRef.current = focus.messageId;
      centerTrackedItem('focused-context');
    } else if (focus && !focus.active && directItemTargetIdRef.current === focus.messageId) {
      stopDirectItemTracking();
      anchors.captureAnchorSnapshot(true);
    }

    if (!refs.hasInitialScrolledRef.current) {
      stopPendingAnchorRestore();
      refs.previousItemIdsRef.current = currentItemIds;
      if (!initialPositioningReady) {
        anchors.captureAnchorSnapshot();
        return;
      }
      const savedAnchorSnapshot = initialAnchorSnapshotRef.current;
      initialAnchorSnapshotRef.current = null;
      if (savedAnchorSnapshot) {
        refs.hasInitialScrolledRef.current = true;
        refs.liveBottomFollowRef.current = false;
        anchors.setAnchorSnapshot(savedAnchorSnapshot);
        const restoreOutcome = anchors.restoreAnchorPosition({
          settleSynchronousLayout: true,
          settleUpperClamp: true,
        });
        if (restoreOutcome === 'pending') schedulePendingAnchorRestore();
        tracking.updateScrollState({
          allowLoadOlder: false,
          allowLoadNewer: false,
          allowTopReached: false,
        });
        anchors.captureAnchorSnapshot(true);
        return;
      }
      refs.hasInitialScrolledRef.current = true;
      if (initialPosition === 'start') {
        const scroller = refs.scrollerRef.current;
        if (scroller) scroller.scrollTop = 0;
        refs.liveBottomFollowRef.current = false;
        anchors.captureAnchorSnapshot(true);
        tracking.updateScrollState({
          allowLoadOlder: false,
          allowLoadNewer: false,
          allowTopReached: false,
        });
        return;
      }
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
        recordScrollDebugEvent(
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
        recordScrollDebugEvent(
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
      recordScrollDebugEvent(
        debugFeedId,
        'items:preserve-anchor',
        `${refs.previousItemIdsRef.current[0] ?? '—'}→${refs.previousItemIdsRef.current.at(-1) ?? '—'} becomes ${currentItemIds[0] ?? '—'}→${currentItemIds.at(-1) ?? '—'}; follow=${refs.liveBottomFollowRef.current}; physical=${refs.physicallyAtBottomRef.current}; watch=${refs.isWatchModeRef.current}`,
      );
      const previousIds = refs.previousItemIdsRef.current;
      const isPureAppend =
        currentItemIds.length >= previousIds.length &&
        previousIds.every((id, index) => currentItemIds[index] === id);
      const isPurePrepend =
        currentItemIds.length > previousIds.length &&
        previousIds.every(
          (id, index) => currentItemIds[currentItemIds.length - previousIds.length + index] === id,
        );
      // A pure append does not move any existing row; restoring a stale measured
      // anchor here can itself create the prohibited watch-off navigation.
      const restoreOutcome =
        !itemsChanged || !isPureAppend
          ? anchors.restoreAnchorPosition({ settleSynchronousLayout: true })
          : 'restored';
      if (itemsChanged) refs.preserveBottomAnchorRef.current = false;
      refs.previousItemIdsRef.current = currentItemIds;
      if (restoreOutcome === 'pending') {
        recordScrollDebugEvent(debugFeedId, 'items:anchor-retry-pending');
        schedulePendingAnchorRestore();
        return;
      }
      // New rows can grow after commit; retain the original reading anchor until resize settles.
      if (!isPurePrepend) anchors.captureAnchorSnapshot();
      // Re-check near-bottom so catch-up can arm another newer load.
      tracking.updateScrollState({ allowLoadOlder: false, allowTopReached: false });
      return;
    }

    if (!enabledBeforeRender && enabled) {
      recordScrollDebugEvent(debugFeedId, 'tracking:enable');
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
    initialPosition,
    focus?.messageId,
    focus?.active,
    bottomSpacerPx,
    viewport,
    viewportPreservationKey,
    positionResetKey,
    preservePositionOnReset,
  ]);

  useLayoutEffect(() => {
    if (!enabled || itemIds.length === 0 || typeof ResizeObserver === 'undefined') return;
    const list = refs.listRef.current;
    if (!list) return;

    const observer = new ResizeObserver(() => {
      if (!refs.enabledRef.current || refs.bottomSettleActiveRef.current) return;
      if (viewport.restore()) return;
      if (directItemTargetIdRef.current !== null) {
        centerTrackedItem('resize');
        return;
      }
      // Newer appends reflow cards for a while; restoring on every resize freezes scroll.
      const scroller = refs.scrollerRef.current;
      if (
        refs.loadingNewerRef.current &&
        deferResizeWhileLoadingBelow &&
        (!scroller || !hasViewportSizeChanged(scroller, refs.anchorSnapshotRef.current))
      )
        return;
      const now = nowMs();
      // Instant snaps cancel in-flight smooth follow; wait for the trailing pin instead.
      if (now < refs.smoothFollowUntilMsRef.current) {
        recordScrollDebugEvent(debugFeedId, 'resize:follow-bottom-deferred');
        return;
      }
      if (
        refs.liveBottomFollowRef.current &&
        refs.physicallyAtBottomRef.current === true &&
        refs.isWatchModeRef.current !== false &&
        refs.autoScrollAllowedRef.current
      ) {
        recordScrollDebugEvent(debugFeedId, 'resize:follow-bottom');
        follow.scrollToBottom('auto', ScrollNavigationIntent.AutomaticFollow);
        return;
      }
      recordScrollDebugEvent(debugFeedId, 'resize:preserve-anchor');
      const restoreOutcome = anchors.restoreAnchorPosition();
      if (restoreOutcome === 'pending') {
        recordScrollDebugEvent(debugFeedId, 'resize:anchor-retry-pending');
        schedulePendingAnchorRestore();
        return;
      }
      stopPendingAnchorRestore();
      tracking.updateScrollState({
        allowLoadOlder: false,
        allowLoadNewer: false,
        allowTopReached: false,
      });
      anchors.captureAnchorSnapshot(true);
      reconcileBottomSpacer();
    });
    observer.observe(list);
    const scroller = refs.scrollerRef.current;
    if (scroller) observer.observe(scroller);
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
    viewport,
    deferResizeWhileLoadingBelow,
    reconcileBottomSpacer,
  ]);
}
