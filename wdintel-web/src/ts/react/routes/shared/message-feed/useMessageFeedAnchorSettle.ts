import { useCallback, useEffect, useRef } from 'react';
import { useFeedScrollDiagnostics } from './message-feed-diagnostics';
import type { FeedScrollHelpers } from './message-feed-internals';

const ANCHOR_RESTORE_LAYOUT_STABLE_FRAMES = 3;

export function useMessageFeedAnchorSettle({
  refs,
  anchors,
  tracking,
  debugFeedId,
}: Pick<FeedScrollHelpers, 'refs' | 'anchors' | 'tracking'> & { debugFeedId?: string }) {
  const { event: recordScrollDebugEvent } = useFeedScrollDiagnostics(refs);
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
      anchors.captureAnchorSnapshot(true);
      recordScrollDebugEvent(
        debugFeedId,
        'anchor:settle-complete',
        `height=${active.scrollHeight.toFixed(1)}; frames=${stableFrames}`,
      );
    };

    pendingAnchorRestoreRafRef.current = requestAnimationFrame(tick);
  }, [anchors, debugFeedId, refs, stopPendingAnchorRestore, tracking]);
  useEffect(() => stopPendingAnchorRestore, [stopPendingAnchorRestore]);

  return { pendingAnchorRestoreRafRef, stopPendingAnchorRestore, schedulePendingAnchorRestore };
}
