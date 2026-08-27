import { useRef } from 'react';
import type {
  TopStatus,
  WindowedFeedScrollCallbacks,
  WindowedFeedScrollRefs,
} from './windowed-feed-scroll-shared';

/**
 * All mutable scroll state in one bag so the anchor / follow / tracking hooks can share it.
 * The bag identity must stay stable — layout effects below depend on it.
 */
export function useWindowedFeedScrollRefs(args: {
  resetKey: string | number | null;
  topStatus: TopStatus;
  isWatchMode: boolean;
  loadingNewer: boolean;
  unreadPrefetchNeeded: boolean;
  pendingNewerFlushNeeded: boolean;
  enabled: boolean;
}): WindowedFeedScrollRefs {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const itemRefsRef = useRef(new Map<number, HTMLDivElement>());
  const itemIdsRef = useRef<readonly number[]>([]);
  const anchorSnapshotRef = useRef<WindowedFeedScrollRefs['anchorSnapshotRef']['current']>(null);
  const callbacksRef = useRef<WindowedFeedScrollCallbacks>({ onLoadOlder: () => undefined });
  const loadOlderTriggeredRef = useRef(false);
  const loadNewerTriggeredRef = useRef(false);
  const loadNewerIdleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushPendingIdleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasSeenNotAtBottomRef = useRef(false);
  const atBottomRef = useRef<boolean | null>(null);
  const physicallyAtBottomRef = useRef<boolean | null>(null);
  const previousScrollTopRef = useRef(0);
  const nearBottomRef = useRef<boolean | null>(null);
  const atTopRef = useRef<boolean | null>(null);
  const hasInitialScrolledRef = useRef(false);
  const bottomSettleActiveRef = useRef(false);
  const bottomSettleFramesRemainingRef = useRef(0);
  const bottomSettleRafRef = useRef<number | null>(null);
  const bottomSettleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bottomSettleResizeObserverRef = useRef<ResizeObserver | null>(null);
  const liveBottomFollowRef = useRef(false);
  const smoothFollowUntilMsRef = useRef(0);
  const followScrollRafRef = useRef<number | null>(null);
  const followAnimatingRef = useRef(false);
  const followScrollWaitRef =
    useRef<WindowedFeedScrollRefs['followScrollWaitRef']['current']>(null);
  const scheduleFollowScrollWhenStableRef =
    useRef<WindowedFeedScrollRefs['scheduleFollowScrollWhenStableRef']['current']>(null);
  const isRestoringAnchorRef = useRef(false);
  const previousItemIdsRef = useRef<readonly number[]>([]);
  const previousResetKeyRef = useRef<string | number | null>(args.resetKey);
  const previousTopStatusRef = useRef<TopStatus>(args.topStatus);
  const isWatchModeRef = useRef(args.isWatchMode);
  const loadingNewerRef = useRef(args.loadingNewer);
  const unreadPrefetchNeededRef = useRef(args.unreadPrefetchNeeded);
  const pendingNewerFlushNeededRef = useRef(args.pendingNewerFlushNeeded);
  const enabledRef = useRef(args.enabled);
  const handleScrollRafRef = useRef<number | null>(null);
  const reportVisibleMessageIdsRafRef = useRef<number | null>(null);
  const reportVisibleMessageIdsLastRunRef = useRef(0);
  const reportVisibleMessageIdsLatestArgsRef = useRef(false);

  const bagRef = useRef<WindowedFeedScrollRefs | null>(null);
  if (bagRef.current === null) {
    bagRef.current = {
      scrollerRef,
      listRef,
      itemRefsRef,
      itemIdsRef,
      anchorSnapshotRef,
      callbacksRef,
      loadOlderTriggeredRef,
      loadNewerTriggeredRef,
      loadNewerIdleTimeoutRef,
      flushPendingIdleTimeoutRef,
      hasSeenNotAtBottomRef,
      atBottomRef,
      physicallyAtBottomRef,
      previousScrollTopRef,
      nearBottomRef,
      atTopRef,
      hasInitialScrolledRef,
      bottomSettleActiveRef,
      bottomSettleFramesRemainingRef,
      bottomSettleRafRef,
      bottomSettleTimeoutRef,
      bottomSettleResizeObserverRef,
      liveBottomFollowRef,
      smoothFollowUntilMsRef,
      followScrollRafRef,
      followAnimatingRef,
      followScrollWaitRef,
      scheduleFollowScrollWhenStableRef,
      isRestoringAnchorRef,
      previousItemIdsRef,
      previousResetKeyRef,
      previousTopStatusRef,
      isWatchModeRef,
      loadingNewerRef,
      unreadPrefetchNeededRef,
      pendingNewerFlushNeededRef,
      enabledRef,
      handleScrollRafRef,
      reportVisibleMessageIdsRafRef,
      reportVisibleMessageIdsLastRunRef,
      reportVisibleMessageIdsLatestArgsRef,
    };
  }
  return bagRef.current;
}
