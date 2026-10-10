import { useCallback, type MutableRefObject, type UIEventHandler } from 'react';
import {
  distanceToBottom,
  hasViewportSizeChanged,
  isAtPhysicalBottom,
} from './windowed-feed-scroll-shared';
import { useFeedScrollDiagnostics } from './message-feed-diagnostics';
import type { FeedScrollHelpers } from './message-feed-internals';

export function useMessageFeedScrollEvents({
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
}: Pick<FeedScrollHelpers, 'refs' | 'anchors' | 'follow' | 'tracking'> & {
  pendingAnchorRestoreRafRef: MutableRefObject<number | null>;
  initialPositioningReady: boolean;
  directItemTargetIdRef: MutableRefObject<number | null>;
  scheduleTrackedItemCenter: (reason: string) => void;
  debugFeedId?: string;
  topLoadBufferPx: number;
  bottomLoadBufferPx: number;
  immediateBelowLoad: boolean;
  reconcileBottomSpacer: () => void;
}) {
  const { event: recordScrollDebugEvent } = useFeedScrollDiagnostics(refs);
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
    reconcileBottomSpacer();
    const snapshot = refs.anchorSnapshotRef.current;
    if (refs.restoredScrollTopRef.current !== null) {
      const restoredScrollTop = refs.restoredScrollTopRef.current;
      refs.restoredScrollTopRef.current = null;
      if (scroller?.scrollTop === restoredScrollTop) return;
    }
    if (scroller && hasViewportSizeChanged(scroller, snapshot)) {
      // A resize-generated scroll event must not replace the pre-resize anchor.
      return;
    }
    if (refs.followAnimatingRef.current) {
      if (!scroller) return;
      // Programmatic ease only increases scrollTop; an upward delta is user input.
      if (scroller.scrollTop >= refs.previousScrollTopRef.current - 1) {
        refs.previousScrollTopRef.current = scroller.scrollTop;
        return;
      }
      follow.clearFollowScroll();
      recordScrollDebugEvent(
        debugFeedId,
        'follow:ease-cancel',
        `upward scroll to ${scroller.scrollTop.toFixed(1)}`,
      );
    }
    if (scroller && scroller.scrollTop < refs.previousScrollTopRef.current - 1) {
      refs.previousScrollTopRef.current = scroller.scrollTop;
      const leftPhysicalBottom = !isAtPhysicalBottom(scroller);
      // Ignore tiny settle jitter while still on the live edge; a real scroll-away cancels follow.
      if (refs.bottomSettleActiveRef.current && !leftPhysicalBottom) {
        // no-op
      } else {
        follow.stopBottomSettle();
        // Watch-off catch-up waits with enableFollow=false; follow-mode alone cannot cancel them.
        // Drop the deferred ease as soon as the user scrolls away from the tail.
        if (leftPhysicalBottom && refs.followScrollWaitRef.current !== null) {
          follow.clearFollowScroll();
          recordScrollDebugEvent(
            debugFeedId,
            'follow:wait-cancel',
            `upward scroll to ${scroller.scrollTop.toFixed(1)}`,
          );
        }
        if (refs.liveBottomFollowRef.current) {
          refs.liveBottomFollowRef.current = false;
          recordScrollDebugEvent(
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
      const physicallyAtBottom = isAtPhysicalBottom(scroller);
      if (!physicallyAtBottom) {
        follow.stopBottomSettle();
      }
    }

    // Sync-capture so an in-flight newer commit before the next frame can restore.
    if (immediateBelowLoad) tracking.updateScrollState({ allowPendingFlush: true });
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
    immediateBelowLoad,
    reconcileBottomSpacer,
  ]);

  return handleScroll;
}
